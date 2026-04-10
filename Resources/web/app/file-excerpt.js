const buildRequestId = (() => {
    let counter = 0;
    return () => `excerpt-${Date.now().toString(36)}-${counter++}`;
})();
export const createFileExcerptBroker = (postToNative) => {
    const pending = new Map();
    const cache = new Map();
    const cacheTtlMs = 30000;
    const requestExcerpt = (path, line, options = {}) => {
        var _a, _b;
        const trimmed = typeof path === "string" ? path.trim() : "";
        const lineNumber = Number.isFinite(line) ? Math.floor(line) : Number.NaN;
        if (!trimmed) {
            return Promise.resolve({ ok: false, error: "path is empty." });
        }
        if (!Number.isFinite(lineNumber) || lineNumber < 1) {
            return Promise.resolve({ ok: false, error: "line is invalid." });
        }
        const radius = Number.isFinite(options.radius)
            ? Math.min(180, Math.max(0, Math.floor((_a = options.radius) !== null && _a !== void 0 ? _a : 0)))
            : 6;
        const maxLines = Number.isFinite(options.maxLines)
            ? Math.min(360, Math.max(1, Math.floor((_b = options.maxLines) !== null && _b !== void 0 ? _b : 0)))
            : Math.min(2 * radius + 1, 25);
        const cacheKey = `${trimmed}:${lineNumber}:${radius}:${maxLines}`;
        const cached = cache.get(cacheKey);
        if (cached && Date.now() - cached.updatedAt < cacheTtlMs) {
            return Promise.resolve(cached.result);
        }
        const requestId = buildRequestId();
        return new Promise((resolve) => {
            const timeoutId = window.setTimeout(() => {
                pending.delete(requestId);
                resolve({ ok: false, error: "Excerpt timed out." });
            }, 1400);
            pending.set(requestId, { resolve, timeoutId, cacheKey });
            postToNative({
                type: "file:excerpt",
                requestId,
                path: trimmed,
                line: lineNumber,
                radius,
                maxLines,
            }, true);
        });
    };
    const handleExcerptResult = (payload) => {
        var _a, _b;
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
            entry.resolve({ ok: false, error: (_a = payload.error) !== null && _a !== void 0 ? _a : "Excerpt failed." });
            return;
        }
        const pathValue = typeof payload.path === "string" ? payload.path.trim() : "";
        const startLine = Number.isFinite(payload.startLine)
            ? Math.max(1, Math.floor((_b = payload.startLine) !== null && _b !== void 0 ? _b : 1))
            : 1;
        const lines = Array.isArray(payload.lines) ? payload.lines.map((line) => String(line)) : [];
        const result = {
            ok: true,
            path: pathValue,
            startLine,
            lines,
            ...(payload.truncated ? { truncated: true } : {}),
        };
        cache.set(entry.cacheKey, { result, updatedAt: Date.now() });
        entry.resolve(result);
    };
    return { requestExcerpt, handleExcerptResult };
};
