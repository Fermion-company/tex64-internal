import type { BridgeWindow } from "./types.js";
import { insertAtEditorCursor, type ProEditorLike } from "./pro-editor-insert.js";

export type CaptureRect = { x: number; y: number; width: number; height: number };

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

  const capturePdf = (iframe: HTMLIFrameElement, rect: CaptureRect): Promise<string> => new Promise((resolve, reject) => {
    const requestId = `capture-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const timer = window.setTimeout(() => { window.removeEventListener("message", receive); reject(new Error("PDF capture timed out.")); }, 10000);
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
    iframe.contentWindow?.postMessage({ source: "tex64-pdf", payload: { type: "capture-region", requestId, payload: rect } }, "*");
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
    overlay.innerHTML = '<div class="pro-capture-hint">Drag to select · Esc to cancel</div>';
    body.appendChild(overlay);
    overlay.focus();
    let start: { x: number; y: number } | null = null;
    let rect: CaptureRect | null = null;
    let box: HTMLDivElement | null = null;
    const close = () => { overlay.remove(); document.removeEventListener("keydown", onKey); if (cleanup === close) cleanup = null; };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    cleanup = close;
    overlay.addEventListener("pointerdown", (event) => {
      if ((event.target as Element).closest(".pro-capture-menu, .pro-capture-confirm")) return;
      const bounds = overlay.getBoundingClientRect();
      start = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
      box?.remove();
      box = document.createElement("div"); box.className = "pro-capture-selection"; overlay.appendChild(box);
      overlay.setPointerCapture(event.pointerId);
    });
    overlay.addEventListener("pointermove", (event) => {
      if (!start || !box) return;
      const bounds = overlay.getBoundingClientRect();
      rect = normalizeCaptureRect(start.x, start.y, event.clientX - bounds.left, event.clientY - bounds.top);
      Object.assign(box.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    });
    overlay.addEventListener("pointerup", (event) => {
      if (!start || !rect || rect.width < 4 || rect.height < 4) { start = null; return; }
      start = null; overlay.releasePointerCapture(event.pointerId);
      const menu = document.createElement("div");
      menu.className = "pro-capture-menu";
      menu.innerHTML = `<button data-action="tex">TeX化</button><span class="pro-capture-translate"><select aria-label="Translation language"><option>Japanese</option><option>English</option><option value="custom">Other…</option></select><input hidden placeholder="Language" /></span><button data-action="translate">翻訳して挿入</button><label><input type="checkbox" data-figure /> figure</label><button data-action="image">画像化して挿入</button><button data-action="stash">スタッシュへ</button><button data-action="copy">コピー(PNG)</button><span class="pro-capture-status"></span>`;
      Object.assign(menu.style, { left: `${Math.min(rect.x, Math.max(4, overlay.clientWidth - 300))}px`, top: `${Math.min(rect.y + rect.height + 6, Math.max(4, overlay.clientHeight - 120))}px` });
      overlay.querySelector(".pro-capture-menu")?.remove(); overlay.appendChild(menu);
      const select = menu.querySelector("select") as HTMLSelectElement;
      const custom = menu.querySelector("input[placeholder=Language]") as HTMLInputElement;
      select.addEventListener("change", () => { custom.hidden = select.value !== "custom"; if (!custom.hidden) custom.focus(); });
      const status = menu.querySelector<HTMLElement>(".pro-capture-status")!;
      const getPng = async () => {
        const viewer = document.getElementById(`pro-${kind}-viewer`);
        const bodyRect = body.getBoundingClientRect();
        if (viewer?.dataset.view === "image") return captureImage(document.getElementById(`pro-${kind}-image`) as HTMLImageElement, rect!, bodyRect);
        if (viewer?.dataset.view === "pdf") {
          const iframe = document.getElementById(`pro-${kind}-pdf`) as HTMLIFrameElement;
          const iframeRect = iframe.getBoundingClientRect();
          return capturePdf(iframe, { x: rect!.x - (iframeRect.left - bodyRect.left), y: rect!.y - (iframeRect.top - bodyRect.top), width: rect!.width, height: rect!.height });
        }
        throw new Error("Open an image or PDF before selecting a region.");
      };
      const showTex = (tex: string) => {
        menu.remove();
        const confirm = document.createElement("div"); confirm.className = "pro-capture-confirm";
        const textarea = document.createElement("textarea"); textarea.value = tex; textarea.rows = 7;
        const insert = document.createElement("button"); insert.textContent = "カーソル位置に挿入";
        insert.addEventListener("click", () => { try { insertText(textarea.value); close(); } catch (error) { confirm.dataset.error = error instanceof Error ? error.message : String(error); } });
        const stash = document.createElement("button"); stash.textContent = "スタッシュへ";
        stash.addEventListener("click", () => { window.dispatchEvent(new CustomEvent("tex64:pro-stash-add", { detail: { kind: "text", content: textarea.value } })); close(); });
        confirm.append(textarea, insert, stash); overlay.appendChild(confirm);
        Object.assign(confirm.style, { left: menu.style.left, top: menu.style.top });
      };
      menu.addEventListener("click", async (click) => {
        const action = (click.target as HTMLElement).closest<HTMLButtonElement>("button")?.dataset.action;
        if (!action) return;
        try {
          status.classList.add("is-loading"); status.textContent = "処理中…";
          const png = await getPng();
          if (action === "copy") {
            const blob = await (await fetch(png)).blob(); await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]); status.textContent = "コピーしました"; return;
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
