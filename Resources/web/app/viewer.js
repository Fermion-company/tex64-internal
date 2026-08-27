import { IMAGE_MIME_TYPES, getFileExtension } from "./files.js";
export const createViewer = (deps) => {
    let viewerBlobUrl = null;
    let viewerMode = "hidden";
    let pdfViewerReady = false;
    let pdfViewerPath = null;
    let pendingPdfOpen = null;
    let pendingPdfSync = null;
    // Real-time preview: when set, the pdf viewer swaps its page canvas for the
    // live engine frame (same chrome). Re-sent on every viewer "ready" so it
    // survives the pdf iframe being torn down and recreated.
    let livePreview = null;
    const pdfViewerUrl = new URL("pdf-viewer.html", window.location.href).toString();
    const postPdfMessage = (payload) => {
        if (!(deps.editorViewerPdf instanceof HTMLIFrameElement)) {
            return false;
        }
        const target = deps.editorViewerPdf.contentWindow;
        if (!target) {
            return false;
        }
        target.postMessage({ source: "tex64-pdf", payload }, "*");
        return true;
    };
    const ensurePdfFrame = () => {
        if (!(deps.editorViewerPdf instanceof HTMLIFrameElement)) {
            return;
        }
        const current = deps.editorViewerPdf.src;
        if (!current || !current.includes("pdf-viewer.html")) {
            pdfViewerReady = false;
            deps.editorViewerPdf.src = pdfViewerUrl;
        }
    };
    window.addEventListener("message", (event) => {
        var _a, _b, _c, _d, _e, _f, _g;
        if (!(deps.editorViewerPdf instanceof HTMLIFrameElement)) {
            return;
        }
        if (event.source !== deps.editorViewerPdf.contentWindow) {
            return;
        }
        const data = event.data;
        if (!data || data.source !== "tex64-pdf") {
            return;
        }
        const payload = data.payload;
        if (!payload || typeof payload.type !== "string") {
            return;
        }
        if (payload.type === "ready") {
            pdfViewerReady = true;
            if (pendingPdfOpen) {
                postPdfMessage({ type: "open", payload: pendingPdfOpen });
                pendingPdfOpen = null;
            }
            if (livePreview) {
                postPdfMessage({ type: "live", payload: livePreview });
            }
            if (pendingPdfSync) {
                postPdfMessage({ type: "sync", payload: pendingPdfSync });
                pendingPdfSync = null;
            }
            return;
        }
        if (payload.type === "reverse") {
            const detail = payload.payload;
            const page = typeof (detail === null || detail === void 0 ? void 0 : detail.page) === "number" ? detail.page : Number(detail === null || detail === void 0 ? void 0 : detail.page);
            const x = typeof (detail === null || detail === void 0 ? void 0 : detail.x) === "number" ? detail.x : Number(detail === null || detail === void 0 ? void 0 : detail.x);
            const y = typeof (detail === null || detail === void 0 ? void 0 : detail.y) === "number" ? detail.y : Number(detail === null || detail === void 0 ? void 0 : detail.y);
            if (!Number.isFinite(page) || !Number.isFinite(x) || !Number.isFinite(y)) {
                return;
            }
            const pdfPath = typeof (detail === null || detail === void 0 ? void 0 : detail.path) === "string" ? detail.path : null;
            (_a = deps.onPdfReverseRequest) === null || _a === void 0 ? void 0 : _a.call(deps, { page, x, y, pdfPath });
            return;
        }
        if (payload.type === "live-source") {
            const detail = payload.payload;
            const file = typeof (detail === null || detail === void 0 ? void 0 : detail.file) === "string" ? detail.file : "";
            const line = Number(detail === null || detail === void 0 ? void 0 : detail.line);
            const column = Number(detail === null || detail === void 0 ? void 0 : detail.column);
            if (file && Number.isFinite(line) && line >= 1) {
                (_b = deps.onLiveSourceRequest) === null || _b === void 0 ? void 0 : _b.call(deps, {
                    file,
                    line: Math.floor(line),
                    column: Number.isFinite(column) && column >= 1 ? Math.floor(column) : 1,
                });
            }
            return;
        }
        if (payload.type === "live-edit") {
            const detail = payload.payload;
            if (typeof (detail === null || detail === void 0 ? void 0 : detail.sessionId) === "string" &&
                (detail.kind === "text" || detail.kind === "math") &&
                typeof detail.file === "string" &&
                typeof detail.baseValue === "string" &&
                typeof detail.replacement === "string" &&
                typeof ((_c = detail.start) === null || _c === void 0 ? void 0 : _c.line) === "number" &&
                typeof ((_d = detail.start) === null || _d === void 0 ? void 0 : _d.column) === "number" &&
                typeof ((_e = detail.end) === null || _e === void 0 ? void 0 : _e.line) === "number" &&
                typeof ((_f = detail.end) === null || _f === void 0 ? void 0 : _f.column) === "number") {
                (_g = deps.onLiveEditRequest) === null || _g === void 0 ? void 0 : _g.call(deps, detail);
            }
        }
    });
    const clearViewerUrl = () => {
        if (viewerBlobUrl) {
            URL.revokeObjectURL(viewerBlobUrl);
            viewerBlobUrl = null;
        }
    };
    const setViewerMode = (mode) => {
        viewerMode = mode;
        if (deps.editorViewer instanceof HTMLElement) {
            deps.editorViewer.dataset.view = mode;
            const isVisible = mode !== "hidden";
            deps.editorViewer.classList.toggle("is-visible", isVisible);
            deps.editorViewer.setAttribute("aria-hidden", isVisible ? "false" : "true");
        }
        if (deps.editorHost instanceof HTMLElement) {
            deps.editorHost.classList.toggle("is-hidden", mode !== "hidden");
        }
    };
    const blurActiveElement = () => {
        const active = document.activeElement;
        if (active instanceof HTMLElement) {
            active.blur();
        }
    };
    const buildViewerBlobUrl = (data, mimeType) => {
        clearViewerUrl();
        const binary = window.atob(data);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) {
            bytes[i] = binary.charCodeAt(i);
        }
        const blob = new Blob([bytes], { type: mimeType });
        viewerBlobUrl = URL.createObjectURL(blob);
        return viewerBlobUrl;
    };
    const hideViewer = () => {
        clearViewerUrl();
        if (deps.editorViewerImage instanceof HTMLImageElement) {
            deps.editorViewerImage.removeAttribute("src");
        }
        if (deps.editorViewerPdf instanceof HTMLIFrameElement) {
            deps.editorViewerPdf.removeAttribute("src");
        }
        pdfViewerReady = false;
        pendingPdfOpen = null;
        pendingPdfSync = null;
        pdfViewerPath = null;
        setViewerMode("hidden");
    };
    const showUnsupportedViewer = (hint) => {
        clearViewerUrl();
        if (deps.editorViewerImage instanceof HTMLImageElement) {
            deps.editorViewerImage.removeAttribute("src");
        }
        if (deps.editorViewerPdf instanceof HTMLIFrameElement) {
            deps.editorViewerPdf.removeAttribute("src");
        }
        pdfViewerReady = false;
        pendingPdfOpen = null;
        pendingPdfSync = null;
        pdfViewerPath = null;
        if (deps.editorViewer instanceof HTMLElement) {
            const message = deps.editorViewer.querySelector(".editor-viewer-message");
            const existingHint = message === null || message === void 0 ? void 0 : message.querySelector(".editor-viewer-hint");
            if (hint && message) {
                const hintElement = existingHint !== null && existingHint !== void 0 ? existingHint : document.createElement("p");
                hintElement.className = "editor-viewer-hint";
                hintElement.textContent = hint;
                if (!existingHint) {
                    message.appendChild(hintElement);
                }
            }
            else {
                existingHint === null || existingHint === void 0 ? void 0 : existingHint.remove();
            }
        }
        setViewerMode("unsupported");
        blurActiveElement();
    };
    const showImageViewer = (path, data, mimeType) => {
        var _a;
        if (!data || !(deps.editorViewerImage instanceof HTMLImageElement)) {
            showUnsupportedViewer();
            return;
        }
        const resolvedMime = (_a = mimeType !== null && mimeType !== void 0 ? mimeType : IMAGE_MIME_TYPES.get(getFileExtension(path))) !== null && _a !== void 0 ? _a : "image/*";
        try {
            const url = buildViewerBlobUrl(data, resolvedMime);
            deps.editorViewerImage.src = url;
            setViewerMode("image");
            blurActiveElement();
        }
        catch {
            showUnsupportedViewer();
        }
    };
    const showPdfViewer = (path, data, mimeType) => {
        if (!data || !(deps.editorViewerPdf instanceof HTMLIFrameElement)) {
            showUnsupportedViewer();
            return;
        }
        try {
            const url = buildViewerBlobUrl(data, mimeType !== null && mimeType !== void 0 ? mimeType : "application/pdf");
            pdfViewerPath = path;
            ensurePdfFrame();
            const payload = { url, path };
            if (pdfViewerReady) {
                postPdfMessage({ type: "open", payload });
            }
            else {
                pendingPdfOpen = payload;
            }
            setViewerMode("pdf");
            blurActiveElement();
        }
        catch {
            showUnsupportedViewer();
        }
    };
    const syncPdf = (payload) => {
        if (!(deps.editorViewerPdf instanceof HTMLIFrameElement)) {
            return;
        }
        if (!pdfViewerReady) {
            pendingPdfSync = payload;
            return;
        }
        if (livePreview) {
            // The PDF frame may have been recreated while the tab was hidden.
            // Establish Live ownership synchronously before SyncTeX so the jump is
            // queued for the visible TDOM surface instead of the static fallback.
            postPdfMessage({ type: "live", payload: livePreview });
        }
        postPdfMessage({ type: "sync", payload });
    };
    const setLivePreview = (url, generation = 0) => {
        const next = url ? { url, generation } : null;
        if ((livePreview === null || livePreview === void 0 ? void 0 : livePreview.url) === (next === null || next === void 0 ? void 0 : next.url) && (livePreview === null || livePreview === void 0 ? void 0 : livePreview.generation) === (next === null || next === void 0 ? void 0 : next.generation))
            return;
        livePreview = next;
        if (pdfViewerReady) {
            postPdfMessage({ type: "live", payload: next });
        }
    };
    return {
        hideViewer,
        showImageViewer,
        showPdfViewer,
        showUnsupportedViewer,
        setViewerMode,
        getViewerMode: () => viewerMode,
        getPdfPath: () => pdfViewerPath,
        syncPdf,
        setLivePreview,
    };
};
