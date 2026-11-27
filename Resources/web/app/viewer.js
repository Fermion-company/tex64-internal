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
export const parseLiveSourceRequest = (value) => {
    const payload = value;
    const file = typeof (payload === null || payload === void 0 ? void 0 : payload.file) === "string" ? payload.file : "";
    const line = Number(payload === null || payload === void 0 ? void 0 : payload.line);
    const column = Number(payload === null || payload === void 0 ? void 0 : payload.column);
    if (!file || !Number.isFinite(line) || line < 1)
        return null;
    return {
        file,
        line: Math.floor(line),
        column: Number.isFinite(column) && column >= 1 ? Math.floor(column) : 1,
    };
};
export const parseLiveAnchorRequest = (value) => {
    var _a, _b, _c, _d;
    const payload = value;
    if (!payload || typeof payload.sessionId !== "string" || !payload.sessionId ||
        typeof payload.requestId !== "string" || !payload.requestId ||
        typeof payload.activationId !== "string" || !payload.activationId ||
        !Number.isInteger(payload.documentEpoch) ||
        typeof payload.file !== "string" || !payload.file ||
        typeof payload.baseValue !== "string" || typeof payload.sourceText !== "string" ||
        !Number.isInteger(payload.sourceRev) ||
        ![(_a = payload.start) === null || _a === void 0 ? void 0 : _a.line, (_b = payload.start) === null || _b === void 0 ? void 0 : _b.column, (_c = payload.end) === null || _c === void 0 ? void 0 : _c.line, (_d = payload.end) === null || _d === void 0 ? void 0 : _d.column]
            .every((item) => typeof item === "number" && Number.isInteger(item) && item >= 1))
        return null;
    return payload;
};
export const parseLiveEditRequest = (value) => {
    var _a, _b, _c, _d;
    const payload = value;
    const startLine = Number((_a = payload === null || payload === void 0 ? void 0 : payload.start) === null || _a === void 0 ? void 0 : _a.line);
    const startColumn = Number((_b = payload === null || payload === void 0 ? void 0 : payload.start) === null || _b === void 0 ? void 0 : _b.column);
    const endLine = Number((_c = payload === null || payload === void 0 ? void 0 : payload.end) === null || _c === void 0 ? void 0 : _c.line);
    const endColumn = Number((_d = payload === null || payload === void 0 ? void 0 : payload.end) === null || _d === void 0 ? void 0 : _d.column);
    if (typeof (payload === null || payload === void 0 ? void 0 : payload.sessionId) !== "string" || !payload.sessionId ||
        (payload.kind !== "text" && payload.kind !== "math") ||
        typeof payload.file !== "string" || !payload.file ||
        typeof payload.baseValue !== "string" || typeof payload.replacement !== "string" ||
        !Number.isFinite(startLine) || startLine < 1 ||
        !Number.isFinite(startColumn) || startColumn < 1 ||
        !Number.isFinite(endLine) || endLine < 1 ||
        !Number.isFinite(endColumn) || endColumn < 1)
        return null;
    return {
        ...payload,
        sourceText: typeof payload.sourceText === "string" ? payload.sourceText : undefined,
        start: { line: Math.floor(startLine), column: Math.floor(startColumn) },
        end: { line: Math.floor(endLine), column: Math.floor(endColumn) },
    };
};
export const createViewer = (deps) => {
    let viewerBlobUrl = null;
    let viewerMode = "hidden";
    let pdfViewerReady = false;
    let pdfViewerPath = null;
    let savedPdfRemoved = false;
    let pdfWorkspaceRoot = null;
    let pendingPdfSync = null;
    let pdfBuildPreview = null;
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
    let fallbackPaper = null;
    let sentFallbackPaper = null;
    const matchingFallbackPaper = () => {
        if (!pdfViewerPath || !fallbackPaper)
            return null;
        const { target } = fallbackPaper;
        const root = target.workspaceRoot ? normalizedPdfPath(target.workspaceRoot) : null;
        return root === pdfWorkspaceRoot &&
            livePdfPath(target.pdfPath, target.workspaceRoot) === livePdfPath(pdfViewerPath, pdfWorkspaceRoot) ? fallbackPaper : null;
    };
    const sendFallbackPaper = () => {
        const paper = matchingFallbackPaper();
        if (!pdfViewerReady || !paper || sentFallbackPaper === paper)
            return;
        if (postPdfMessage({ type: "preview-open", payload: {
                path: pdfViewerPath, data: paper.data, url: paper.url, generation: paper.generation,
            } }))
            sentFallbackPaper = paper;
    };
    const matchingBuildPreview = () => {
        var _a;
        if (!(pdfBuildPreview === null || pdfBuildPreview === void 0 ? void 0 : pdfBuildPreview.pdfPath) || !pdfViewerPath)
            return null;
        if (pdfBuildPreview.workspaceRoot &&
            pdfWorkspaceRoot &&
            livePdfPath(pdfBuildPreview.workspaceRoot, null) !== livePdfPath(pdfWorkspaceRoot, null))
            return null;
        const root = (_a = pdfBuildPreview.workspaceRoot) !== null && _a !== void 0 ? _a : pdfWorkspaceRoot;
        return livePdfPath(pdfViewerPath, root) === livePdfPath(pdfBuildPreview.pdfPath, root)
            ? pdfBuildPreview
            : null;
    };
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
        if (payload.type === "open") {
            const paper = matchingFallbackPaper();
            if (!paper)
                sentFallbackPaper = null;
            payload = { ...payload, payload: { ...payload.payload,
                    previewGeneration: paper === null || paper === void 0 ? void 0 : paper.generation, needsRebuild: needsPdfRebuild() } };
        }
        target.postMessage({ source: "tex64-pdf", payload }, "*");
        return true;
    };
    pdfSourceListeners.add(() => {
        if (pdfViewerReady && pdfViewerPath)
            postPdfMessage({ type: "source-state", payload: { path: pdfViewerPath, needsRebuild: needsPdfRebuild() } });
    });
    window.addEventListener("tex64:build-state", (event) => {
        const detail = event.detail;
        if (!detail || typeof detail.state !== "string")
            return;
        const wasMatching = matchingBuildPreview();
        pdfBuildPreview = detail;
        if (pdfViewerReady) {
            const buildPreview = matchingBuildPreview();
            if (buildPreview)
                postPdfMessage({ type: "build-state", payload: buildPreview });
            else if (wasMatching)
                postPdfMessage({ type: "build-state", payload: { state: "idle" } });
        }
    });
    const fallbackMath = (request) => {
        var _a, _b, _c;
        return (_b = (_a = window.tex64Tdom) === null || _a === void 0 ? void 0 : _a.fallbackMath) === null || _b === void 0 ? void 0 : _b.call(_a, {
            ...request, secondary: ((_c = deps.editorViewerPdf) === null || _c === void 0 ? void 0 : _c.id) === "editor-viewer-pdf-secondary",
        });
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
        var _a, _b, _c, _d, _e, _f, _g, _h;
        if (!(deps.editorViewerPdf instanceof HTMLIFrameElement)) {
            return;
        }
        if (!deps.editorViewerPdf.src || event.source !== deps.editorViewerPdf.contentWindow) {
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
        if (payload.type === "fallback-math") {
            const port = event.ports[0];
            if (port) {
                const request = payload.payload;
                void Promise.resolve(request && typeof request === "object" ? fallbackMath(request) : null).then(result => port.postMessage(result), () => port.postMessage({ ok: false })).finally(() => port.close());
            }
            return;
        }
        if (payload.type === "ready") {
            sentFallbackPaper = null;
            pdfViewerReady = true;
            if (pdfViewerPath) {
                // A reloaded frame has lost both its saved PDF and its live generation.
                postPdfMessage({ type: "open", payload: { path: pdfViewerPath,
                        url: savedPdfRemoved ? undefined : viewerBlobUrl !== null && viewerBlobUrl !== void 0 ? viewerBlobUrl : undefined } });
                sendFallbackPaper();
            }
            postPdfMessage({ type: "live", payload: matchingLivePreview() });
            const buildPreview = matchingBuildPreview();
            postPdfMessage({ type: "build-state", payload: buildPreview !== null && buildPreview !== void 0 ? buildPreview : { state: "idle" } });
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
            const rawContext = detail === null || detail === void 0 ? void 0 : detail.context;
            const text = (value) => (typeof value === "string" && value.length <= 64 ? value : null);
            const context = rawContext && text(rawContext.word)
                ? { word: text(rawContext.word), prev: text(rawContext.prev), next: text(rawContext.next) }
                : undefined;
            const fallbackGeneration = typeof (detail === null || detail === void 0 ? void 0 : detail.fallbackGeneration) === "number" ? detail.fallbackGeneration : undefined;
            (_a = deps.onPdfReverseRequest) === null || _a === void 0 ? void 0 : _a.call(deps, { page, x, y, pdfPath, fallbackGeneration, ...(context ? { context } : {}) });
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
        if (payload.type === "close") {
            (_c = deps.onPdfClose) === null || _c === void 0 ? void 0 : _c.call(deps);
            return;
        }
        if (payload.type === "live-empty-error") {
            const preview = matchingLivePreview();
            if (preview && !preview.hold)
                (_d = deps.onEmptyLiveError) === null || _d === void 0 ? void 0 : _d.call(deps, payload.payload);
            return;
        }
        if (payload.type === "live-runtime-error") {
            if (!matchingLivePreview())
                return;
            const error = payload.payload;
            if (error == null)
                (_e = deps.onLiveRuntimeError) === null || _e === void 0 ? void 0 : _e.call(deps, null);
            else if ((error.code === "TDOM_SHIM_UNAVAILABLE" || error.code === "TDOM_STRUCTURED_BOOT_FAILED" || error.code === "TDOM_TEX_ERROR") &&
                typeof error.message === "string" && error.message.trim()) {
                (_f = deps.onLiveRuntimeError) === null || _f === void 0 ? void 0 : _f.call(deps, error.message);
            }
            return;
        }
        if (payload.type === "live-source") {
            if (!matchingLivePreview())
                return;
            const request = parseLiveSourceRequest(payload.payload);
            if (request)
                (_g = deps.onLiveSourceRequest) === null || _g === void 0 ? void 0 : _g.call(deps, request);
            return;
        }
        if (payload.type === "live-edit-anchor") {
            const requestedPreview = matchingLivePreview();
            if (!requestedPreview)
                return;
            const request = parseLiveAnchorRequest(payload.payload);
            if (!request)
                return;
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
            const request = parseLiveEditRequest(payload.payload);
            if (request)
                (_h = deps.onLiveEditRequest) === null || _h === void 0 ? void 0 : _h.call(deps, request);
        }
    });
    const clearViewerUrl = () => {
        var _a;
        (_a = deps.onLiveRuntimeError) === null || _a === void 0 ? void 0 : _a.call(deps, null);
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
    const clearPdfFrame = () => {
        var _a;
        if (deps.editorViewerPdf instanceof HTMLIFrameElement && deps.editorViewerPdf.src) {
            void ((_a = fallbackMath({ action: "view", displayed: null, loading: null })) === null || _a === void 0 ? void 0 : _a.catch(() => { }));
            deps.editorViewerPdf.removeAttribute("src");
        }
        pdfViewerReady = false;
        sentFallbackPaper = null;
        pendingPdfSync = null;
        pdfViewerPath = null;
        pdfWorkspaceRoot = null;
    };
    const clearViewerContent = () => {
        clearViewerUrl();
        if (deps.editorViewerImage instanceof HTMLImageElement) {
            deps.editorViewerImage.removeAttribute("src");
        }
        clearPdfFrame();
    };
    const hideViewer = () => {
        clearViewerContent();
        setViewerMode("hidden");
    };
    const showUnsupportedViewer = (hint) => {
        clearViewerContent();
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
            clearPdfFrame();
            deps.editorViewerImage.src = url;
            setViewerMode("image");
            blurActiveElement();
        }
        catch {
            showUnsupportedViewer();
        }
    };
    const showPdfViewer = (path, data, mimeType, preserveFocus = false) => {
        if (!data || !(deps.editorViewerPdf instanceof HTMLIFrameElement)) {
            showUnsupportedViewer();
            return;
        }
        try {
            const url = buildViewerBlobUrl(data, mimeType !== null && mimeType !== void 0 ? mimeType : "application/pdf");
            savedPdfRemoved = false;
            pdfViewerPath = path;
            pdfWorkspaceRoot = activePdfWorkspace;
            ensurePdfFrame();
            const payload = { url, path };
            if (pdfViewerReady) {
                // A different PDF tab cannot inherit this project's root paper or
                // send direct edits through it, even before the next preview poll.
                postPdfMessage({ type: "live", payload: matchingLivePreview() });
                postPdfMessage({ type: "open", payload });
                sendFallbackPaper();
                const buildPreview = matchingBuildPreview();
                postPdfMessage({ type: "build-state", payload: buildPreview !== null && buildPreview !== void 0 ? buildPreview : { state: "idle" } });
                if (!(pendingPdfSync === null || pendingPdfSync === void 0 ? void 0 : pendingPdfSync.pdfPath) || pendingPdfSync.pdfPath === path) {
                    if (pendingPdfSync) {
                        postPdfMessage({ type: "sync", payload: pendingPdfSync });
                        pendingPdfSync = null;
                    }
                }
            }
            setViewerMode("pdf");
            if (!preserveFocus)
                blurActiveElement();
        }
        catch {
            showUnsupportedViewer();
        }
    };
    // First paper of a manuscript. Its PDF name identifies the tab, but
    // nothing on disk exists to open. Keep keyboard focus in the source.
    const showUnbuiltPdf = (path) => {
        clearViewerContent();
        pdfViewerPath = path;
        pdfWorkspaceRoot = activePdfWorkspace;
        ensurePdfFrame();
        setViewerMode("pdf");
    };
    const showFallbackPreview = (target, data, generation, url) => {
        fallbackPaper = target && (data || url) ? { target, data, generation, url } : null;
        if (fallbackPaper)
            sendFallbackPaper();
        else {
            sentFallbackPaper = null;
            if (pdfViewerReady && pdfViewerPath)
                postPdfMessage({ type: "preview-open", payload: null });
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
        var _a;
        const next = url && target ? { url, generation, target, hold, expectedSrcRev } : null;
        if ((livePreview === null || livePreview === void 0 ? void 0 : livePreview.url) === (next === null || next === void 0 ? void 0 : next.url) && (livePreview === null || livePreview === void 0 ? void 0 : livePreview.generation) === (next === null || next === void 0 ? void 0 : next.generation) &&
            (livePreview === null || livePreview === void 0 ? void 0 : livePreview.hold) === (next === null || next === void 0 ? void 0 : next.hold) && (livePreview === null || livePreview === void 0 ? void 0 : livePreview.expectedSrcRev) === (next === null || next === void 0 ? void 0 : next.expectedSrcRev) &&
            (livePreview === null || livePreview === void 0 ? void 0 : livePreview.target.workspaceRoot) === (next === null || next === void 0 ? void 0 : next.target.workspaceRoot) &&
            (livePreview === null || livePreview === void 0 ? void 0 : livePreview.target.pdfPath) === (next === null || next === void 0 ? void 0 : next.target.pdfPath))
            return;
        if ((livePreview === null || livePreview === void 0 ? void 0 : livePreview.url) !== (next === null || next === void 0 ? void 0 : next.url) || (livePreview === null || livePreview === void 0 ? void 0 : livePreview.generation) !== (next === null || next === void 0 ? void 0 : next.generation) ||
            (livePreview === null || livePreview === void 0 ? void 0 : livePreview.target.workspaceRoot) !== (next === null || next === void 0 ? void 0 : next.target.workspaceRoot) ||
            (livePreview === null || livePreview === void 0 ? void 0 : livePreview.target.pdfPath) !== (next === null || next === void 0 ? void 0 : next.target.pdfPath))
            (_a = deps.onLiveRuntimeError) === null || _a === void 0 ? void 0 : _a.call(deps, null);
        livePreview = next;
        if (pdfViewerReady) {
            postPdfMessage({ type: "live", payload: matchingLivePreview() });
        }
    };
    return {
        hideViewer,
        showImageViewer,
        showPdfViewer,
        showUnbuiltPdf,
        markSavedPdfRemoved: () => { savedPdfRemoved = true; },
        getUnbuiltPdfPath: () => viewerMode === "pdf" && (!viewerBlobUrl || savedPdfRemoved) ? pdfViewerPath : null,
        showFallbackPreview,
        showUnsupportedViewer,
        setViewerMode,
        getViewerMode: () => viewerMode,
        getPdfPath: () => pdfViewerPath,
        // True while keyboard focus is inside this group's PDF (or its Live frame).
        hasPdfFocus: () => viewerMode === "pdf" &&
            deps.editorViewerPdf instanceof HTMLIFrameElement &&
            document.activeElement === deps.editorViewerPdf,
        openPdfFind: () => viewerMode === "pdf" && pdfViewerReady && postPdfMessage({ type: "find-open" }),
        syncPdf,
        setLivePreview,
    };
};
