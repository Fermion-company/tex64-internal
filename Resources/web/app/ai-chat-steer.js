export const steerTurnShape = (contextPayload) => {
    const payload = contextPayload && typeof contextPayload === "object" ? contextPayload : {};
    const mode = payload.axiomMode === "ask" || payload.axiomMode === "plan" ? payload.axiomMode : "agent";
    const range = payload.activeSelection;
    const selection = range && typeof range === "object"
        ? JSON.stringify([range.path, range.startLine, range.startColumn, range.endLine, range.endColumn, range.textLength, range.text])
        : "";
    const file = typeof payload.activeFilePath === "string" ? payload.activeFilePath : "";
    const revision = typeof payload.activeFileRevision === "string"
        ? payload.activeFileRevision
        : JSON.stringify([payload.activeFileContentLength, payload.activeFileContent]);
    const tabs = JSON.stringify(Array.isArray(payload.openFiles) ? payload.openFiles.map(tab => [tab === null || tab === void 0 ? void 0 : tab.path, tab === null || tab === void 0 ? void 0 : tab.isActive, tab === null || tab === void 0 ? void 0 : tab.isDirty]) : null);
    const drafts = Array.isArray(payload.openFileSnapshots) ? JSON.stringify(payload.openFileSnapshots.filter(entry => entry === null || entry === void 0 ? void 0 : entry.isDirty).map(entry => { var _a; return [entry.path, (_a = entry.modelRevision) !== null && _a !== void 0 ? _a : [entry.contentLength, entry.content]]; })) : "[]";
    return { mode, file, revision, tabs, drafts, selection };
};
export const canSteer = (candidate) => {
    const { parts, contextPayload, runningShape } = candidate;
    if (candidate.collabGuest || candidate.queued > 0 || !runningShape)
        return false;
    if (!Array.isArray(parts) || parts.some((part) => part === null || part === void 0 ? void 0 : part.inlineData))
        return false;
    if (!parts.some((part) => typeof (part === null || part === void 0 ? void 0 : part.text) === "string" && part.text.trim().length > 0))
        return false;
    const refs = contextPayload === null || contextPayload === void 0 ? void 0 : contextPayload.explicitContextRefs;
    if (Array.isArray(refs) && refs.length > 0)
        return false;
    const paths = contextPayload === null || contextPayload === void 0 ? void 0 : contextPayload.explicitContextPaths;
    if (Array.isArray(paths) && paths.length > 0)
        return false;
    if ((contextPayload === null || contextPayload === void 0 ? void 0 : contextPayload.turnOrigin) !== undefined)
        return false;
    const shape = steerTurnShape(contextPayload);
    return shape.mode === runningShape.mode && shape.file === runningShape.file &&
        shape.revision === runningShape.revision && shape.tabs === runningShape.tabs && shape.drafts === runningShape.drafts && shape.selection === runningShape.selection;
};
const STEER_TIMEOUT_MS = 15000;
export const createAiChatSteering = (deps) => {
    var _a, _b, _c;
    const timeoutMs = (_a = deps.timeoutMs) !== null && _a !== void 0 ? _a : STEER_TIMEOUT_MS;
    const setTimer = (_b = deps.setTimer) !== null && _b !== void 0 ? _b : ((fn, ms) => window.setTimeout(fn, ms));
    const clearTimer = (_c = deps.clearTimer) !== null && _c !== void 0 ? _c : ((timer) => window.clearTimeout(timer));
    const pending = new Map();
    const finish = (requestId, accepted) => {
        const entry = pending.get(requestId);
        if (!entry)
            return;
        pending.delete(requestId);
        clearTimer(entry.timer);
        entry.settle(accepted);
    };
    /**
     * Hands the words to the running turn. settle runs once, with the host's
     * answer (false also when no answer comes). Returns false when nothing went
     * out; settle is then never called.
     */
    const steer = (conversationId, message, settle) => {
        const steeringId = `steer-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 10)}`;
        // Not "ai-": the AI workspace's correlation ids never match a Code request.
        const requestId = `code-${steeringId}`;
        const timer = setTimer(() => finish(requestId, false), timeoutMs);
        pending.set(requestId, { conversationId, settle, timer });
        const posted = deps.postToNative({ type: "agent:steer", requestId, conversationId, message, steeringId }, true);
        if (!posted) {
            pending.delete(requestId);
            clearTimer(timer);
            return false;
        }
        return true;
    };
    const handleSteerResult = (payload) => {
        const requestId = typeof (payload === null || payload === void 0 ? void 0 : payload.requestId) === "string" ? payload.requestId : "";
        const entry = requestId ? pending.get(requestId) : undefined;
        if (!entry || payload.conversationId !== entry.conversationId)
            return;
        finish(requestId, payload.accepted === true);
    };
    const isPending = (conversationId) => {
        for (const entry of pending.values())
            if (entry.conversationId === conversationId)
                return true;
        return false;
    };
    return { steer, handleSteerResult, isPending };
};
