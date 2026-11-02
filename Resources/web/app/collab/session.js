// Session state as the main process reports it, plus the IPC bridge. The
// renderer never opens a socket itself (the CSP stays unchanged): Y.Doc
// frames travel through tex64Collab.send / onMessage.
var _a;
const bridge = (_a = window.tex64Collab) !== null && _a !== void 0 ? _a : null;
let state = { active: false, phase: "idle", participants: [], textFiles: [] };
const stateListeners = new Set();
const messageListeners = new Map();
const emitState = () => {
    for (const listener of stateListeners) {
        try {
            listener(state);
        }
        catch (error) {
            console.error("[collab] state listener failed", error);
        }
    }
};
bridge === null || bridge === void 0 ? void 0 : bridge.onMessage((message) => {
    if (!message || typeof message.type !== "string")
        return;
    if (message.type === "collab:state") {
        const { type: _type, ...rest } = message;
        state = { participants: [], textFiles: [], ...rest, active: rest.active === true, phase: String(rest.phase || "idle") };
        emitState();
    }
    const listeners = messageListeners.get(message.type);
    if (listeners)
        for (const listener of listeners) {
            try {
                listener(message);
            }
            catch (error) {
                console.error("[collab] message listener failed", error);
            }
        }
});
const call = async (action, payload = {}) => {
    if (!bridge)
        throw new Error("Collaboration is not available in this window.");
    const result = await bridge.call(action, payload);
    if (!(result === null || result === void 0 ? void 0 : result.ok))
        throw Object.assign(new Error((result === null || result === void 0 ? void 0 : result.error) || "The collaboration request failed."), { code: result === null || result === void 0 ? void 0 : result.code });
    return result;
};
export const collabSession = {
    available: Boolean(bridge),
    getState: () => state,
    isActive: () => state.active,
    isGuest: () => state.active && state.role === "guest",
    isHost: () => state.active && state.role === "host",
    selfParticipant: () => { var _a; return (_a = state.participants.find((participant) => participant.self)) !== null && _a !== void 0 ? _a : null; },
    isSharedPath: (path) => Boolean(path && state.active && state.textFiles.includes(path)),
    onChange: (listener) => {
        stateListeners.add(listener);
        return () => stateListeners.delete(listener);
    },
    onMessage: (type, listener) => {
        let listeners = messageListeners.get(type);
        if (!listeners) {
            listeners = new Set();
            messageListeners.set(type, listeners);
        }
        listeners.add(listener);
        return () => listeners === null || listeners === void 0 ? void 0 : listeners.delete(listener);
    },
    call,
    status: () => call("status"),
    start: (name) => call("start", { name }),
    join: (link, name) => call("join", { link, name }),
    leave: () => call("leave"),
    flush: async () => {
        if (!state.active)
            return true;
        try {
            const result = await call("flush");
            return result.flushed !== false;
        }
        catch {
            return false;
        }
    },
    send: (docId, kind, bytes) => {
        if (!bridge || !state.active)
            return;
        bridge.send(docId, bytes, { kind, sessionId: state.sessionId, epoch: state.epoch });
    },
};
