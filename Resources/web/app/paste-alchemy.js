import { convertHtmlToLatex, extractPlainText } from "./html-to-latex.js";
import { formatSnippetForInsert } from "./blocks/format.js";
import { buildFigureSnippet, buildMathSnippet, buildTableSnippet, buildTextSnippet, } from "./snippet-builders.js";
import { importPdfFromBase64 } from "./pdf-import.js";
import { recognizeImage } from "./ocr.js";
const generateId = () => {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
    }
    return `alchemy-${Date.now()}-${Math.random().toString(16).slice(2)}`;
};
const normalizeCell = (value) => value.replace(/\s+/g, " ").replace(/\u00a0/g, " ").trim();
const PDF_MODE_OPTIONS = ["Auto", "PDFテキスト", "OCR"];
const MIN_PDF_TEXT_LENGTH = 24;
const normalizePdfMode = (mode) => {
    if (mode && PDF_MODE_OPTIONS.includes(mode)) {
        return mode;
    }
    return "Auto";
};
const hasUsefulPdfText = (text) => text.replace(/\s+/g, "").length >= MIN_PDF_TEXT_LENGTH;
const parseTablesFromHtml = (html) => {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    const tables = Array.from(doc.querySelectorAll("table")).map((table) => {
        var _a;
        const rows = Array.from(table.querySelectorAll("tr")).map((row) => Array.from(row.querySelectorAll("th, td")).map((cell) => { var _a; return normalizeCell((_a = cell.textContent) !== null && _a !== void 0 ? _a : ""); }));
        const headers = rows.length > 0 && table.querySelector("th") ? (_a = rows.shift()) !== null && _a !== void 0 ? _a : [] : [];
        return { headers, rows };
    });
    doc.querySelectorAll("table").forEach((table) => table.remove());
    return { tables, html: doc.body.innerHTML };
};
export const initPasteAlchemy = (context, deps) => {
    const { editorHost, editorHostSecondary } = context.dom;
    const pendingClipboard = new Set();
    const pendingImageSaves = new Map();
    const enablePasteIntercept = false;
    let storedItems = [];
    const refreshUi = () => {
        const items = storedItems.map((item) => ({
            id: item.id,
            kind: item.kind,
            tag: item.tag,
            score: item.score,
            status: item.status,
            formats: item.formats,
            format: item.format,
            mode: item.mode,
            modeOptions: item.modeOptions,
            preview: item.preview,
            snippet: item.snippet,
        }));
        deps.alchemyPreview.setItems(items);
    };
    const ensureSnippet = async (item) => {
        const targetId = item.id;
        try {
            const snippet = await buildSnippet(item);
            item.snippet = snippet;
        }
        catch {
            item.snippet = "";
        }
        if (storedItems.some((entry) => entry.id === targetId)) {
            refreshUi();
        }
    };
    const discardItem = (id) => {
        storedItems = storedItems.filter((item) => item.id !== id);
        refreshUi();
    };
    const discardAll = () => {
        storedItems = [];
        deps.alchemyPreview.clearItems();
    };
    const updateItemFormat = (id, format) => {
        const item = storedItems.find((entry) => entry.id === id);
        if (!item)
            return;
        item.format = format;
        void ensureSnippet(item);
    };
    const isOcrModeActive = (item) => {
        var _a;
        const pdfText = (_a = item.source.pdfText) !== null && _a !== void 0 ? _a : "";
        const mode = normalizePdfMode(item.mode);
        if (mode === "OCR")
            return true;
        if (mode === "Auto")
            return !hasUsefulPdfText(pdfText);
        return false;
    };
    const startOcrForItem = (item, language) => {
        if (!item.source.imageDataUrl) {
            item.preview = { type: "text", value: "OCR対象がありません。" };
            item.status = "error";
            item.score = "OCR不可";
            return;
        }
        if (item.status === "processing" && item.source.ocrRequestId) {
            return;
        }
        const requestId = generateId();
        item.source.ocrRequestId = requestId;
        item.source.ocrLanguage = language;
        item.status = "processing";
        item.score = "OCR中";
        item.preview = { type: "image", url: item.source.imageDataUrl };
        if (storedItems.some((entry) => entry.id === item.id)) {
            refreshUi();
        }
        recognizeImage(item.source.imageDataUrl, { language })
            .then((result) => {
            const current = storedItems.find((entry) => entry.id === item.id);
            if (!current || current.source.ocrRequestId !== requestId) {
                return;
            }
            const text = result.text.trim();
            current.source.ocrText = text;
            current.source.text = text;
            current.source.ocrRequestId = undefined;
            if (isOcrModeActive(current)) {
                current.preview = {
                    type: "text",
                    value: text || "OCR結果が空でした。",
                };
                current.status = text ? "ready" : "error";
                current.score = text ? null : "OCR結果なし";
            }
            void ensureSnippet(current);
            refreshUi();
        })
            .catch((error) => {
            const current = storedItems.find((entry) => entry.id === item.id);
            if (!current || current.source.ocrRequestId !== requestId) {
                return;
            }
            current.source.ocrRequestId = undefined;
            if (isOcrModeActive(current)) {
                current.preview = {
                    type: "text",
                    value: error instanceof Error ? error.message : "OCRに失敗しました。",
                };
                current.status = "error";
                current.score = "OCR失敗";
            }
            refreshUi();
        });
    };
    const applyPdfMode = (item, mode) => {
        var _a, _b;
        const normalizedMode = normalizePdfMode(mode);
        item.mode = normalizedMode;
        const pdfText = (_a = item.source.pdfText) !== null && _a !== void 0 ? _a : "";
        const effectiveMode = normalizedMode === "Auto"
            ? hasUsefulPdfText(pdfText)
                ? "PDFテキスト"
                : "OCR"
            : normalizedMode;
        if (effectiveMode === "PDFテキスト") {
            const text = pdfText.trim();
            item.source.text = text;
            item.preview = {
                type: "text",
                value: text || "PDFテキストが見つかりませんでした。",
            };
            item.status = text ? "ready" : "error";
            item.score = null;
            return;
        }
        const settings = deps.alchemyPreview.getSettings();
        const language = settings.ocrLanguage || "eng";
        const ocrText = (_b = item.source.ocrText) !== null && _b !== void 0 ? _b : "";
        if (ocrText && item.source.ocrLanguage === language) {
            item.source.text = ocrText;
            item.preview = { type: "text", value: ocrText };
            item.status = "ready";
            item.score = null;
            return;
        }
        startOcrForItem(item, language);
    };
    const updateItemMode = (id, mode) => {
        const item = storedItems.find((entry) => entry.id === id);
        if (!item || !item.modeOptions || item.modeOptions.length === 0)
            return;
        applyPdfMode(item, mode);
        refreshUi();
        void ensureSnippet(item);
    };
    const insertSnippet = (snippet) => {
        var _a, _b, _c, _d, _e, _f;
        const activeGroup = deps.editorSession.getActiveGroup();
        if (!activeGroup.editor ||
            !activeGroup.currentFilePath ||
            !activeGroup.currentFilePath.endsWith(".tex")) {
            deps.updateIssues(1, "貼り付けは .tex ファイルで行ってください。", "error", [
                { severity: "error", message: "貼り付けは .tex ファイルで行ってください。" },
            ]);
            return false;
        }
        const editor = activeGroup.editor;
        const monaco = deps.getMonacoApi();
        if (!(monaco === null || monaco === void 0 ? void 0 : monaco.Range)) {
            deps.updateIssues(1, "エディタの準備が完了していません。", "error", [
                { severity: "error", message: "エディタの準備が完了していません。" },
            ]);
            return false;
        }
        const selection = (_a = editor.getSelection) === null || _a === void 0 ? void 0 : _a.call(editor);
        const position = (_c = (_b = editor.getPosition) === null || _b === void 0 ? void 0 : _b.call(editor)) !== null && _c !== void 0 ? _c : { lineNumber: 1, column: 1 };
        const insertPosition = selection
            ? { lineNumber: selection.startLineNumber, column: selection.startColumn }
            : position;
        const model = (_d = editor.getModel) === null || _d === void 0 ? void 0 : _d.call(editor);
        const formatted = formatSnippetForInsert(snippet, model, insertPosition);
        const range = selection
            ? new monaco.Range(selection.startLineNumber, selection.startColumn, selection.endLineNumber, selection.endColumn)
            : new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column);
        (_e = editor.executeEdits) === null || _e === void 0 ? void 0 : _e.call(editor, "alchemy-insert", [
            { range, text: formatted, forceMoveMarkers: true },
        ]);
        (_f = editor.focus) === null || _f === void 0 ? void 0 : _f.call(editor);
        return true;
    };
    const saveImage = (dataUrl) => new Promise((resolve, reject) => {
        const requestId = generateId();
        pendingImageSaves.set(requestId, { resolve, reject });
        const ok = deps.postToNative({ type: "alchemy:save-image", requestId, dataUrl }, true);
        if (!ok) {
            pendingImageSaves.delete(requestId);
            reject("画像の保存要求に失敗しました。");
        }
    });
    const buildSnippet = async (item) => {
        var _a, _b, _c, _d;
        if (item.kind === "text") {
            const baseText = (_b = (_a = item.source.text) !== null && _a !== void 0 ? _a : item.source.latex) !== null && _b !== void 0 ? _b : "";
            if (!baseText)
                return "";
            if (item.source.latex && item.format === "plain") {
                return item.source.latex;
            }
            return buildTextSnippet(baseText, item.format);
        }
        if (item.kind === "math") {
            const latex = (_c = item.source.latex) !== null && _c !== void 0 ? _c : "";
            return buildMathSnippet(latex, item.format);
        }
        if (item.kind === "table") {
            return buildTableSnippet((_d = item.source.rows) !== null && _d !== void 0 ? _d : [], item.format);
        }
        if (item.kind === "figure") {
            if (!item.source.imageDataUrl)
                return "";
            if (item.source.savedPath) {
                return buildFigureSnippet(item.source.savedPath, item.format);
            }
            const savedPath = await saveImage(item.source.imageDataUrl);
            item.source.savedPath = savedPath;
            return buildFigureSnippet(savedPath, item.format);
        }
        return "";
    };
    const applyItem = async (id) => {
        const item = storedItems.find((entry) => entry.id === id);
        if (!item)
            return;
        try {
            const snippet = item.snippet || (await buildSnippet(item));
            if (snippet && !item.snippet) {
                item.snippet = snippet;
            }
            if (!snippet) {
                const isPdfItem = item.source.pdfPage !== undefined;
                const message = isPdfItem
                    ? item.mode === "OCR" || item.mode === "Auto"
                        ? "OCR結果がありません。PDFテキストに切り替えてください。"
                        : "PDFテキストが空でした。"
                    : "挿入する内容がありません。";
                deps.updateIssues(1, message, "error", [{ severity: "error", message }]);
                return;
            }
            const ok = insertSnippet(snippet);
            if (!ok) {
                return;
            }
            discardItem(id);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : "挿入に失敗しました。";
            deps.updateIssues(1, message, "error", [{ severity: "error", message }]);
        }
    };
    const getItemSnippet = async (id) => {
        const item = storedItems.find((entry) => entry.id === id);
        if (!item)
            return "";
        if (item.snippet) {
            return item.snippet;
        }
        try {
            const snippet = await buildSnippet(item);
            item.snippet = snippet;
            refreshUi();
            return snippet;
        }
        catch (error) {
            const message = error instanceof Error ? error.message : "挿入内容の生成に失敗しました。";
            deps.updateIssues(1, message, "error", [{ severity: "error", message }]);
            return "";
        }
    };
    const applyEditedSnippet = (id, snippet) => {
        const trimmed = snippet.trim();
        if (!trimmed) {
            deps.updateIssues(1, "挿入する内容がありません。", "error", [
                { severity: "error", message: "挿入する内容がありません。" },
            ]);
            return;
        }
        const ok = insertSnippet(snippet);
        if (!ok) {
            return;
        }
        discardItem(id);
    };
    const applyAll = async () => {
        const current = [...storedItems];
        for (const item of current) {
            await applyItem(item.id);
        }
    };
    const createPdfItem = (page, mode) => {
        var _a;
        const item = {
            id: generateId(),
            kind: "text",
            tag: `PDF p.${page.pageNumber}`,
            formats: ["plain", "quote", "itemize"],
            format: "plain",
            modeOptions: [...PDF_MODE_OPTIONS],
            mode: normalizePdfMode(mode),
            preview: { type: "text", value: "" },
            source: {
                pdfPage: page.pageNumber,
                pdfText: page.text,
                imageDataUrl: page.imageDataUrl,
            },
        };
        applyPdfMode(item, (_a = item.mode) !== null && _a !== void 0 ? _a : "Auto");
        return item;
    };
    const importPdfPayload = async (pdfBase64) => {
        deps.alchemyPreview.setOpen(true);
        const placeholderId = generateId();
        storedItems = storedItems.concat({
            id: placeholderId,
            kind: "text",
            tag: "PDF",
            status: "processing",
            formats: ["plain"],
            format: "plain",
            preview: { type: "text", value: "PDFを解析中..." },
            source: {},
        });
        refreshUi();
        const settings = deps.alchemyPreview.getSettings();
        try {
            const pages = await importPdfFromBase64(pdfBase64, { scale: 2 });
            storedItems = storedItems.filter((item) => item.id !== placeholderId);
            if (pages.length === 0) {
                deps.updateIssues(0, "PDFにページがありませんでした。", "info", []);
                refreshUi();
                return;
            }
            const pdfItems = pages.map((page) => createPdfItem(page, settings.pdfMode));
            storedItems = storedItems.concat(pdfItems);
            refreshUi();
            pdfItems.forEach((item) => {
                void ensureSnippet(item);
            });
        }
        catch (error) {
            const message = error instanceof Error ? error.message : "PDFの取り込みに失敗しました。";
            const placeholder = storedItems.find((item) => item.id === placeholderId);
            if (placeholder) {
                placeholder.status = "error";
                placeholder.preview = { type: "text", value: message };
            }
            refreshUi();
            deps.updateIssues(1, message, "error", [{ severity: "error", message }]);
        }
    };
    const handleClipboardPayload = (payload) => {
        if (payload.requestId) {
            if (!pendingClipboard.has(payload.requestId)) {
                return;
            }
            pendingClipboard.delete(payload.requestId);
        }
        const settings = deps.alchemyPreview.getSettings();
        const nextItems = [];
        if (payload.html) {
            const parsed = parseTablesFromHtml(payload.html);
            parsed.tables.forEach((table) => {
                const id = generateId();
                nextItems.push({
                    id,
                    kind: "table",
                    tag: "HTML表",
                    formats: ["tabular", "tabularx", "longtable"],
                    format: settings.defaultTable,
                    preview: {
                        type: "table",
                        headers: table.headers,
                        rows: table.rows,
                    },
                    source: {
                        rows: table.rows,
                    },
                });
            });
            const plainText = extractPlainText(parsed.html);
            const latex = convertHtmlToLatex(parsed.html);
            if (plainText || latex) {
                const id = generateId();
                nextItems.push({
                    id,
                    kind: "text",
                    tag: "HTML",
                    formats: ["plain", "quote", "itemize"],
                    format: "plain",
                    preview: { type: "text", value: plainText || latex },
                    source: { text: plainText, latex },
                });
            }
        }
        else if (payload.text) {
            const id = generateId();
            nextItems.push({
                id,
                kind: "text",
                tag: "テキスト",
                formats: ["plain", "quote", "itemize"],
                format: "plain",
                preview: { type: "text", value: payload.text },
                source: { text: payload.text },
            });
        }
        if (payload.imageDataUrl) {
            const id = generateId();
            nextItems.push({
                id,
                kind: "figure",
                tag: "画像",
                formats: ["includegraphics", "figure"],
                format: settings.defaultFigure,
                preview: { type: "image", url: payload.imageDataUrl },
                source: { imageDataUrl: payload.imageDataUrl },
            });
        }
        const hasPdf = Boolean(payload.pdfBase64);
        if (nextItems.length === 0 && !hasPdf) {
            deps.updateIssues(0, "取り込み対象が見つかりませんでした。", "info", []);
            return;
        }
        if (nextItems.length > 0) {
            storedItems = storedItems.concat(nextItems);
            refreshUi();
            deps.alchemyPreview.setOpen(true);
            nextItems.forEach((item) => {
                void ensureSnippet(item);
            });
        }
        if (payload.pdfBase64) {
            void importPdfPayload(payload.pdfBase64);
        }
    };
    const handleCaptureImage = (imageDataUrl, tag = "キャプチャ") => {
        if (!imageDataUrl)
            return;
        const settings = deps.alchemyPreview.getSettings();
        const id = generateId();
        const item = {
            id,
            kind: "figure",
            tag,
            formats: ["includegraphics", "figure"],
            format: settings.defaultFigure,
            preview: { type: "image", url: imageDataUrl },
            source: { imageDataUrl },
        };
        storedItems = storedItems.concat(item);
        refreshUi();
        deps.alchemyPreview.setOpen(true);
        void ensureSnippet(item);
    };
    const handleImageSaved = (payload) => {
        var _a;
        const requestId = payload.requestId;
        if (!requestId)
            return;
        const pending = pendingImageSaves.get(requestId);
        if (!pending)
            return;
        pendingImageSaves.delete(requestId);
        if (payload.ok && payload.path) {
            pending.resolve(payload.path);
            return;
        }
        pending.reject((_a = payload.error) !== null && _a !== void 0 ? _a : "画像の保存に失敗しました。");
    };
    const requestClipboardRead = () => {
        const requestId = generateId();
        pendingClipboard.add(requestId);
        deps.postToNative({ type: "alchemy:clipboard:read", requestId }, true);
        deps.alchemyPreview.setOpen(true);
    };
    const shouldInterceptPaste = (event) => {
        var _a, _b;
        const types = Array.from((_b = (_a = event.clipboardData) === null || _a === void 0 ? void 0 : _a.types) !== null && _b !== void 0 ? _b : []);
        if (types.length === 1 && types[0] === "text/plain") {
            return false;
        }
        return (types.includes("text/html") ||
            types.some((type) => type.startsWith("image/")) ||
            types.some((type) => type.toLowerCase().includes("pdf")));
    };
    const handlePaste = (event) => {
        if (!event.clipboardData) {
            return;
        }
        if (!shouldInterceptPaste(event)) {
            return;
        }
        const target = event.target;
        const inPrimary = editorHost instanceof HTMLElement && target && editorHost.contains(target);
        const inSecondary = editorHostSecondary instanceof HTMLElement &&
            target &&
            editorHostSecondary.contains(target);
        if (!inPrimary && !inSecondary) {
            return;
        }
        event.preventDefault();
        const requestId = generateId();
        pendingClipboard.add(requestId);
        deps.postToNative({ type: "alchemy:clipboard:read", requestId }, true);
        deps.alchemyPreview.setOpen(true);
    };
    if (enablePasteIntercept && editorHost instanceof HTMLElement) {
        editorHost.addEventListener("paste", handlePaste);
    }
    if (enablePasteIntercept && editorHostSecondary instanceof HTMLElement) {
        editorHostSecondary.addEventListener("paste", handlePaste);
    }
    deps.alchemyPreview.setHandlers({
        onApplyItem: (id) => {
            void applyItem(id);
        },
        onDiscardItem: discardItem,
        onApplyAll: () => {
            void applyAll();
        },
        onDiscardAll: discardAll,
        onFormatChange: updateItemFormat,
        onModeChange: updateItemMode,
    });
    return {
        requestClipboardRead,
        handleClipboardPayload,
        handleImageSaved,
        handleCaptureImage,
        getItemSnippet,
        applyEditedSnippet,
    };
};
