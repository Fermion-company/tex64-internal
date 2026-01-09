let pdfjsPromise = null;
const loadPdfjs = async () => {
    if (!pdfjsPromise) {
        const moduleUrl = new URL("../pdfjs/pdf.min.mjs", import.meta.url).toString();
        pdfjsPromise = import(moduleUrl);
    }
    const pdfjs = await pdfjsPromise;
    if (pdfjs === null || pdfjs === void 0 ? void 0 : pdfjs.GlobalWorkerOptions) {
        pdfjs.GlobalWorkerOptions.workerSrc = new URL("../pdfjs/pdf.worker.min.mjs", import.meta.url).toString();
    }
    return pdfjs;
};
const decodeBase64 = (base64) => {
    const normalized = base64.replace(/\s+/g, "");
    const binary = atob(normalized);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
};
const extractPageText = async (page) => {
    if (!(page === null || page === void 0 ? void 0 : page.getTextContent))
        return "";
    const content = await page.getTextContent();
    const items = Array.isArray(content === null || content === void 0 ? void 0 : content.items) ? content.items : [];
    const chunks = [];
    items.forEach((item) => {
        const text = typeof (item === null || item === void 0 ? void 0 : item.str) === "string" ? item.str : "";
        if (text) {
            chunks.push(text);
        }
        if (item === null || item === void 0 ? void 0 : item.hasEOL) {
            chunks.push("\n");
        }
    });
    return chunks
        .join(" ")
        .replace(/[ \t]+/g, " ")
        .replace(/\s*\n\s*/g, "\n")
        .trim();
};
const renderPageImage = async (page, scale) => {
    if (!(page === null || page === void 0 ? void 0 : page.getViewport))
        return null;
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context)
        return null;
    const task = page.render({ canvasContext: context, viewport });
    await task.promise;
    return {
        dataUrl: canvas.toDataURL("image/png"),
        width: canvas.width,
        height: canvas.height,
    };
};
export const importPdfFromBase64 = async (base64, options = {}) => {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j;
    const pdfjs = await loadPdfjs();
    const bytes = decodeBase64(base64);
    const task = pdfjs.getDocument({ data: bytes });
    const doc = await task.promise;
    const scale = (_a = options.scale) !== null && _a !== void 0 ? _a : 2;
    const pages = [];
    try {
        const count = (_b = doc === null || doc === void 0 ? void 0 : doc.numPages) !== null && _b !== void 0 ? _b : 0;
        for (let pageNumber = 1; pageNumber <= count; pageNumber += 1) {
            const page = await doc.getPage(pageNumber);
            let text = "";
            let image = null;
            try {
                text = await extractPageText(page);
            }
            catch {
                text = "";
            }
            try {
                image = await renderPageImage(page, scale);
            }
            catch {
                image = null;
            }
            (_c = page.cleanup) === null || _c === void 0 ? void 0 : _c.call(page);
            const entry = {
                pageNumber,
                text,
                imageDataUrl: (_d = image === null || image === void 0 ? void 0 : image.dataUrl) !== null && _d !== void 0 ? _d : "",
                width: (_e = image === null || image === void 0 ? void 0 : image.width) !== null && _e !== void 0 ? _e : 0,
                height: (_f = image === null || image === void 0 ? void 0 : image.height) !== null && _f !== void 0 ? _f : 0,
            };
            pages.push(entry);
            (_g = options.onPage) === null || _g === void 0 ? void 0 : _g.call(options, entry);
        }
    }
    finally {
        await Promise.resolve((_h = doc === null || doc === void 0 ? void 0 : doc.destroy) === null || _h === void 0 ? void 0 : _h.call(doc));
        await Promise.resolve((_j = task === null || task === void 0 ? void 0 : task.destroy) === null || _j === void 0 ? void 0 : _j.call(task));
    }
    return pages;
};
