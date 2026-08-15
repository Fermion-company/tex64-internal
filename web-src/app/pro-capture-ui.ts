import { uiText } from "./i18n.js";
import type { BridgeWindow } from "./types.js";
import { insertAtEditorCursor, type ProEditorLike } from "./pro-editor-insert.js";
import {
  calculateAutoScrollDelta,
  documentRectToViewportRect,
  viewportPointToDocumentPoint,
} from "./pdf-capture-math.js";

export type CaptureRect = { x: number; y: number; width: number; height: number };
type PdfCaptureViewport = {
  left: number; top: number; width: number; height: number;
  scrollLeft: number; scrollTop: number;
};

export const normalizeCaptureRect = (startX: number, startY: number, endX: number, endY: number): CaptureRect => ({
  x: Math.min(startX, endX),
  y: Math.min(startY, endY),
  width: Math.abs(endX - startX),
  height: Math.abs(endY - startY),
});

export const mapSelectionToImagePixels = (
  selection: CaptureRect,
  imageBounds: CaptureRect,
  naturalWidth: number,
  naturalHeight: number
): CaptureRect | null => {
  if (naturalWidth <= 0 || naturalHeight <= 0 || imageBounds.width <= 0 || imageBounds.height <= 0) return null;
  const scale = Math.min(imageBounds.width / naturalWidth, imageBounds.height / naturalHeight);
  const shownWidth = naturalWidth * scale;
  const shownHeight = naturalHeight * scale;
  const shownX = imageBounds.x + (imageBounds.width - shownWidth) / 2;
  const shownY = imageBounds.y + (imageBounds.height - shownHeight) / 2;
  const left = Math.max(selection.x, shownX);
  const top = Math.max(selection.y, shownY);
  const right = Math.min(selection.x + selection.width, shownX + shownWidth);
  const bottom = Math.min(selection.y + selection.height, shownY + shownHeight);
  if (right <= left || bottom <= top) return null;
  return {
    x: Math.round((left - shownX) / scale),
    y: Math.round((top - shownY) / scale),
    width: Math.max(1, Math.round((right - left) / scale)),
    height: Math.max(1, Math.round((bottom - top) / scale)),
  };
};

export const chooseCaptureDirectory = (files: readonly string[]): string => {
  for (const dir of ["figures", "images", "assets"]) {
    if (files.some((file) => file === dir || file.startsWith(`${dir}/`))) return dir;
  }
  return "assets";
};

export const buildIncludeGraphicsSnippet = (path: string, figure: boolean): string => {
  const command = `\\includegraphics[width=0.8\\linewidth]{${path}}`;
  return figure ? `\\begin{figure}[htbp]\n  \\centering\n  ${command}\n\\end{figure}\n` : `${command}\n`;
};

type CaptureDeps = {
  getActiveGroup: () => { editor: unknown | null };
  getWorkspaceFiles: () => string[];
};

const dataUrlBase64 = (url: string) => url.slice(url.indexOf(",") + 1);

const timestampName = (now = new Date()) => {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `capture-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.png`;
};

