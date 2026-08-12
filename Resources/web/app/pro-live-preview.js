export const PRO_LIVE_STORAGE_KEY = "tex64.proLivePreview.v1";
export const buildFullReplacementEdit = (previous, next) => ({
    start: 0,
    end: previous.length,
    text: next,
});
export const createDebouncedTask = (task, delayMs = 300) => {
    let timer = null;
    const schedule = () => {
        if (timer)
            clearTimeout(timer);
        timer = setTimeout(() => { timer = null; task(); }, delayMs);
    };
    schedule.cancel = () => { if (timer)
        clearTimeout(timer); timer = null; };
    return schedule;
};
export const initProLivePreview = ({ getActiveGroup }) => {
    const button = document.getElementById("pro-preview-live-toggle");
    const status = document.getElementById("pro-preview-live-status");
    const liveFrame = document.getElementById("pro-preview-live");
    const staticViewer = document.getElementById("pro-preview-viewer");
    if (!(button instanceof HTMLButtonElement) || !(liveFrame instanceof HTMLIFrameElement))
        return null;
    const bridge = window.tex64Fermion;
    let enabled = localStorage.getItem(PRO_LIVE_STORAGE_KEY) === "true";
    let boundEditor = null;
    let boundPath = null;
    let disposable = null;
    let lastSource = "";
    let pushChain = Promise.resolve();
    const setStatus = (message = "", error = false) => {
        if (!status)
            return;
        status.textContent = message;
        status.classList.toggle("is-error", error);
    };
    const applyVisibility = () => {
        button.classList.toggle("is-active", enabled);
        button.setAttribute("aria-pressed", String(enabled));
        liveFrame.classList.toggle("is-visible", enabled);
        liveFrame.setAttribute("aria-hidden", String(!enabled));
        staticViewer === null || staticViewer === void 0 ? void 0 : staticViewer.classList.toggle("is-live-hidden", enabled);
    };
    const currentTex = () => {
        const group = getActiveGroup();
        const path = group.currentFilePath;
        const editor = group.editor;
        if (!(path === null || path === void 0 ? void 0 : path.toLowerCase().endsWith(".tex")) || !(editor === null || editor === void 0 ? void 0 : editor.getValue))
            return null;
        return { path, editor, source: editor.getValue() };
    };
    const pushCurrent = () => {
        if (!enabled || !(bridge === null || bridge === void 0 ? void 0 : bridge.push))
            return;
        const current = currentTex();
        if (!current || (current.path === boundPath && current.source === lastSource))
            return;
        const edit = buildFullReplacementEdit(lastSource, current.source);
        lastSource = current.source;
        pushChain = pushChain.then(async () => {
            const result = await bridge.push({ source: current.source, edit });
            if (!(result === null || result === void 0 ? void 0 : result.ok))
                throw new Error((result === null || result === void 0 ? void 0 : result.error) || "Live preview update failed");
            if (result.url && liveFrame.src !== `${result.url}/`)
                liveFrame.src = result.url;
            setStatus("");
        }).catch((error) => setStatus((error === null || error === void 0 ? void 0 : error.message) || String(error), true));
    };
    const debouncedPush = createDebouncedTask(pushCurrent, 300);
    const bindActiveEditor = () => {
        var _a, _b;
        if (!enabled)
            return;
        const current = currentTex();
        const nextEditor = (_a = current === null || current === void 0 ? void 0 : current.editor) !== null && _a !== void 0 ? _a : null;
        const nextPath = (_b = current === null || current === void 0 ? void 0 : current.path) !== null && _b !== void 0 ? _b : null;
        if (nextEditor === boundEditor && nextPath === boundPath)
            return;
        disposable === null || disposable === void 0 ? void 0 : disposable.dispose();
        disposable = null;
        boundEditor = nextEditor;
        boundPath = nextPath;
        lastSource = "";
        if (boundEditor === null || boundEditor === void 0 ? void 0 : boundEditor.onDidChangeModelContent)
            disposable = boundEditor.onDidChangeModelContent(debouncedPush);
        debouncedPush();
    };
    const start = async () => {
        if (!(bridge === null || bridge === void 0 ? void 0 : bridge.start)) {
            enabled = false;
            applyVisibility();
            setStatus("Live preview service is unavailable.", true);
            return;
        }
        setStatus("Starting…");
        const result = await bridge.start();
        if (!(result === null || result === void 0 ? void 0 : result.ok) || !result.url) {
            enabled = false;
            localStorage.setItem(PRO_LIVE_STORAGE_KEY, "false");
            applyVisibility();
            setStatus((result === null || result === void 0 ? void 0 : result.error) || "Live preview failed to start.", true);
            return;
        }
        liveFrame.src = result.url;
        setStatus(result.backend ? `Live · ${result.backend}` : "Live");
        bindActiveEditor();
    };
    const setEnabled = (next) => {
        enabled = next;
        localStorage.setItem(PRO_LIVE_STORAGE_KEY, String(enabled));
        applyVisibility();
        if (enabled)
            void start();
        else {
            debouncedPush.cancel();
            disposable === null || disposable === void 0 ? void 0 : disposable.dispose();
            disposable = null;
            boundEditor = null;
            boundPath = null;
            setStatus("");
        }
    };
    button.addEventListener("click", () => setEnabled(!enabled));
    const poll = window.setInterval(bindActiveEditor, 200);
    window.addEventListener("beforeunload", () => window.clearInterval(poll), { once: true });
    applyVisibility();
    if (enabled)
        void start();
    return { isEnabled: () => enabled, setEnabled };
};
