import { uiText } from "../i18n.js";
import type { BridgeWindow } from "../types.js";
import { listFigureBlocks } from "./figure-codec.js";
import { loadPdfjs } from "./canvas-ui.js";
import { buildStandaloneDoc } from "./standalone.js";

type GalleryDeps = { getActiveGroup: () => { editor: unknown | null } };
type EditorLike = { getModel?: () => { getValue?: () => string } | null };

const pdfOptions = (data: Uint8Array) => ({
  data,
  cMapUrl: new URL("../../pdfjs/cmaps/", import.meta.url).href,
  cMapPacked: true,
  standardFontDataUrl: new URL("../../pdfjs/standard_fonts/", import.meta.url).href,
  wasmUrl: new URL("../../pdfjs/wasm/", import.meta.url).href,
  useSystemFonts: true,
  disableFontFace: false,
});

const renderThumbnail = async (pdfBase64: string) => {
  const binary = atob(pdfBase64);
  const data = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  const lib = await loadPdfjs();
  const doc = await lib.getDocument(pdfOptions(data)).promise;
  try {
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: 160 / Math.max(1, base.width) });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.ceil(viewport.width));
    canvas.height = Math.max(1, Math.ceil(viewport.height));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas is unavailable.");
    await page.render({ canvasContext: context, viewport }).promise;
    return canvas.toDataURL("image/png");
  } finally {
    await doc.destroy?.();
  }
};

export const initProCanvasGallery = (deps: GalleryDeps) => {
  const trigger = document.getElementById("pro-canvas-gallery");
  let generation = 0;

  const open = () => {
    const editor = deps.getActiveGroup().editor as EditorLike | null;
    const text = editor?.getModel?.()?.getValue?.() || "";
    const blocks = listFigureBlocks(text.split(/\r?\n/));
    const fermion = (window as BridgeWindow).tex64Fermion;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const currentGeneration = ++generation;
    const modal = document.createElement("div");
    modal.className = "modal pro-canvas-gallery-modal is-open";
    modal.setAttribute("aria-hidden", "false");
    const card = document.createElement("section");
    card.className = "modal-card pro-canvas-gallery-card";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");
    const title = document.createElement("h2");
    title.className = "modal-title";
    title.textContent = uiText("Figure gallery", "図ギャラリー");
    const list = document.createElement("div");
    list.className = "pro-canvas-gallery-list";
    const thumbnails: HTMLElement[] = [];
    if (!blocks.length) {
      const empty = document.createElement("p");
      empty.textContent = uiText("This document has no canvas figures yet.", "この文書にはキャンバス図がありません。");
      list.append(empty);
    }
    const close = () => {
      if (!modal.isConnected) return;
      generation++;
      window.removeEventListener("keydown", onKeyDown, true);
      modal.remove();
      previousFocus?.focus?.();
    };
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
    }
    blocks.forEach((block, index) => {
      const row = document.createElement("div");
      row.className = "pro-canvas-gallery-row";
      const label = document.createElement("div");
      label.className = "pro-canvas-gallery-label";
      label.textContent = uiText(`Figure ${index + 1} — line ${block.startLine + 1}, ${block.scene.objects.length} object(s)`, `図 ${index + 1}（行 ${block.startLine + 1}、オブジェクト数 ${block.scene.objects.length}）`);
      if (block.detached) {
        const badge = document.createElement("span");
        badge.className = "pro-canvas-gallery-detached";
        badge.textContent = "detached";
        label.append(" ", badge);
      }
      if (fermion?.canvasRender) {
        const thumbnail = document.createElement("div");
        thumbnail.className = "pro-canvas-gallery-thumbnail";
        thumbnail.textContent = "…";
        thumbnails.push(thumbnail);
        row.append(thumbnail);
      }
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "panel-button";
      edit.textContent = uiText("Edit", "編集");
      edit.addEventListener("click", () => {
        window.dispatchEvent(new CustomEvent("tex64:pro-canvas-open", { detail: {
          scene: block.scene,
          replaceRange: { startLine: block.startLine + 1, endLine: block.endLine + 1 },
        } }));
        close();
      });
      row.append(label, edit);
      list.append(row);
    });
    const actions = document.createElement("div");
    actions.className = "modal-actions";
    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "panel-button";
    closeButton.textContent = uiText("Close", "閉じる");
    closeButton.addEventListener("click", close);
    actions.append(closeButton);
    card.append(title, list, actions);
    modal.append(card);
    document.body.append(modal);
    modal.addEventListener("mousedown", (event) => { if (event.target === modal) close(); });
    window.addEventListener("keydown", onKeyDown, true);
    requestAnimationFrame(() => closeButton.focus());

    if (fermion?.canvasRender) void (async () => {
      for (let index = 0; index < blocks.length; index++) {
        if (generation !== currentGeneration) return;
        const thumbnail = thumbnails[index];
        try {
          const result = await fermion.canvasRender!({ source: buildStandaloneDoc(blocks[index].scene) });
          if (generation !== currentGeneration) return;
          if (!result.ok || !result.pdfBase64) throw new Error(result.error || "Compile failed");
          const src = await renderThumbnail(result.pdfBase64);
          if (generation !== currentGeneration) return;
          const image = document.createElement("img");
          image.src = src;
          image.alt = uiText(`Figure ${index + 1}`, `図 ${index + 1}`);
          thumbnail.replaceChildren(image);
        } catch {
          if (generation !== currentGeneration) return;
          thumbnail.textContent = "⚠";
        }
      }
    })();
  };

  trigger?.addEventListener("click", open);
  return { open };
};
