type OcrResult = {
  text: string;
  confidence?: number | null;
};

type OcrOptions = {
  language: string;
};

type WorkerEntry = {
  worker: {
    recognize: (image: string) => Promise<{ data?: { text?: string; confidence?: number } }>;
    reinitialize: (langs: string) => Promise<unknown>;
  };
  language: string;
};

type OcrTask = {
  imageDataUrl: string;
  language: string;
  resolve: (result: OcrResult) => void;
  reject: (error: Error) => void;
};

let tesseractModulePromise: Promise<{ createWorker: (...args: any[]) => Promise<any> }> | null =
  null;
let workerEntry: WorkerEntry | null = null;
let running = false;
const queue: OcrTask[] = [];

const getTesseractModule = async () => {
  if (!tesseractModulePromise) {
    const moduleUrl = new URL("../tesseract/tesseract.esm.min.js", import.meta.url)
      .toString();
    tesseractModulePromise = import(moduleUrl).then((module) => {
      const resolved = (module as { default?: any }).default ?? module;
      return resolved;
    });
  }
  return tesseractModulePromise;
};

const ensureWorker = async (language: string) => {
  if (workerEntry && workerEntry.language === language) {
    return workerEntry.worker;
  }
  const { createWorker } = await getTesseractModule();
  const workerPath = new URL("../tesseract/worker.min.js", import.meta.url).toString();
  const corePath = new URL("../tesseract/tesseract-core.wasm.js", import.meta.url).toString();
  const langPath = "https://tessdata.projectnaptha.com/4.0.0";
  if (!workerEntry) {
    const worker = await createWorker(language, undefined, {
      workerPath,
      corePath,
      langPath,
      gzip: true,
      logger: () => {},
    });
    workerEntry = { worker, language };
    return worker;
  }
  await workerEntry.worker.reinitialize(language);
  workerEntry.language = language;
  return workerEntry.worker;
};

const runQueue = async () => {
  if (running) return;
  running = true;
  while (queue.length > 0) {
    const task = queue.shift();
    if (!task) {
      continue;
    }
    try {
      const worker = await ensureWorker(task.language);
      const result = await worker.recognize(task.imageDataUrl);
      const text = result?.data?.text ?? "";
      const confidence = result?.data?.confidence ?? null;
      task.resolve({ text, confidence });
    } catch (error) {
      const err = error instanceof Error ? error : new Error("OCRに失敗しました。");
      task.reject(err);
    }
  }
  running = false;
};

export const recognizeImage = (imageDataUrl: string, options: OcrOptions) =>
  new Promise<OcrResult>((resolve, reject) => {
    const mock = (globalThis as { __tex64OcrMock?: unknown }).__tex64OcrMock;
    if (typeof mock === "function") {
      Promise.resolve(mock(imageDataUrl, options))
        .then((result) => {
          if (result && typeof result.text === "string") {
            resolve(result);
            return;
          }
          resolve({ text: "" });
        })
        .catch((error) => {
          reject(error instanceof Error ? error : new Error("OCRに失敗しました。"));
        });
      return;
    }
    if (!imageDataUrl) {
      reject(new Error("OCR対象の画像がありません。"));
      return;
    }
    const language = options.language || "eng";
    queue.push({ imageDataUrl, language, resolve, reject });
    void runQueue();
  });

export type { OcrOptions, OcrResult };
