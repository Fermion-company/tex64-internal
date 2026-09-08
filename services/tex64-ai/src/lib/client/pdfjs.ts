export type PdfJsModule = typeof import("pdfjs-dist");

let pdfjsModulePromise: Promise<PdfJsModule> | null = null;

/**
 * Load pdfjs lazily on the client only. The worker is created from the
 * bundler-emitted asset (`new URL(..., import.meta.url)` works under both
 * turbopack and webpack) so the production CSP (`worker-src 'self' blob:`,
 * no `unsafe-eval`) is satisfied without any CDN or eval fallback.
 */
export function loadPdfjs(): Promise<PdfJsModule> {
  pdfjsModulePromise ??= import("pdfjs-dist").then((pdfjs) => {
    if (!pdfjs.GlobalWorkerOptions.workerPort) {
      pdfjs.GlobalWorkerOptions.workerPort = new Worker(
        new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url),
        { type: "module" },
      );
    }
    return pdfjs;
  });
  return pdfjsModulePromise;
}