export const initProCaptureUi = (deps: CaptureDeps) => {
  const bridgeWindow = window as BridgeWindow;
  let cleanup: (() => void) | null = null;

  const insertText = (text: string) => {
    insertAtEditorCursor(deps.getActiveGroup().editor as ProEditorLike | null, text, "pro-capture");
  };

  const capturePdf = (iframe: HTMLIFrameElement, rect: CaptureRect, coordinateSpace: "viewport" | "document" = "viewport"): Promise<string> => new Promise((resolve, reject) => {
    const requestId = `capture-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const timer = window.setTimeout(() => { window.removeEventListener("message", receive); reject(new Error("PDF capture timed out.")); }, coordinateSpace === "document" ? 60000 : 10000);
    const receive = (event: MessageEvent) => {
      if (event.source !== iframe.contentWindow || event.data?.source !== "tex64-pdf") return;
      const payload = event.data.payload;
      if (payload?.type !== "capture-region-result" || payload.requestId !== requestId) return;
      clearTimeout(timer);
      window.removeEventListener("message", receive);
      if (payload.ok && payload.dataUrl) resolve(payload.dataUrl);
      else reject(new Error(payload.error || "The PDF region could not be captured."));
    };
    window.addEventListener("message", receive);
    iframe.contentWindow?.postMessage({ source: "tex64-pdf", payload: { type: "capture-region", requestId, coordinateSpace, payload: rect } }, "*");
  });

  const captureImage = (image: HTMLImageElement, rect: CaptureRect, bodyRect: DOMRect): string => {
    const imageRect = image.getBoundingClientRect();
    const pixels = mapSelectionToImagePixels(rect, {
      x: imageRect.left - bodyRect.left, y: imageRect.top - bodyRect.top,
      width: imageRect.width, height: imageRect.height,
    }, image.naturalWidth, image.naturalHeight);
    if (!pixels) throw new Error("The selection does not overlap the image.");
    const canvas = document.createElement("canvas");
    canvas.width = pixels.width; canvas.height = pixels.height;
    canvas.getContext("2d")?.drawImage(image, pixels.x, pixels.y, pixels.width, pixels.height, 0, 0, pixels.width, pixels.height);
    return canvas.toDataURL("image/png");
  };

  const begin = (kind: "preview" | "reference") => {
    cleanup?.();
    const pane = document.getElementById(`pro-${kind}-pane`);
    const body = pane?.querySelector<HTMLElement>(".pro-pane-body");
    if (!body) return;
    const overlay = document.createElement("div");
    overlay.className = "pro-capture-overlay";
    overlay.tabIndex = 0;
    overlay.innerHTML = `<div class="pro-capture-hint">${uiText("Drag to select · PDF: scrolls automatically at the bottom edge · Esc to cancel", "ドラッグで選択 · PDF は下端で自動スクロール · Esc で中止")}</div>`;
    body.appendChild(overlay);
    overlay.focus();
    let start: { x: number; y: number } | null = null;
    let pointer: { x: number; y: number } | null = null;
    let rect: CaptureRect | null = null;
    let pdfRect: CaptureRect | null = null;
    let pdfViewport: PdfCaptureViewport | null = null;
    let pdfIframe: HTMLIFrameElement | null = null;
    let pdfStartIsDocument = false;
    let autoScrollFrame = 0;
    let box: HTMLDivElement | null = null;
    const viewer = document.getElementById(`pro-${kind}-viewer`);
    if (viewer?.dataset.view === "pdf") {
      pdfIframe = document.getElementById(`pro-${kind}-pdf`) as HTMLIFrameElement;
      pdfIframe.contentWindow?.postMessage({ source: "tex64-pdf", payload: { type: "capture-scroll-state" } }, "*");
    }
    const close = () => {
      cancelAnimationFrame(autoScrollFrame);
      overlay.remove(); document.removeEventListener("keydown", onKey); window.removeEventListener("message", onPdfMessage);
      if (cleanup === close) cleanup = null;
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    const drawPdfSelection = () => {
      if (!box || !pdfRect || !pdfViewport || !pdfIframe) return;
      const iframeBounds = pdfIframe.getBoundingClientRect();
      const overlayBounds = overlay.getBoundingClientRect();
      const shown = documentRectToViewportRect(pdfRect, pdfViewport);
      Object.assign(box.style, {
        left: `${iframeBounds.left - overlayBounds.left + shown.x}px`,
        top: `${iframeBounds.top - overlayBounds.top + shown.y}px`,
        width: `${shown.width}px`, height: `${shown.height}px`,
      });
    };
    const onPdfMessage = (event: MessageEvent) => {
      if (!pdfIframe || event.source !== pdfIframe.contentWindow || event.data?.source !== "tex64-pdf") return;
      const payload = event.data.payload;
      if (payload?.type !== "capture-scroll-state-result") return;
      pdfViewport = payload.viewport as PdfCaptureViewport;
      if (start && pointer) {
        const iframeBounds = pdfIframe.getBoundingClientRect();
        if (!pdfStartIsDocument) {
          start = viewportPointToDocumentPoint(start, pdfViewport);
          pdfStartIsDocument = true;
        }
        const docPoint = viewportPointToDocumentPoint({ x: pointer.x - iframeBounds.left, y: pointer.y - iframeBounds.top }, pdfViewport);
        pdfRect = normalizeCaptureRect(start.x, start.y, docPoint.x, docPoint.y);
        rect = pdfRect;
      }
      drawPdfSelection();
    };
    window.addEventListener("message", onPdfMessage);
    document.addEventListener("keydown", onKey);
    cleanup = close;
    overlay.addEventListener("pointerdown", (event) => {
      if ((event.target as Element).closest(".pro-capture-menu, .pro-capture-confirm")) return;
      const bounds = overlay.getBoundingClientRect();
      pointer = { x: event.clientX, y: event.clientY };
      if (pdfIframe && pdfViewport) {
        const iframeBounds = pdfIframe.getBoundingClientRect();
        start = viewportPointToDocumentPoint({ x: event.clientX - iframeBounds.left, y: event.clientY - iframeBounds.top }, pdfViewport);
        pdfStartIsDocument = true;
      } else if (pdfIframe) {
        const iframeBounds = pdfIframe.getBoundingClientRect();
        start = { x: event.clientX - iframeBounds.left, y: event.clientY - iframeBounds.top };
        pdfStartIsDocument = false;
        pdfIframe.contentWindow?.postMessage({ source: "tex64-pdf", payload: { type: "capture-scroll-state" } }, "*");
      } else {
        start = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
      }
      box?.remove();
      box = document.createElement("div"); box.className = "pro-capture-selection"; overlay.appendChild(box);
      overlay.setPointerCapture(event.pointerId);
      if (pdfIframe) {
        const tick = () => {
          if (!start || !pointer || !pdfIframe || !pdfViewport) return;
          const iframeBounds = pdfIframe.getBoundingClientRect();
          const localY = pointer.y - iframeBounds.top;
          const delta = calculateAutoScrollDelta(localY, pdfViewport.top, pdfViewport.height);
          if (delta) pdfIframe.contentWindow?.postMessage({ source: "tex64-pdf", payload: { type: "capture-scroll-by", deltaY: delta } }, "*");
          autoScrollFrame = requestAnimationFrame(tick);
        };
        autoScrollFrame = requestAnimationFrame(tick);
      }
    });
    overlay.addEventListener("pointermove", (event) => {
      if (!start || !box) return;
      pointer = { x: event.clientX, y: event.clientY };
      if (pdfIframe && pdfViewport && pdfStartIsDocument) {
        const iframeBounds = pdfIframe.getBoundingClientRect();
        const docPoint = viewportPointToDocumentPoint({ x: event.clientX - iframeBounds.left, y: event.clientY - iframeBounds.top }, pdfViewport);
        pdfRect = normalizeCaptureRect(start.x, start.y, docPoint.x, docPoint.y);
        rect = pdfRect;
        drawPdfSelection();
        return;
      }
      const bounds = overlay.getBoundingClientRect();
      rect = normalizeCaptureRect(start.x, start.y, event.clientX - bounds.left, event.clientY - bounds.top);
      Object.assign(box.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    });
    overlay.addEventListener("pointerup", (event) => {
      if (!start || !rect || rect.width < 4 || rect.height < 4) {
        start = null; pointer = null; cancelAnimationFrame(autoScrollFrame);
        if (overlay.hasPointerCapture(event.pointerId)) overlay.releasePointerCapture(event.pointerId);
        return;
      }
      start = null; pointer = null; cancelAnimationFrame(autoScrollFrame); overlay.releasePointerCapture(event.pointerId);
      const menu = document.createElement("div");
      menu.className = "pro-capture-menu";
      menu.innerHTML = `<button data-action="tex">${uiText("To TeX", "TeX化")}</button><span class="pro-capture-translate"><select aria-label="Translation language"><option>Japanese</option><option>English</option><option value="custom">Other…</option></select><input hidden placeholder="Language" /></span><button data-action="translate">${uiText("Translate and insert", "翻訳して挿入")}</button><label><input type="checkbox" data-figure /> figure</label><button data-action="image">${uiText("Insert as an image", "画像化して挿入")}</button><button data-action="stash">${uiText("Send to stash", "スタッシュへ")}</button><button data-action="copy">${uiText("Copy (PNG)", "コピー(PNG)")}</button><span class="pro-capture-status"></span>`;
      const boxLeft = Number.parseFloat(box?.style.left || String(rect.x));
      const boxTop = Number.parseFloat(box?.style.top || String(rect.y));
      Object.assign(menu.style, { left: `${Math.max(4, Math.min(boxLeft, overlay.clientWidth - 300))}px`, top: `${Math.max(4, Math.min(boxTop + Math.min(rect.height, overlay.clientHeight) + 6, overlay.clientHeight - 120))}px` });
      overlay.querySelector(".pro-capture-menu")?.remove(); overlay.appendChild(menu);
      const select = menu.querySelector("select") as HTMLSelectElement;
      const custom = menu.querySelector("input[placeholder=Language]") as HTMLInputElement;
      select.addEventListener("change", () => { custom.hidden = select.value !== "custom"; if (!custom.hidden) custom.focus(); });
      const status = menu.querySelector<HTMLElement>(".pro-capture-status")!;
      const getPng = async () => {
        const bodyRect = body.getBoundingClientRect();
        if (viewer?.dataset.view === "image") return captureImage(document.getElementById(`pro-${kind}-image`) as HTMLImageElement, rect!, bodyRect);
        if (viewer?.dataset.view === "pdf") {
          const iframe = document.getElementById(`pro-${kind}-pdf`) as HTMLIFrameElement;
          const iframeRect = iframe.getBoundingClientRect();
          if (pdfRect) return capturePdf(iframe, pdfRect, "document");
          return capturePdf(iframe, { x: rect!.x - (iframeRect.left - bodyRect.left), y: rect!.y - (iframeRect.top - bodyRect.top), width: rect!.width, height: rect!.height });
        }
        throw new Error("Open an image or PDF before selecting a region.");
      };
      const showTex = (tex: string) => {
        menu.remove();
        const confirm = document.createElement("div"); confirm.className = "pro-capture-confirm";
        const textarea = document.createElement("textarea"); textarea.value = tex; textarea.rows = 7;
        const insert = document.createElement("button"); insert.textContent = uiText("Insert at the cursor", "カーソル位置に挿入");
        insert.addEventListener("click", () => { try { insertText(textarea.value); close(); } catch (error) { confirm.dataset.error = error instanceof Error ? error.message : String(error); } });
        const stash = document.createElement("button"); stash.textContent = uiText("Send to stash", "スタッシュへ");
        stash.addEventListener("click", () => { window.dispatchEvent(new CustomEvent("tex64:pro-stash-add", { detail: { kind: "text", content: textarea.value } })); close(); });
        confirm.append(textarea, insert, stash); overlay.appendChild(confirm);
        Object.assign(confirm.style, { left: menu.style.left, top: menu.style.top });
      };
      menu.addEventListener("click", async (click) => {
        const action = (click.target as HTMLElement).closest<HTMLButtonElement>("button")?.dataset.action;
        if (!action) return;
        try {
          status.classList.add("is-loading"); status.textContent = uiText("Working…", "処理中…");
          const png = await getPng();
          if (action === "copy") {
            const blob = await (await fetch(png)).blob(); await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]); status.textContent = uiText("Copied", "コピーしました"); return;
          }
          if (action === "stash") {
            window.dispatchEvent(new CustomEvent("tex64:pro-stash-add", { detail: { kind: "image", content: png } }));
            close(); return;
          }
          if (action === "image") {
            const api = bridgeWindow.tex64Files?.writeBase64;
            if (!api) throw new Error("File writing is not available.");
            const dir = chooseCaptureDirectory(deps.getWorkspaceFiles());
            const path = `${dir}/${timestampName()}`;
            const result = await api({ path, data: dataUrlBase64(png) });
            if (!result.ok) throw new Error(result.error || "The image could not be saved.");
            insertText(buildIncludeGraphicsSnippet(path, (menu.querySelector("[data-figure]") as HTMLInputElement).checked)); close(); return;
          }
          const snippet = bridgeWindow.tex64Texize?.snippet;
          if (!snippet) throw new Error("texize is not available.");
          const translate = action === "translate" ? (select.value === "custom" ? custom.value.trim() : select.value) : undefined;
          if (action === "translate" && !translate) throw new Error("Enter a translation language.");
          const result = await snippet({ imageBase64: dataUrlBase64(png), ...(translate ? { translate } : {}) });
          if (!result.ok) throw new Error(result.error || "texize failed.");
          showTex(result.tex || "");
        } catch (error) {
          status.textContent = error instanceof Error ? error.message : String(error);
          status.classList.add("is-error");
        } finally { status.classList.remove("is-loading"); }
      });
    });
  };

  document.querySelectorAll<HTMLButtonElement>("[data-pro-capture]").forEach((button) => button.addEventListener("click", () => begin(button.dataset.proCapture as "preview" | "reference")));
  return { cancel: () => cleanup?.() };
};
