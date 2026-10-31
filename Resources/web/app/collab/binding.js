// Monaco model ⇄ renderer Y.Doc ⇄ (IPC) main Y.Doc. One binding per model,
// followed by whichever editor groups show it (split view included). The
// renderer starts every doc empty and receives its content by sync, so it
// never inserts an initial copy of the file.
//
// IME: while any group showing a model is composing, incoming document frames
// for that model wait; applying a remote edit mid-composition breaks the IME.
// Undo/Redo: a bound model uses a Y.UndoManager that tracks only this
// binding's own transactions, so a remote edit is never undone here.
import { getEditorModelPath } from "../editor-session/model-path.js";
import { collabSession } from "./session.js";
import { collabCursors } from "./cursors.js";
import { contentDigest } from "./digest.js";
const SESSION_DOC = "$session";
const REMOTE = "remote";
const vendor = () => { var _a; return (_a = window.TeX64Collab) !== null && _a !== void 0 ? _a : null; };
export const initCollabBinding = (deps) => {
    const entries = new Map();
    const sessionListeners = new Set();
    const contextKeys = new Map();
    let clientId = 0;
    let sessionKey = "";
    let awarenessTimer = null;
    const notifySessionDoc = (doc) => {
        for (const listener of sessionListeners) {
            try {
                listener(doc);
            }
            catch (error) {
                console.error("[collab] session doc listener failed", error);
            }
        }
    };
    const sendFrame = (docId, kind, bytes) => collabSession.send(docId, kind, bytes);
    const groupsShowing = (model) => deps.editorSession.getEditorGroups().filter((group) => { var _a, _b; return ((_b = (_a = group.editor) === null || _a === void 0 ? void 0 : _a.getModel) === null || _b === void 0 ? void 0 : _b.call(_a)) === model; });
    const isComposingFor = (entry) => Boolean(entry.model) && groupsShowing(entry.model).some((group) => group.isComposing);
    const allEditors = () => new Set(deps.editorSession.getEditorGroups().map((group) => group.editor).filter(Boolean));
    const updateContextKeys = () => {
        var _a, _b;
        for (const group of deps.editorSession.getEditorGroups()) {
            const editor = group.editor;
            if (!(editor === null || editor === void 0 ? void 0 : editor.createContextKey))
                continue;
            let key = contextKeys.get(editor);
            if (!key) {
                key = editor.createContextKey("tex64CollabBound", false);
                contextKeys.set(editor, key);
            }
            const path = getEditorModelPath((_a = editor.getModel) === null || _a === void 0 ? void 0 : _a.call(editor));
            key.set(Boolean(path && ((_b = entries.get(path)) === null || _b === void 0 ? void 0 : _b.binding)));
        }
    };
    const applyIncoming = (entry, bytes) => {
        const lib = vendor();
        if (!lib)
            return;
        const decoder = lib.decoding.createDecoder(bytes);
        const encoder = lib.encoding.createEncoder();
        const messageType = lib.syncProtocol.readSyncMessage(decoder, encoder, entry.doc, REMOTE);
        if (lib.encoding.length(encoder) > 1)
            sendFrame(entry.docId, "sync", lib.encoding.toUint8Array(encoder));
        if (messageType === lib.syncProtocol.messageYjsSyncStep2 && !entry.synced) {
            entry.synced = true;
            if (entry.docId === SESSION_DOC)
                notifySessionDoc(entry.doc);
            else
                createBinding(entry);
        }
    };
    const drainQueue = (entry) => {
        if (entry.queueTimer !== null) {
            window.clearTimeout(entry.queueTimer);
            entry.queueTimer = null;
        }
        if (isComposingFor(entry)) {
            entry.queueTimer = window.setTimeout(() => drainQueue(entry), 60);
            return;
        }
        const pending = entry.queue.splice(0);
        for (const bytes of pending)
            applyIncoming(entry, bytes);
    };
    const createBinding = (entry) => {
        var _a, _b;
        const lib = vendor();
        if (!lib || !entry.model || entry.binding || !entry.ytext)
            return;
        const modelValue = entry.model.getValue();
        const shared = entry.ytext.toString();
        if (modelValue !== shared) {
            // Typed before the content arrived: keep those keystrokes by folding the
            // buffer's difference into the shared text instead of discarding it.
            let prefix = 0;
            const max = Math.min(modelValue.length, shared.length);
            while (prefix < max && modelValue.charCodeAt(prefix) === shared.charCodeAt(prefix))
                prefix++;
            let suffix = 0;
            while (suffix < max - prefix && modelValue.charCodeAt(modelValue.length - 1 - suffix) === shared.charCodeAt(shared.length - 1 - suffix))
                suffix++;
            const savedContent = (_b = (_a = deps.editorSession).getSavedContent) === null || _b === void 0 ? void 0 : _b.call(_a, entry.docId);
            const hadLocalEdits = typeof savedContent === "string" ? savedContent !== modelValue : false;
            if (hadLocalEdits) {
                entry.doc.transact(() => {
                    const deleteLength = shared.length - prefix - suffix;
                    if (deleteLength > 0)
                        entry.ytext.delete(prefix, deleteLength);
                    const insert = modelValue.slice(prefix, modelValue.length - suffix);
                    if (insert)
                        entry.ytext.insert(prefix, insert);
                }, "prebind");
            }
        }
        const groups = groupsShowing(entry.model);
        for (const group of groups)
            group.isApplyingFile = true;
        try {
            entry.binding = new lib.MonacoBinding(entry.ytext, entry.model, allEditors(), entry.awareness);
        }
        finally {
            for (const group of groups)
                group.isApplyingFile = false;
        }
        entry.undo = new lib.Y.UndoManager(entry.ytext, { trackedOrigins: new Set([entry.binding]), captureTimeout: 500 });
        deps.editorSession.updateDirtyState(entry.docId, entry.model.getValue());
        updateContextKeys();
    };
    const openDoc = (docId, model) => {
        const lib = vendor();
        if (!lib)
            return null;
        const state = collabSession.getState();
        const doc = new lib.Y.Doc({ gc: true });
        doc.clientID = clientId;
        const ytext = docId === SESSION_DOC ? null : doc.getText("content");
        const awareness = new lib.awarenessProtocol.Awareness(doc);
        const self = collabSession.selfParticipant();
        awareness.setLocalStateField("user", { name: (self === null || self === void 0 ? void 0 : self.name) || "", color: (self === null || self === void 0 ? void 0 : self.color) || "#2563eb", id: state.selfId || "" });
        const entry = { docId, model, doc, ytext, awareness, binding: null, undo: null, synced: false, queue: [], queueTimer: null, disposables: [] };
        entries.set(docId, entry);
        const onUpdate = (update, origin) => {
            if (origin === REMOTE)
                return;
            const encoder = lib.encoding.createEncoder();
            lib.syncProtocol.writeUpdate(encoder, update);
            sendFrame(docId, "sync", lib.encoding.toUint8Array(encoder));
        };
        doc.on("update", onUpdate);
        entry.disposables.push(() => doc.off("update", onUpdate));
        const onAwareness = ({ added, updated, removed }, origin) => {
            collabCursors.observe(awareness.getStates(), clientId, origin === REMOTE);
            if (origin === REMOTE)
                return;
            const changed = added.concat(updated, removed);
            sendFrame(docId, "awareness", lib.awarenessProtocol.encodeAwarenessUpdate(awareness, changed));
        };
        awareness.on("update", onAwareness);
        entry.disposables.push(() => awareness.off("update", onAwareness));
        if (model === null || model === void 0 ? void 0 : model.onWillDispose) {
            const disposable = model.onWillDispose(() => closeDoc(docId));
            entry.disposables.push(() => { var _a; return (_a = disposable === null || disposable === void 0 ? void 0 : disposable.dispose) === null || _a === void 0 ? void 0 : _a.call(disposable); });
        }
        sendFrame(docId, "open", null);
        const encoder = lib.encoding.createEncoder();
        lib.syncProtocol.writeSyncStep1(encoder, doc);
        sendFrame(docId, "sync", lib.encoding.toUint8Array(encoder));
        sendFrame(docId, "awareness", lib.awarenessProtocol.encodeAwarenessUpdate(awareness, [clientId]));
        return entry;
    };
    const closeDoc = (docId, { silent = false } = {}) => {
        var _a, _b, _c;
        const entry = entries.get(docId);
        if (!entry)
            return;
        entries.delete(docId);
        if (entry.queueTimer !== null)
            window.clearTimeout(entry.queueTimer);
        for (const dispose of entry.disposables.splice(0)) {
            try {
                dispose();
            }
            catch { }
        }
        try {
            (_b = (_a = entry.undo) === null || _a === void 0 ? void 0 : _a.destroy) === null || _b === void 0 ? void 0 : _b.call(_a);
            (_c = entry.binding) === null || _c === void 0 ? void 0 : _c.destroy();
            entry.awareness.setLocalState(null);
            entry.awareness.destroy();
            entry.doc.destroy();
        }
        catch { }
        if (!silent)
            sendFrame(docId, "close", null);
        if (docId === SESSION_DOC)
            notifySessionDoc(null);
        updateContextKeys();
    };
    const bindModel = (path, model) => {
        if (!collabSession.isSharedPath(path) || !vendor())
            return;
        const existing = entries.get(path);
        if (existing) {
            if (existing.model === model)
                return;
            closeDoc(path);
        }
        openDoc(path, model);
    };
    const bindVisibleModels = () => {
        var _a;
        for (const group of deps.editorSession.getEditorGroups()) {
            const editor = group.editor;
            const model = (_a = editor === null || editor === void 0 ? void 0 : editor.getModel) === null || _a === void 0 ? void 0 : _a.call(editor);
            const path = getEditorModelPath(model);
            if (path && group.currentFilePath === path)
                bindModel(path, model);
        }
        updateContextKeys();
    };
    const startSession = (state) => {
        sessionKey = `${state.sessionId}:${state.epoch}`;
        clientId = Math.floor(Math.random() * 0x7fffffff) + 1;
        collabCursors.reset();
        openDoc(SESSION_DOC, null);
        bindVisibleModels();
        if (awarenessTimer === null) {
            awarenessTimer = window.setInterval(() => {
                for (const entry of entries.values())
                    entry.awareness.setLocalState(entry.awareness.getLocalState());
            }, 15000);
        }
    };
    const endSession = () => {
        sessionKey = "";
        if (awarenessTimer !== null) {
            window.clearInterval(awarenessTimer);
            awarenessTimer = null;
        }
        for (const docId of Array.from(entries.keys())) {
            const entry = entries.get(docId);
            const model = entry === null || entry === void 0 ? void 0 : entry.model;
            closeDoc(docId, { silent: true });
            // Everything was flushed before the session ended: the buffer is saved.
            if (model && entry)
                deps.editorSession.markSavedExternally(docId, contentDigest(model.getValue()));
        }
        collabCursors.reset();
        updateContextKeys();
    };
    collabSession.onChange((state) => {
        const key = state.active ? `${state.sessionId}:${state.epoch}` : "";
        if (key !== sessionKey) {
            if (sessionKey)
                endSession();
            if (key)
                startSession(state);
            return;
        }
        if (state.active) {
            // New shared files, or files no longer shared.
            for (const docId of Array.from(entries.keys())) {
                if (docId !== SESSION_DOC && !state.textFiles.includes(docId))
                    closeDoc(docId);
            }
            bindVisibleModels();
            const self = collabSession.selfParticipant();
            if (self)
                for (const entry of entries.values())
                    entry.awareness.setLocalStateField("user", { name: self.name, color: self.color, id: state.selfId || "" });
        }
    });
    collabSession.onMessage("collab:doc", (message) => {
        const state = collabSession.getState();
        if (message.sessionId !== state.sessionId || message.epoch !== state.epoch)
            return;
        const entry = entries.get(String(message.docId));
        const bytes = message.bytes;
        if (!entry || !(bytes instanceof Uint8Array))
            return;
        const lib = vendor();
        if (!lib)
            return;
        if (message.kind === "awareness") {
            lib.awarenessProtocol.applyAwarenessUpdate(entry.awareness, bytes, REMOTE);
            return;
        }
        if (message.kind !== "sync")
            return;
        if (entry.queue.length || isComposingFor(entry)) {
            entry.queue.push(bytes);
            drainQueue(entry);
            return;
        }
        applyIncoming(entry, bytes);
    });
    collabSession.onMessage("collab:docRefused", (message) => {
        closeDoc(String(message.docId), { silent: true });
    });
    collabSession.onMessage("collab:saved", (message) => {
        const path = String(message.path || "");
        const hash = String(message.hash || "");
        if (path && hash)
            deps.editorSession.markSavedExternally(path, hash);
    });
    // Follow the editors: a model shown in a group gets its binding; the
    // binding keeps living while the model exists, even once hidden.
    const attached = new WeakSet();
    const attachEditors = () => {
        var _a;
        for (const group of deps.editorSession.getEditorGroups()) {
            const editor = group.editor;
            if (!editor || attached.has(editor))
                continue;
            attached.add(editor);
            (_a = editor.onDidChangeModel) === null || _a === void 0 ? void 0 : _a.call(editor, () => {
                if (!collabSession.isActive())
                    return;
                window.setTimeout(() => {
                    var _a;
                    const model = (_a = editor.getModel) === null || _a === void 0 ? void 0 : _a.call(editor);
                    const path = getEditorModelPath(model);
                    if (path && collabSession.isSharedPath(path))
                        bindModel(path, model);
                    updateContextKeys();
                }, 0);
            });
        }
    };
    attachEditors();
    window.addEventListener("tex64:editor-created", attachEditors);
    const entryForEditor = (editor) => {
        var _a, _b;
        const path = getEditorModelPath((_a = editor === null || editor === void 0 ? void 0 : editor.getModel) === null || _a === void 0 ? void 0 : _a.call(editor));
        return path ? (_b = entries.get(path)) !== null && _b !== void 0 ? _b : null : null;
    };
    return {
        isBound: (path) => Boolean(path && collabSession.isSharedPath(path)),
        canHandleUndo: (editor) => { var _a; return Boolean((_a = entryForEditor(editor)) === null || _a === void 0 ? void 0 : _a.binding); },
        undo: (editor) => {
            const entry = entryForEditor(editor);
            if (!(entry === null || entry === void 0 ? void 0 : entry.undo))
                return false;
            entry.undo.undo();
            return true;
        },
        redo: (editor) => {
            const entry = entryForEditor(editor);
            if (!(entry === null || entry === void 0 ? void 0 : entry.undo))
                return false;
            entry.undo.redo();
            return true;
        },
        sessionDoc: () => {
            const entry = entries.get(SESSION_DOC);
            return (entry === null || entry === void 0 ? void 0 : entry.synced) ? entry.doc : null;
        },
        sessionText: (path) => { var _a, _b; return (_b = (_a = entries.get(path)) === null || _a === void 0 ? void 0 : _a.ytext) !== null && _b !== void 0 ? _b : null; },
        onSessionDoc: (listener) => {
            sessionListeners.add(listener);
            const entry = entries.get(SESSION_DOC);
            if (entry === null || entry === void 0 ? void 0 : entry.synced)
                listener(entry.doc);
            return () => sessionListeners.delete(listener);
        },
        getVendor: vendor,
    };
};
