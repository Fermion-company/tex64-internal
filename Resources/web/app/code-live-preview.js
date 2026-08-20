// Real-time preview for Code mode (beta, settings > Build > Preview).
//
// The preview REPLACES the display inside the surfaces that already show the
// built PDF — the in-tab pdf viewer (viewer.ts → pdf-viewer.html) and the
// separate PDF window — it adds no pane of its own. While the
// `preview.realtime` flag is on and the app is in Code mode, this module
// starts the local TDOM engine, streams the active .tex buffer to it as the
// user types, and flips those viewers into live mode; each viewer swaps only
// its page canvas for the engine's embedded client, keeping its own toolbar
// and chrome. Turning the flag off restores the static PDF everywhere and
// stops the engine.
import { editorSettings } from "./editor-settings/editor-settings-store.js";
import { createDebouncedTask } from "./pro-live-preview.js";
export const initCodeLivePreview = ({ getActiveGroup, getEditorGroups, getAppMode, }) => {
    const bridge = window.tex64Tdom;
    let active = false;
    let starting = false;
    let engineUrl = null;
    let distributedUrl = null;
    let boundEditor = null;
    let boundPath = null;
    let pushedPath = null;
    let disposable = null;
    let lastSource = null;
    let pushChain = Promise.resolve();
    // Flip every PDF surface (both editor groups' viewers + the separate PDF
    // window) into or out of live mode. Idempotent; the surfaces themselves
    // re-apply the state when they (re)open.
    const distributeLive = (url) => {
        var _a;
        if (distributedUrl === url)
            return;
        distributedUrl = url;
        for (const group of getEditorGroups()) {
            group.viewer.setLivePreview(url);
        }
        void ((_a = bridge === null || bridge === void 0 ? void 0 : bridge.windowLive) === null || _a === void 0 ? void 0 : _a.call(bridge, { url }));
    };
    const currentTex = () => {
        const group = getActiveGroup();
        const path = group.currentFilePath;
        const editor = group.editor;
        if (!(path === null || path === void 0 ? void 0 : path.toLowerCase().endsWith(".tex")) || !(editor === null || editor === void 0 ? void 0 : editor.getValue))
            return null;
        return { group, path, editor };
    };
    const pushCurrent = () => {
        var _a, _b, _c;
        if (!active || !(bridge === null || bridge === void 0 ? void 0 : bridge.push))
            return;
        const current = currentTex();
        if (!current)
            return;
        // Never push mid-IME-composition: the buffer is transient and a typeset
        // per composition keystroke is wasted work. Try again after the debounce.
        if (current.group.isComposing) {
            debouncedPush();
            return;
        }
        const source = (_c = (_b = (_a = current.editor).getValue) === null || _b === void 0 ? void 0 : _b.call(_a)) !== null && _c !== void 0 ? _c : "";
        const fresh = current.path !== pushedPath;
        if (!fresh && source === lastSource)
            return;
        lastSource = source;
        pushedPath = current.path;
        pushChain = pushChain
            .then(async () => {
            const result = await bridge.push({ source, fresh });
            if (!(result === null || result === void 0 ? void 0 : result.ok))
                throw new Error((result === null || result === void 0 ? void 0 : result.error) || "live preview push failed");
            if (result.url && active) {
                engineUrl = result.url;
                distributeLive(engineUrl);
            }
        })
            .catch((error) => {
            // Let the next push retry a fresh open instead of diffing against a
            // source the engine never received.
            lastSource = null;
            pushedPath = null;
            console.warn("[live-preview]", (error === null || error === void 0 ? void 0 : error.message) || String(error));
        });
    };
    // 80ms, matching the engine's own client: the engine typesets a keystroke
    // in 20-60ms, so the debounce dominates end-to-end latency — 300ms (the
    // Pro live preview's value) made a ~50ms pipeline feel like half a second.
    const debouncedPush = createDebouncedTask(pushCurrent, 80);
    const bindActiveEditor = () => {
        var _a, _b;
        if (!active)
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
        if (boundEditor === null || boundEditor === void 0 ? void 0 : boundEditor.onDidChangeModelContent)
            disposable = boundEditor.onDidChangeModelContent(debouncedPush);
        debouncedPush();
    };
    const start = async () => {
        if (!(bridge === null || bridge === void 0 ? void 0 : bridge.start) || starting)
            return;
        starting = true;
        try {
            const result = await bridge.start();
            if (!active)
                return;
            if (!(result === null || result === void 0 ? void 0 : result.ok) || !result.url) {
                console.warn("[live-preview] engine failed to start:", result === null || result === void 0 ? void 0 : result.error);
                return;
            }
            engineUrl = result.url;
            distributeLive(engineUrl);
            bindActiveEditor();
            debouncedPush();
        }
        finally {
            starting = false;
        }
    };
    const suspend = () => {
        debouncedPush.cancel();
        disposable === null || disposable === void 0 ? void 0 : disposable.dispose();
        disposable = null;
        boundEditor = null;
        boundPath = null;
        lastSource = null;
        pushedPath = null;
        engineUrl = null;
        distributeLive(null);
    };
    const applyActive = (next) => {
        if (active === next)
            return;
        active = next;
        if (active)
            void start();
        else
            suspend();
    };
    const refresh = () => {
        applyActive(editorSettings.isEnabled("preview.realtime") && getAppMode() === "code");
        if (active) {
            bindActiveEditor();
            if (engineUrl)
                distributeLive(engineUrl);
        }
    };
    editorSettings.subscribe((change) => {
        var _a;
        if (change.kind !== "flag" || change.id !== "preview.realtime")
            return;
        refresh();
        // Off means off: release the resident LuaLaTeX tree instead of keeping it
        // warm in the background.
        if (!change.value)
            void ((_a = bridge === null || bridge === void 0 ? void 0 : bridge.stop) === null || _a === void 0 ? void 0 : _a.call(bridge));
    });
    // Same lightweight poll as pro-live-preview: notices tab switches, editor
    // swaps and app-mode changes without threading callbacks through every
    // call site.
    const poll = window.setInterval(refresh, 200);
    window.addEventListener("beforeunload", () => window.clearInterval(poll), { once: true });
    refresh();
    return { isActive: () => active };
};
