import { uiText } from "./i18n.js";
const buildRequestId = (() => {
    let counter = 0;
    return () => `preview-${Date.now().toString(36)}-${counter++}`;
})();
export const createFilePreviewBroker = (postToNative) => {
    const pending = new Map();
    const inFlight = new Map();
    let workspaceScopeKey = "none:0";
    const setWorkspaceScope = (scope) => {
        const workspace = scope.workspaceId || scope.rootPath || "none";
        const generation = Number.isSafeInteger(scope.workspaceGeneration)
            ? scope.workspaceGeneration
            : 0;
        const nextScopeKey = `${workspace}:${generation}`;
        if (nextScopeKey === workspaceScopeKey)
            return;
        workspaceScopeKey = nextScopeKey;
        inFlight.clear();
        for (const entry of pending.values()) {
            window.clearTimeout(entry.timeoutId);
            entry.resolve({ ok: false, error: "Workspace changed." });
        }
        pending.clear();
    };
    const requestPreview = (path) => {
        const trimmed = typeof path === "string" ? path.trim() : "";
        if (!trimmed) {
            return Promise.resolve({ ok: false, error: uiText("path is empty.", "pathが空です。") });
        }
        const existing = inFlight.get(trimmed);
        if (existing)
            return existing;
        const requestId = buildRequestId();
        const request = new Promise((resolve) => {
            // PDFs (up to 5MB) take longer to read and ship over IPC than small
            // images, so the deadline is sized for the slowest allowed payload.
            const timeoutId = window.setTimeout(() => {
                pending.delete(requestId);
                inFlight.delete(trimmed);
                resolve({ ok: false, error: uiText("Preview timed out.", "プレビューがタイムアウトしました。") });
            }, 4000);
            pending.set(requestId, { resolve, timeoutId, path: trimmed });
            postToNative({
                type: "file:preview",
                requestId,
                path: trimmed,
            }, true);
        });
        inFlight.set(trimmed, request);
        return request;
    };
    const handlePreviewResult = (payload) => {
        var _a;
        if (!payload || typeof payload.requestId !== "string") {
            return;
        }
        const entry = pending.get(payload.requestId);
        if (!entry) {
            return;
        }
        pending.delete(payload.requestId);
        inFlight.delete(entry.path);
        window.clearTimeout(entry.timeoutId);
        if (!payload.ok) {
            entry.resolve({ ok: false, error: (_a = payload.error) !== null && _a !== void 0 ? _a : uiText("Preview failed.", "プレビューできませんでした。") });
            return;
        }
        const data = typeof payload.data === "string" ? payload.data : "";
        const mimeType = typeof payload.mimeType === "string" ? payload.mimeType : "image/*";
        if (!data) {
            entry.resolve({ ok: false, error: uiText("Image data is empty.", "画像データが空です。") });
            return;
        }
        const dataUrl = `data:${mimeType};base64,${data}`;
        entry.resolve({ ok: true, dataUrl });
    };
    return { requestPreview, handlePreviewResult, setWorkspaceScope };
};
