let tesseractModulePromise = null;
let workerEntry = null;
let running = false;
const queue = [];
const getTesseractModule = async () => {
    if (!tesseractModulePromise) {
        const moduleUrl = new URL("../tesseract/tesseract.esm.min.js", import.meta.url)
            .toString();
        tesseractModulePromise = import(moduleUrl).then((module) => {
            var _a;
            const resolved = (_a = module.default) !== null && _a !== void 0 ? _a : module;
            return resolved;
        });
    }
    return tesseractModulePromise;
};
const ensureWorker = async (language) => {
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
            logger: () => { },
        });
        workerEntry = { worker, language };
        return worker;
    }
    await workerEntry.worker.reinitialize(language);
    workerEntry.language = language;
    return workerEntry.worker;
};
const runQueue = async () => {
    var _a, _b, _c, _d;
    if (running)
        return;
    running = true;
    while (queue.length > 0) {
        const task = queue.shift();
        if (!task) {
            continue;
        }
        try {
            const worker = await ensureWorker(task.language);
            const result = await worker.recognize(task.imageDataUrl);
            const text = (_b = (_a = result === null || result === void 0 ? void 0 : result.data) === null || _a === void 0 ? void 0 : _a.text) !== null && _b !== void 0 ? _b : "";
            const confidence = (_d = (_c = result === null || result === void 0 ? void 0 : result.data) === null || _c === void 0 ? void 0 : _c.confidence) !== null && _d !== void 0 ? _d : null;
            task.resolve({ text, confidence });
        }
        catch (error) {
            const err = error instanceof Error ? error : new Error("OCRに失敗しました。");
            task.reject(err);
        }
    }
    running = false;
};
export const recognizeImage = (imageDataUrl, options) => new Promise((resolve, reject) => {
    const mock = globalThis.__tex64OcrMock;
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
