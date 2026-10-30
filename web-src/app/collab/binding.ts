// Monaco model ⇄ renderer Y.Doc ⇄ (IPC) main Y.Doc. One binding per model,
// followed by whichever editor groups show it (split view included). The
// renderer starts every doc empty and receives its content by sync, so it
// never inserts an initial copy of the file.
//
// IME: while any group showing a model is composing, incoming document frames
// for that model wait; applying a remote edit mid-composition breaks the IME.
// Undo/Redo: a bound model uses a Y.UndoManager that tracks only this
// binding's own transactions, so a remote edit is never undone here.

import type { EditorSessionApi, EditorGroupState } from "../editor-session.js";
import { getEditorModelPath } from "../editor-session/model-path.js";
import { collabSession, type CollabState } from "./session.js";
import { collabCursors } from "./cursors.js";
import { contentDigest } from "./digest.js";

type Vendor = {
  Y: any;
  MonacoBinding: new (ytext: any, model: any, editors: Set<any>, awareness: any) => { destroy: () => void };
  awarenessProtocol: any;
  syncProtocol: any;
  encoding: any;
  decoding: any;
};

type DocEntry = {
  docId: string;
  model: any | null;
  doc: any;
  ytext: any | null;
  awareness: any;
  binding: { destroy: () => void } | null;
  undo: any | null;
  synced: boolean;
  queue: Uint8Array[];
  queueTimer: number | null;
  disposables: Array<() => void>;
};

const SESSION_DOC = "$session";
const REMOTE = "remote";

const vendor = (): Vendor | null => (window as unknown as { TeX64Collab?: Vendor }).TeX64Collab ?? null;

export type CollabBindingApi = {
  isBound: (path: string | null | undefined) => boolean;
  undo: (editor: any) => boolean;
  redo: (editor: any) => boolean;
  canHandleUndo: (editor: any) => boolean;
  sessionDoc: () => any | null;
  sessionText: (path: string) => any | null;
  onSessionDoc: (listener: (doc: any | null) => void) => () => void;
  getVendor: () => Vendor | null;
};

