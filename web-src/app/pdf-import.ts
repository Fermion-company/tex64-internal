type PdfImportPage = {
  pageNumber: number;
  text: string;
  imageDataUrl: string;
  width: number;
  height: number;
};

type PdfImportOptions = {
  scale?: number;
  onPage?: (page: PdfImportPage) => void;
};

let pdfjsPromise: Promise<any> | null = null;

const loadPdfjs = async () => {
  if (!pdfjsPromise) {
    const moduleUrl = new URL("../pdfjs/pdf.min.mjs", import.meta.url).toString();
    pdfjsPromise = import(moduleUrl);
  }
  const pdfjs = await pdfjsPromise;
  if (pdfjs?.GlobalWorkerOptions) {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      "../pdfjs/pdf.worker.min.mjs",
      import.meta.url
    ).toString();
  }
  return pdfjs;
};

const decodeBase64 = (base64: string) => {
  const normalized = base64.replace(/\s+/g, "");
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

const extractPageText = async (page: any) => {
  if (!page?.getTextContent) return "";
  const content = await page.getTextContent();
  const items = Array.isArray(content?.items) ? content.items : [];
  const chunks: string[] = [];
  items.forEach((item: any) => {
    const text = typeof item?.str === "string" ? item.str : "";
    if (text) {
      chunks.push(text);
    }
    if (item?.hasEOL) {
      chunks.push("\n");
    }
  });
  return chunks
    .join(" ")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
};

const renderPageImage = async (page: any, scale: number) => {
  if (!page?.getViewport) return null;
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  const task = page.render({ canvasContext: context, viewport });
  await task.promise;
  return {
    dataUrl: canvas.toDataURL("image/png"),
    width: canvas.width,
    height: canvas.height,
  };
};

export const importPdfFromBase64 = async (
  base64: string,
  options: PdfImportOptions = {}
) => {
  const pdfjs = await loadPdfjs();
  const bytes = decodeBase64(base64);
  const task = pdfjs.getDocument({ data: bytes });
  const doc = await task.promise;
  const scale = options.scale ?? 2;
  const pages: PdfImportPage[] = [];
  try {
    const count = doc?.numPages ?? 0;
    for (let pageNumber = 1; pageNumber <= count; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      let text = "";
      let image = null;
      try {
        text = await extractPageText(page);
      } catch {
        text = "";
      }
      try {
        image = await renderPageImage(page, scale);
      } catch {
        image = null;
      }
      page.cleanup?.();
      const entry = {
        pageNumber,
        text,
        imageDataUrl: image?.dataUrl ?? "",
        width: image?.width ?? 0,
        height: image?.height ?? 0,
      };
      pages.push(entry);
      options.onPage?.(entry);
    }
  } finally {
    await Promise.resolve(doc?.destroy?.());
    await Promise.resolve(task?.destroy?.());
  }
  return pages;
};

export type { PdfImportPage, PdfImportOptions };
