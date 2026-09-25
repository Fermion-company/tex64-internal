import type { PDFPageProxy } from "pdfjs-dist";

/** Print only PDF pages, independent of the editor's scroll/flex layout. */
export async function printPdfPages(pages: PDFPageProxy[]): Promise<void> {
  const frame = document.createElement("iframe");
  frame.title = "PDF印刷";
  frame.setAttribute("aria-hidden", "true");
  Object.assign(frame.style, { position: "fixed", width: "1px", height: "1px", left: "-10000px", border: "0" });
  try {
    const sheets: string[] = [];
    const rules: string[] = [];
    for (const [index, page] of pages.entries()) {
      const size = page.getViewport({ scale: 1 });
      // 216 dpi, bounded for unusually large sheets. Render sequentially so
      // only one high-resolution canvas is resident while preparing pages.
      const scale = Math.min(3, 6000 / Math.max(size.width, size.height));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
      await page.render({ canvas, viewport, intent: "print" }).promise;
      sheets.push(`<section style="page:sheet${index};width:${size.width}pt;height:${size.height}pt"><img src="${canvas.toDataURL("image/png")}" /></section>`);
      rules.push(`@page sheet${index}{size:${size.width}pt ${size.height}pt;margin:0}`);
      canvas.width = canvas.height = 0;
    }
    const ready = new Promise<void>((resolve, reject) => {
      frame.onload = () => resolve(); frame.onerror = () => reject(new Error("Print frame failed"));
    });
    frame.srcdoc = `<!doctype html><html><head><title>PDF</title><style>${rules.join("")}html,body{margin:0;padding:0}section{break-after:page;break-inside:avoid;overflow:hidden}section:last-child{break-after:auto}img{display:block;width:100%;height:100%}</style></head><body>${sheets.join("")}</body></html>`;
    document.body.append(frame);
    await ready;
    const printWindow = frame.contentWindow;
    if (!printWindow) throw new Error("Print frame unavailable");
    await Promise.all(Array.from(frame.contentDocument?.images ?? []).map((image) => image.decode()));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    printWindow.focus();
    printWindow.print();
  } finally { frame.remove(); }
}
