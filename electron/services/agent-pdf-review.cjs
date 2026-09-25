"use strict";

const { Worker, isMainThread, parentPort, workerData } = require("node:worker_threads");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

// Run PDF parsing/rasterization away from Electron's main thread. No process,
// executable or network is chosen by the model. Stop terminates the worker.
const renderPdfPages = (pdfPath, pages, signal) => new Promise((resolve, reject) => {
  signal?.throwIfAborted();
  const worker = new Worker(__filename, { workerData: { pdfPath, pages } });
  let done = false;
  const finish = (error, value) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    void worker.terminate();
    error ? reject(error) : resolve(value);
  };
  const abort = () => finish(Object.assign(new Error("PDF review cancelled"), { name: "AbortError" }));
  const timer = setTimeout(() => finish(new Error("PDF rendering exceeded 30 seconds")), 30_000);
  signal?.addEventListener("abort", abort, { once: true });
  worker.once("message", (value) => value.error ? finish(new Error(value.error)) : finish(null, value));
  worker.once("error", (error) => finish(error));
  worker.once("exit", (code) => { if (!done) finish(new Error(`PDF worker exited before returning pages (${code})`)); });
  if (signal?.aborted) abort();
});

async function render({ pdfPath, pages }) {
  const stat = await fs.stat(pdfPath);
  if (!stat.isFile() || stat.size > 50 * 1024 * 1024) throw new Error("PDF must be a file smaller than 50 MB");
  const pdfjsPath = require.resolve("pdfjs-dist/legacy/build/pdf.mjs");
  const base = path.resolve(path.dirname(pdfjsPath), "../..");
  const { createCanvas } = require("@napi-rs/canvas");
  const { getDocument } = await import(pathToFileURL(pdfjsPath).href);
  const loading = getDocument({ data: new Uint8Array(await fs.readFile(pdfPath)),
    isEvalSupported: false, useSystemFonts: true,
    standardFontDataUrl: path.join(base, "standard_fonts") + path.sep,
    cMapUrl: path.join(base, "cmaps") + path.sep, cMapPacked: true,
  });
  try {
    const pdf = await loading.promise;
    const wanted = [...new Set(pages?.length ? pages : [1])];
    if (wanted.length > 3 || wanted.some((p) => !Number.isSafeInteger(p) || p < 1 || p > pdf.numPages)) {
      throw new Error(`Choose 1–3 page numbers within 1–${pdf.numPages}`);
    }
    const images = [];
    for (const number of wanted) {
      const page = await pdf.getPage(number);
      const size = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(1.75, 1400 / Math.max(size.width, size.height)) });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
      images.push({ page: number, url: `data:image/png;base64,${canvas.toBuffer("image/png").toString("base64")}` });
      page.cleanup();
    }
    return { pageCount: pdf.numPages, pages: wanted, images };
  } finally { await loading.destroy(); }
}
if (!isMainThread) render(workerData).then((result) => parentPort.postMessage(result), (error) => parentPort.postMessage({ error: error.message }));
module.exports = { renderPdfPages };
