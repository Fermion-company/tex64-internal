import { uiText } from "./i18n.js";
const buildRequestId = (() => {
    let counter = 0;
    return () => `preview-${Date.now().toString(36)}-${counter++}`;
})();
export const createFilePreviewBroker = (postToNative) => {
    const pending = new Map();
    const cache = new Map();
    const cacheTtlMs = 60000;
    const requestPreview = (path) => {
        const trimmed = typeof path === "string" ? path.trim() : "";
        if (!trimmed) {
            return Promise.resolve({ ok: false, error: uiText("path is empty.", "path が空です。") });
        }
        const cached = cache.get(trimmed);
        if (cached && Date.now() - cached.updatedAt < cacheTtlMs) {
            return Promise.resolve({ ok: true, dataUrl: cached.dataUrl });
        }
        const requestId = buildRequestId();
        return new Promise((resolve) => {
            const timeoutId = window.setTimeout(() => {
                pending.delete(requestId);
                resolve({ ok: false, error: uiText("Preview timed out.", "プレビューがタイムアウトしました。") });
            }, 1600);
            pending.set(requestId, { resolve, timeoutId });
            postToNative({
                type: "file:preview",
                requestId,
                path: trimmed,
            }, true);
        });
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
        window.clearTimeout(entry.timeoutId);
        if (!payload.ok) {
            entry.resolve({ ok: false, error: (_a = payload.error) !== null && _a !== void 0 ? _a : uiText("Preview failed.", "プレビューに失敗しました。") });
            return;
        }
        const data = typeof payload.data === "string" ? payload.data : "";
        const mimeType = typeof payload.mimeType === "string" ? payload.mimeType : "image/*";
        if (!data) {
            entry.resolve({ ok: false, error: uiText("Image data is empty.", "画像データが空です。") });
            return;
        }
        const dataUrl = `data:${mimeType};base64,${data}`;
        if (typeof payload.path === "string" && payload.path.trim()) {
            cache.set(payload.path.trim(), { dataUrl, updatedAt: Date.now() });
        }
        entry.resolve({ ok: true, dataUrl });
    };
    return { requestPreview, handlePreviewResult };
};
