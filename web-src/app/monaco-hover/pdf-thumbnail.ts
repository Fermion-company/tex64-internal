/**
 * Rasterize the first page of a PDF (delivered as a data URL) into a PNG
 * data URL for hover thumbnails. Uses the vendored pdfjs build, loaded
 * lazily so hovers never pay for it unless a PDF figure is actually hovered.
 */

let pdfjsLibPromise: Promise<any> | null = null;

const loadPdfjs = async (): Promise<any> => {
  if (!pdfjsLibPromise) {
    pdfjsLibPromise = (async () => {
      const lib: any = await import(new URL("../../pdfjs/pdf.min.mjs", import.meta.url).href);
      try {
        lib.GlobalWorkerOptions.workerSrc = new URL(
          "../../pdfjs/pdf.worker.min.mjs",
          import.meta.url
        ).href;
      } catch {
        // worker URL is best-effort; pdfjs falls back to a fake worker if unset.
      }
      return lib;
    })();
  }
  return pdfjsLibPromise;
};

const decodeBase64DataUrl = (dataUrl: string): Uint8Array | null => {
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex < 0) {
    return null;
  }
  try {
    const binary = atob(dataUrl.slice(commaIndex + 1));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
};

/**
 * Render page 1 of the given PDF data URL to a PNG data URL whose longest
 * side is ~maxSide device pixels. Returns null on any failure — hover
 * callers degrade to the no-thumbnail layout.
 */
export const renderPdfFirstPageThumbnail = async (
  pdfDataUrl: string,
  maxSide = 640
): Promise<string | null> => {
  const bytes = decodeBase64DataUrl(pdfDataUrl);
  if (!bytes || bytes.length === 0) {
    return null;
  }
  let doc: any = null;
  try {
    const pdfjsLib = await loadPdfjs();
    doc = await pdfjsLib.getDocument({
      data: bytes,
      cMapUrl: new URL("../../pdfjs/cmaps/", import.meta.url).href,
      cMapPacked: true,
      standardFontDataUrl: new URL("../../pdfjs/standard_fonts/", import.meta.url).href,
      wasmUrl: new URL("../../pdfjs/wasm/", import.meta.url).href,
      useSystemFonts: true,
      disableFontFace: false,
    }).promise;
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const largestSide = Math.max(base.width, base.height) || maxSide;
    const scale = Math.min(2, Math.max(0.3, maxSide / largestSide));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.ceil(viewport.width));
    canvas.height = Math.max(1, Math.ceil(viewport.height));
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return null;
    }
    // PDF figures are usually transparent-background vectors; paint white so
    // dark editor themes don't swallow black strokes.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  } finally {
    try {
      await doc?.cleanup?.();
      await doc?.destroy?.();
    } catch {
      // Best-effort cleanup.
    }
  }
};