export const initCollabBinding = (deps: {
  editorSession: EditorSessionApi;
  getMonacoApi: () => Record<string, unknown> | null;
}): CollabBindingApi => {
  const entries = new Map<string, DocEntry>();
  const sessionListeners = new Set<(doc: any | null) => void>();
  const contextKeys = new Map<any, any>();
  let clientId = 0;
  let sessionKey = "";
  let awarenessTimer: number | null = null;

  const notifySessionDoc = (doc: any | null) => {
    for (const listener of sessionListeners) {
      try {
        listener(doc);
      } catch (error) {
        console.error("[collab] session doc listener failed", error);
      }
    }
  };

  const sendFrame = (docId: string, kind: "sync" | "awareness" | "open" | "close", bytes: Uint8Array | null) =>
    collabSession.send(docId, kind, bytes);

  const groupsShowing = (model: any): EditorGroupState[] =>
    deps.editorSession.getEditorGroups().filter((group) => (group.editor as any)?.getModel?.() === model);

  const isComposingFor = (entry: DocEntry) => Boolean(entry.model) && groupsShowing(entry.model).some((group) => group.isComposing);

  const allEditors = () => new Set(deps.editorSession.getEditorGroups().map((group) => group.editor).filter(Boolean));

  const updateContextKeys = () => {
    for (const group of deps.editorSession.getEditorGroups()) {
      const editor = group.editor as any;
      if (!editor?.createContextKey) continue;
      let key = contextKeys.get(editor);
      if (!key) {
        key = editor.createContextKey("tex64CollabBound", false);
        contextKeys.set(editor, key);
      }
      const path = getEditorModelPath(editor.getModel?.());
      key.set(Boolean(path && entries.get(path)?.binding));
    }
  };

  const applyIncoming = (entry: DocEntry, bytes: Uint8Array) => {
    const lib = vendor();
    if (!lib) return;
    const decoder = lib.decoding.createDecoder(bytes);
    const encoder = lib.encoding.createEncoder();
    const messageType = lib.syncProtocol.readSyncMessage(decoder, encoder, entry.doc, REMOTE);
    if (lib.encoding.length(encoder) > 1) sendFrame(entry.docId, "sync", lib.encoding.toUint8Array(encoder));
    if (messageType === lib.syncProtocol.messageYjsSyncStep2 && !entry.synced) {
      entry.synced = true;
      if (entry.docId === SESSION_DOC) notifySessionDoc(entry.doc);
      else createBinding(entry);
    }
  };

  const drainQueue = (entry: DocEntry) => {
    if (entry.queueTimer !== null) {
      window.clearTimeout(entry.queueTimer);
      entry.queueTimer = null;
    }
    if (isComposingFor(entry)) {
      entry.queueTimer = window.setTimeout(() => drainQueue(entry), 60);
      return;
    }
    const pending = entry.queue.splice(0);
    for (const bytes of pending) applyIncoming(entry, bytes);
  };

  const createBinding = (entry: DocEntry) => {
    const lib = vendor();
    if (!lib || !entry.model || entry.binding || !entry.ytext) return;
    const modelValue: string = entry.model.getValue();
    const shared: string = entry.ytext.toString();
    if (modelValue !== shared) {
      // Typed before the content arrived: keep those keystrokes by folding the
      // buffer's difference into the shared text instead of discarding it.
      let prefix = 0;
      const max = Math.min(modelValue.length, shared.length);
      while (prefix < max && modelValue.charCodeAt(prefix) === shared.charCodeAt(prefix)) prefix++;
      let suffix = 0;
      while (suffix < max - prefix && modelValue.charCodeAt(modelValue.length - 1 - suffix) === shared.charCodeAt(shared.length - 1 - suffix)) suffix++;
      const savedContent = (deps.editorSession as any).getSavedContent?.(entry.docId);
      const hadLocalEdits = typeof savedContent === "string" ? savedContent !== modelValue : false;
      if (hadLocalEdits) {
        entry.doc.transact(() => {
          const deleteLength = shared.length - prefix - suffix;
          if (deleteLength > 0) entry.ytext.delete(prefix, deleteLength);
          const insert = modelValue.slice(prefix, modelValue.length - suffix);
          if (insert) entry.ytext.insert(prefix, insert);
        }, "prebind");
      }
    }
    const groups = groupsShowing(entry.model);
    for (const group of groups) group.isApplyingFile = true;
    try {
      entry.binding = new lib.MonacoBinding(entry.ytext, entry.model, allEditors(), entry.awareness);
    } finally {
      for (const group of groups) group.isApplyingFile = false;
    }
    entry.undo = new lib.Y.UndoManager(entry.ytext, { trackedOrigins: new Set([entry.binding]), captureTimeout: 500 });
    deps.editorSession.updateDirtyState(entry.docId, entry.model.getValue());
    updateContextKeys();
  };

  const openDoc = (docId: string, model: any | null) => {
    const lib = vendor();
    if (!lib) return null;
    const state = collabSession.getState();
    const doc = new lib.Y.Doc({ gc: true });
    doc.clientID = clientId;
    const ytext = docId === SESSION_DOC ? null : doc.getText("content");
    const awareness = new lib.awarenessProtocol.Awareness(doc);
    const self = collabSession.selfParticipant();
    awareness.setLocalStateField("user", { name: self?.name || "", color: self?.color || "#2563eb", id: state.selfId || "" });
    const entry: DocEntry = { docId, model, doc, ytext, awareness, binding: null, undo: null, synced: false, queue: [], queueTimer: null, disposables: [] };
    entries.set(docId, entry);
    const onUpdate = (update: Uint8Array, origin: unknown) => {
      if (origin === REMOTE) return;
      const encoder = lib.encoding.createEncoder();
      lib.syncProtocol.writeUpdate(encoder, update);
      sendFrame(docId, "sync", lib.encoding.toUint8Array(encoder));
    };
    doc.on("update", onUpdate);
    entry.disposables.push(() => doc.off("update", onUpdate));
    const onAwareness = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      collabCursors.observe(awareness.getStates(), clientId);
      if (origin === REMOTE) return;
      const changed = added.concat(updated, removed);
      sendFrame(docId, "awareness", lib.awarenessProtocol.encodeAwarenessUpdate(awareness, changed));
    };
    awareness.on("update", onAwareness);
    entry.disposables.push(() => awareness.off("update", onAwareness));
    if (model?.onWillDispose) {
      const disposable = model.onWillDispose(() => closeDoc(docId));
      entry.disposables.push(() => disposable?.dispose?.());
    }
    sendFrame(docId, "open", null);
    const encoder = lib.encoding.createEncoder();
    lib.syncProtocol.writeSyncStep1(encoder, doc);
    sendFrame(docId, "sync", lib.encoding.toUint8Array(encoder));
    sendFrame(docId, "awareness", lib.awarenessProtocol.encodeAwarenessUpdate(awareness, [clientId]));
    return entry;
  };

  const closeDoc = (docId: string, { silent = false }: { silent?: boolean } = {}) => {
    const entry = entries.get(docId);
    if (!entry) return;
    entries.delete(docId);
    if (entry.queueTimer !== null) window.clearTimeout(entry.queueTimer);
    for (const dispose of entry.disposables.splice(0)) {
      try {
        dispose();
      } catch {}
    }
    try {
      entry.undo?.destroy?.();
      entry.binding?.destroy();
      entry.awareness.setLocalState(null);
      entry.awareness.destroy();
      entry.doc.destroy();
    } catch {}
    if (!silent) sendFrame(docId, "close", null);
    if (docId === SESSION_DOC) notifySessionDoc(null);
    updateContextKeys();
  };

  const bindModel = (path: string, model: any) => {
    if (!collabSession.isSharedPath(path) || !vendor()) return;
    const existing = entries.get(path);
    if (existing) {
      if (existing.model === model) return;
      closeDoc(path);
    }
    openDoc(path, model);
  };

  const bindVisibleModels = () => {
    for (const group of deps.editorSession.getEditorGroups()) {
      const editor = group.editor as any;
      const model = editor?.getModel?.();
      const path = getEditorModelPath(model);
      if (path && group.currentFilePath === path) bindModel(path, model);
    }
    updateContextKeys();
  };

  const startSession = (state: CollabState) => {
    sessionKey = `${state.sessionId}:${state.epoch}`;
    clientId = Math.floor(Math.random() * 0x7fffffff) + 1;
    collabCursors.reset();
    openDoc(SESSION_DOC, null);
    bindVisibleModels();
    if (awarenessTimer === null) {
      awarenessTimer = window.setInterval(() => {
        for (const entry of entries.values()) entry.awareness.setLocalState(entry.awareness.getLocalState());
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
      const model = entry?.model;
      closeDoc(docId, { silent: true });
      // Everything was flushed before the session ended: the buffer is saved.
      if (model && entry) deps.editorSession.markSavedExternally(docId, contentDigest(model.getValue()));
    }
    collabCursors.reset();
    updateContextKeys();
  };

  collabSession.onChange((state) => {
    const key = state.active ? `${state.sessionId}:${state.epoch}` : "";
    if (key !== sessionKey) {
      if (sessionKey) endSession();
      if (key) startSession(state);
      return;
    }
    if (state.active) {
      // New shared files, or files no longer shared.
      for (const docId of Array.from(entries.keys())) {
        if (docId !== SESSION_DOC && !state.textFiles.includes(docId)) closeDoc(docId);
      }
      bindVisibleModels();
      const self = collabSession.selfParticipant();
      if (self) for (const entry of entries.values()) entry.awareness.setLocalStateField("user", { name: self.name, color: self.color, id: state.selfId || "" });
    }
  });

  collabSession.onMessage("collab:doc", (message) => {
    const state = collabSession.getState();
    if (message.sessionId !== state.sessionId || message.epoch !== state.epoch) return;
    const entry = entries.get(String(message.docId));
    const bytes = message.bytes as Uint8Array | undefined;
    if (!entry || !(bytes instanceof Uint8Array)) return;
    const lib = vendor();
    if (!lib) return;
    if (message.kind === "awareness") {
      lib.awarenessProtocol.applyAwarenessUpdate(entry.awareness, bytes, REMOTE);
      return;
    }
    if (message.kind !== "sync") return;
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
    if (path && hash) deps.editorSession.markSavedExternally(path, hash);
  });

  // Follow the editors: a model shown in a group gets its binding; the
  // binding keeps living while the model exists, even once hidden.
  const attached = new WeakSet<object>();
  const attachEditors = () => {
    for (const group of deps.editorSession.getEditorGroups()) {
      const editor = group.editor as any;
      if (!editor || attached.has(editor)) continue;
      attached.add(editor);
      editor.onDidChangeModel?.(() => {
        if (!collabSession.isActive()) return;
        window.setTimeout(() => {
          const model = editor.getModel?.();
          const path = getEditorModelPath(model);
          if (path && collabSession.isSharedPath(path)) bindModel(path, model);
          updateContextKeys();
        }, 0);
      });
    }
  };
  attachEditors();
  window.addEventListener("tex64:editor-created", attachEditors);

  const entryForEditor = (editor: any) => {
    const path = getEditorModelPath(editor?.getModel?.());
    return path ? entries.get(path) ?? null : null;
  };

  return {
    isBound: (path) => Boolean(path && collabSession.isSharedPath(path)),
    canHandleUndo: (editor) => Boolean(entryForEditor(editor)?.binding),
    undo: (editor) => {
      const entry = entryForEditor(editor);
      if (!entry?.undo) return false;
      entry.undo.undo();
      return true;
    },
    redo: (editor) => {
      const entry = entryForEditor(editor);
      if (!entry?.undo) return false;
      entry.undo.redo();
      return true;
    },
    sessionDoc: () => {
      const entry = entries.get(SESSION_DOC);
      return entry?.synced ? entry.doc : null;
    },
    sessionText: (path) => entries.get(path)?.ytext ?? null,
    onSessionDoc: (listener) => {
      sessionListeners.add(listener);
      const entry = entries.get(SESSION_DOC);
      if (entry?.synced) listener(entry.doc);
      return () => sessionListeners.delete(listener);
    },
    getVendor: vendor,
  };
};
