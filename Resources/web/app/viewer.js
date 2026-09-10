import { IMAGE_MIME_TYPES, getFileExtension } from "./files.js";
const pdfSourceStates = new Map();
const pdfSourceListeners = new Set();
let activePdfWorkspace = null;
const normalizedPdfPath = (value) => value.replace(/\\/g, "/").replace(/\/$/, "");
export const updatePdfSourceState = (value, activeWorkspace = false) => {
    const payload = value;
    if (!payload || (payload.rootPath !== null && typeof payload.rootPath !== "string"))
        return;
    const root = payload.rootPath ? normalizedPdfPath(payload.rootPath) : null;
    if (activeWorkspace)
        activePdfWorkspace = root;
    if (root)
        pdfSourceStates.set(root, {
            rootPath: root,
            requiresRebuild: payload.requiresRebuild === true,
            rebuiltPaths: Array.isArray(payload.rebuiltPaths) ? payload.rebuiltPaths.filter((p) => typeof p === "string").map(normalizedPdfPath) : [],
        });
    for (const listener of pdfSourceListeners)
        listener();
};
const livePdfPath = (path, workspaceRoot) => {
    let value = path.replace(/\\/g, "/");
    if (!/^(?:\/|[A-Za-z]:\/)/.test(value) && workspaceRoot) {
        value = `${workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "")}/${value}`;
    }
    const parts = [];
    for (const part of value.split("/")) {
        if (part === ".")
            continue;
        if (part === ".." && parts.length && parts[parts.length - 1] !== "..") {
            if (parts[parts.length - 1] !== "")
                parts.pop();
        }
        else
            parts.push(part);
    }
    return parts.join("/");
};
export const createViewer = (deps) => {
    let viewerBlobUrl = null;
    let viewerMode = "hidden";
    let pdfViewerReady = false;
    let pdfViewerPath = null;
    let pdfWorkspaceRoot = null;
    let pendingPdfOpen = null;
    let pendingPdfSync = null;
    // Real-time preview: when set, the pdf viewer swaps its page canvas for the
    // live engine frame (same chrome). Re-sent on every viewer "ready" so it
    // survives the pdf iframe being torn down and recreated. `hold` keeps the
    // same engine frame alive below a Build-owned static PDF; it is part of
    // this state rather than a one-shot message so a viewer that becomes ready
    // later still receives it. `expectedSrcRev` is the revision the engine
    // accepted for the first change after that Build.
    let livePreview = null;
    const pdfViewerUrl = new URL("pdf-viewer.html", window.location.href).toString();
    const matchingLivePreview = () => livePreview && pdfViewerPath &&
        livePdfPath(pdfViewerPath, livePreview.target.workspaceRoot) ===
            livePdfPath(livePreview.target.pdfPath, livePreview.target.workspaceRoot)
        ? livePreview : null;
    const needsPdfRebuild = () => {
        if (!pdfWorkspaceRoot || !pdfViewerPath)
            return false;
        const status = pdfSourceStates.get(pdfWorkspaceRoot);
        if (!(status === null || status === void 0 ? void 0 : status.requiresRebuild))
            return false;
        const name = normalizedPdfPath(pdfViewerPath);
        const absolute = name.startsWith("/") || /^[A-Za-z]:\//.test(name)
            ? name : `${pdfWorkspaceRoot}/${name.replace(/^\.\//, "")}`;
        if (!absolute.startsWith(`${pdfWorkspaceRoot}/`) || absolute.split("/").includes(".."))
            return false;
        return !status.rebuiltPaths.includes(absolute);
    };
    const postPdfMessage = (payload) => {
        if (!(deps.editorViewerPdf instanceof HTMLIFrameElement)) {
            return false;
        }
        const target = deps.editorViewerPdf.contentWindow;
        if (!target) {
            return false;
        }
        if (payload.type === "open")
            payload = { ...payload, payload: { ...payload.payload, needsRebuild: needsPdfRebuild() } };
        target.postMessage({ source: "tex64-pdf", payload }, "*");
        return true;
    };
    pdfSourceListeners.add(() => {
        if (pdfViewerReady && pdfViewerPath)
            postPdfMessage({ type: "source-state", payload: { path: pdfViewerPath, needsRebuild: needsPdfRebuild() } });
    });
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
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m;
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
            postPdfMessage({ type: "live", payload: matchingLivePreview() });
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
        if (payload.type === "ask-axiom") {
            const detail = payload.payload;
            const page = Number(detail === null || detail === void 0 ? void 0 : detail.page);
            const x = Number(detail === null || detail === void 0 ? void 0 : detail.x);
            const y = Number(detail === null || detail === void 0 ? void 0 : detail.y);
            const rawSource = detail === null || detail === void 0 ? void 0 : detail.source;
            const source = rawSource && typeof rawSource.file === "string" && Number.isFinite(Number(rawSource.line))
                ? { file: rawSource.file, line: Number(rawSource.line), column: Number.isFinite(Number(rawSource.column)) ? Number(rawSource.column) : 1 }
                : null;
            if (!Number.isFinite(page) || (!source && (!Number.isFinite(x) || !Number.isFinite(y))))
                return;
            (_b = deps.onPdfAskAxiom) === null || _b === void 0 ? void 0 : _b.call(deps, {
                page,
                x: Number.isFinite(x) ? x : 0,
                y: Number.isFinite(y) ? y : 0,
                text: typeof (detail === null || detail === void 0 ? void 0 : detail.text) === "string" ? detail.text : "",
                pdfPath: typeof (detail === null || detail === void 0 ? void 0 : detail.path) === "string" ? detail.path : null,
                ...(source ? { source } : {}),
            });
            return;
        }
        if (payload.type === "live-source") {
            if (!matchingLivePreview())
                return;
            const detail = payload.payload;
            const file = typeof (detail === null || detail === void 0 ? void 0 : detail.file) === "string" ? detail.file : "";
            const line = Number(detail === null || detail === void 0 ? void 0 : detail.line);
            const column = Number(detail === null || detail === void 0 ? void 0 : detail.column);
            if (file && Number.isFinite(line) && line >= 1) {
                (_c = deps.onLiveSourceRequest) === null || _c === void 0 ? void 0 : _c.call(deps, {
                    file,
                    line: Math.floor(line),
                    column: Number.isFinite(column) && column >= 1 ? Math.floor(column) : 1,
                });
            }
            return;
        }
        if (payload.type === "live-edit-anchor") {
            const requestedPreview = matchingLivePreview();
            if (!requestedPreview)
                return;
            const detail = payload.payload;
            if (!detail || typeof detail.sessionId !== "string" || !detail.sessionId ||
                typeof detail.requestId !== "string" || !detail.requestId ||
                typeof detail.activationId !== "string" || !detail.activationId ||
                !Number.isInteger(detail.documentEpoch) ||
                typeof detail.file !== "string" || !detail.file ||
                typeof detail.baseValue !== "string" || typeof detail.sourceText !== "string" ||
                !Number.isInteger(detail.sourceRev) ||
                ![(_d = detail.start) === null || _d === void 0 ? void 0 : _d.line, (_e = detail.start) === null || _e === void 0 ? void 0 : _e.column, (_f = detail.end) === null || _f === void 0 ? void 0 : _f.line, (_g = detail.end) === null || _g === void 0 ? void 0 : _g.column]
                    .every((value) => typeof value === "number" && Number.isInteger(value) && value >= 1))
                return;
            const request = detail;
            const reply = (result) => {
                if (matchingLivePreview() !== requestedPreview)
                    return;
                postPdfMessage({ type: "live-edit-anchor-result", payload: result });
            };
            if (deps.onLiveEditAnchorRequest)
                deps.onLiveEditAnchorRequest(request, reply);
            else
                reply({
                    sessionId: request.sessionId,
                    requestId: request.requestId,
                    activationId: request.activationId,
                    documentEpoch: request.documentEpoch,
                    sourceRev: request.sourceRev,
                    file: request.file,
                    ok: false,
                });
            return;
        }
        if (payload.type === "live-edit") {
            if (!matchingLivePreview())
                return;
            const detail = payload.payload;
            const startLine = Number((_h = detail === null || detail === void 0 ? void 0 : detail.start) === null || _h === void 0 ? void 0 : _h.line);
            const startColumn = Number((_j = detail === null || detail === void 0 ? void 0 : detail.start) === null || _j === void 0 ? void 0 : _j.column);
            const endLine = Number((_k = detail === null || detail === void 0 ? void 0 : detail.end) === null || _k === void 0 ? void 0 : _k.line);
            const endColumn = Number((_l = detail === null || detail === void 0 ? void 0 : detail.end) === null || _l === void 0 ? void 0 : _l.column);
            if (typeof (detail === null || detail === void 0 ? void 0 : detail.sessionId) === "string" &&
                detail.sessionId.length > 0 &&
                (detail.kind === "text" || detail.kind === "math") &&
                typeof detail.file === "string" &&
                detail.file.length > 0 &&
                typeof detail.baseValue === "string" &&
                typeof detail.replacement === "string" &&
                Number.isFinite(startLine) && startLine >= 1 &&
                Number.isFinite(startColumn) && startColumn >= 1 &&
                Number.isFinite(endLine) && endLine >= 1 &&
                Number.isFinite(endColumn) && endColumn >= 1) {
                (_m = deps.onLiveEditRequest) === null || _m === void 0 ? void 0 : _m.call(deps, {
                    ...detail,
                    sourceText: typeof detail.sourceText === "string" ? detail.sourceText : undefined,
                    start: { line: Math.floor(startLine), column: Math.floor(startColumn) },
                    end: { line: Math.floor(endLine), column: Math.floor(endColumn) },
                });
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
            pdfWorkspaceRoot = activePdfWorkspace;
            ensurePdfFrame();
            const payload = { url, path };
            if (pdfViewerReady) {
                // A different PDF tab cannot inherit this project's root paper or
                // send direct edits through it, even before the next preview poll.
                postPdfMessage({ type: "live", payload: matchingLivePreview() });
                postPdfMessage({ type: "open", payload });
                if (!(pendingPdfSync === null || pendingPdfSync === void 0 ? void 0 : pendingPdfSync.pdfPath) || pendingPdfSync.pdfPath === path) {
                    if (pendingPdfSync) {
                        postPdfMessage({ type: "sync", payload: pendingPdfSync });
                        pendingPdfSync = null;
                    }
                }
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
        if (!pdfViewerReady ||
            (payload.pdfPath !== undefined && payload.pdfPath !== pdfViewerPath)) {
            pendingPdfSync = payload;
            ensurePdfFrame();
            return;
        }
        const preview = matchingLivePreview();
        if (preview) {
            // The PDF frame may have been recreated while the tab was hidden.
            // Establish Live ownership synchronously before SyncTeX so the jump is
            // queued for the visible TDOM surface instead of the static fallback.
            postPdfMessage({ type: "live", payload: preview });
        }
        postPdfMessage({ type: "sync", payload });
    };
    const setLivePreview = (url, generation = 0, target = null, hold = false, expectedSrcRev = null) => {
        const next = url && target ? { url, generation, target, hold, expectedSrcRev } : null;
        if ((livePreview === null || livePreview === void 0 ? void 0 : livePreview.url) === (next === null || next === void 0 ? void 0 : next.url) && (livePreview === null || livePreview === void 0 ? void 0 : livePreview.generation) === (next === null || next === void 0 ? void 0 : next.generation) &&
            (livePreview === null || livePreview === void 0 ? void 0 : livePreview.hold) === (next === null || next === void 0 ? void 0 : next.hold) && (livePreview === null || livePreview === void 0 ? void 0 : livePreview.expectedSrcRev) === (next === null || next === void 0 ? void 0 : next.expectedSrcRev) &&
            (livePreview === null || livePreview === void 0 ? void 0 : livePreview.target.workspaceRoot) === (next === null || next === void 0 ? void 0 : next.target.workspaceRoot) &&
            (livePreview === null || livePreview === void 0 ? void 0 : livePreview.target.pdfPath) === (next === null || next === void 0 ? void 0 : next.target.pdfPath))
            return;
        livePreview = next;
        if (pdfViewerReady) {
            postPdfMessage({ type: "live", payload: matchingLivePreview() });
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
