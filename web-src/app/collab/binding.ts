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
import { getEditorOperationGuard } from "../editor-operation-guard.js";
import { uiText } from "../i18n.js";

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
  const lastSavedDigest = new Map<string, string>();
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

  // ---- presence in including files --------------------------------------
  // A participant editing sections/results.tex is also shown in main.tex (and
  // any other open file that \input / \include-s results.tex): a colour bar
  // in the gutter and their name after the include line.
  type Presence = { docId: string; name: string; color: string; at: number };
  const presenceDecorations = new WeakMap<object, { clear: () => void; set: (d: unknown[]) => void }>();
  const normalizePath = (value: string) => value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/{2,}/g, "/").replace(/\/\.\//g, "/");
  const joinPath = (dir: string, file: string) => {
    const parts = normalizePath(dir ? `${dir}/${file}` : file).split("/");
    const out: string[] = [];
    for (const part of parts) {
      if (part === "..") out.pop();
      else if (part !== "." && part !== "") out.push(part);
    }
    return out.join("/");
  };
  const stripComment = (line: string) => {
    let out = "";
    for (let i = 0; i < line.length; i += 1) {
      if (line[i] === "\\") { out += line.slice(i, i + 2); i += 1; }
      else if (line[i] === "%") break;
      else out += line[i];
    }
    return out;
  };
  // Lines of `text` (file at `path`) that read another shared file: line → docId.
  const includeLines = (path: string, text: string) => {
    const result = new Map<number, string>();
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    const lines = text.split("\n");
    const pattern = /\\(?:input|include|subfile|subfileinclude)\s*\{([^}]*)\}|\\input\s+([^\s{}\\%]+)/g;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line.includes("\\")) continue;
      const source = stripComment(line);
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(source))) {
        const file = (match[1] || match[2] || "").trim();
        if (!file) continue;
        const withExt = /\.[A-Za-z0-9]+$/.test(file) ? file : `${file}.tex`;
        for (const candidate of [joinPath(dir, withExt), joinPath("", withExt)]) {
          if (entries.has(candidate) || collabSession.isSharedPath(candidate)) {
            result.set(index + 1, candidate);
            break;
          }
        }
      }
    }
    return result;
  };
  // Every participant announces the file they are in on the session doc's
  // awareness (`at`), which everyone holds; per-file awareness only reaches
  // those who have that file open.
  let announcedDoc: string | null = null;
  const publishLocation = (force = false) => {
    const session = entries.get(SESSION_DOC);
    if (!session) return;
    const active = deps.editorSession.getActiveGroup();
    const path = active?.currentFilePath && collabSession.isSharedPath(active.currentFilePath) ? active.currentFilePath : null;
    if (!force && path === announcedDoc) return;
    announcedDoc = path;
    session.awareness.setLocalStateField("at", path ? { docId: path } : null);
  };
  const remotePresence = () => {
    const byClient = new Map<number, Presence>();
    const session = entries.get(SESSION_DOC);
    if (!session) return byClient;
    const states: Map<number, any> = session.awareness.getStates();
    states.forEach((state, id) => {
      if (id === clientId || !state?.user || !state.at?.docId) return;
      byClient.set(id, { docId: normalizePath(String(state.at.docId)), name: String(state.user.name || "").slice(0, 40) || "?", color: String(state.user.color || "#2563eb"), at: 0 });
    });
    return byClient;
  };
  let presenceTimer: number | null = null;
  const renderPresence = () => {
    presenceTimer = null;
    const monacoApi = (window as any).monaco;
    const presence = collabSession.isActive() ? remotePresence() : new Map<number, Presence>();
    for (const group of deps.editorSession.getEditorGroups()) {
      const editor = group.editor as any;
      const model = editor?.getModel?.();
      const path = getEditorModelPath(model);
      let holder = presenceDecorations.get(editor);
      if (!editor || !model || !path) { holder?.clear(); continue; }
      if (!holder) {
        const collection = editor.createDecorationsCollection?.([]);
        if (!collection) continue;
        holder = { clear: () => collection.clear(), set: (d) => collection.set(d) };
        presenceDecorations.set(editor, holder);
      }
      if (presence.size === 0 || !monacoApi?.Range) { holder.clear(); continue; }
      const lines = includeLines(path, model.getValue());
      const decorations: unknown[] = [];
      if (lines.size) {
        for (const [id, who] of presence) {
          for (const [line, docId] of lines) {
            if (docId !== who.docId || line > model.getLineCount()) continue;
            const end = model.getLineMaxColumn(line);
            decorations.push({
              range: new monacoApi.Range(line, 1, line, end),
              options: {
                linesDecorationsClassName: `collab-presence-gutter-${id}`,
                after: { content: who.name, inlineClassName: `collab-presence-tag-${id}`, cursorStops: 0 },
                stickiness: 1,
              },
            });
          }
        }
      }
      holder.set(decorations);
    }
  };
  const schedulePresence = (delay = 50) => {
    if (presenceTimer !== null) return;
    presenceTimer = window.setTimeout(renderPresence, delay);
  };
  // The local selection lives only in the file an editor shows; a model that
  // just left every editor must not keep saying we are still there.
  const clearHiddenSelections = () => {
    for (const entry of entries.values()) {
      if (entry.docId === SESSION_DOC || !entry.model) continue;
      if (groupsShowing(entry.model).length === 0 && entry.awareness.getLocalState()?.selection) {
        entry.awareness.setLocalStateField("selection", null);
      }
    }
  };

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
      // A view-only guest's buffer never goes into the shared text.
      const hadLocalEdits = !collabSession.isViewer() && typeof savedContent === "string" && savedContent !== modelValue;
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
    if (entry.model?.onDidChangeContent) {
      const contentDisposable = entry.model.onDidChangeContent(() => schedulePresence(300));
      entry.disposables.push(() => contentDisposable?.dispose?.());
    }
    schedulePresence();
    deps.editorSession.updateDirtyState(entry.docId, entry.model.getValue());
    // A rejoin wrote the host's content before this model was bound; the ACK
    // arrived while the buffer still held the old text. Settle it now.
    const saved = lastSavedDigest.get(entry.docId);
    if (saved && saved === contentDigest(entry.model.getValue())) deps.editorSession.markSavedExternally(entry.docId, saved);
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
      collabCursors.observe(awareness.getStates(), clientId, origin === REMOTE);
      if (origin === REMOTE) schedulePresence();
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
    announcedDoc = null;
    publishLocation(true);
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
      // A buffer is saved only if its content is what the host last wrote;
      // anything typed after that stays dirty and saves the ordinary way.
      const digest = model ? contentDigest(model.getValue()) : "";
      if (model && entry && lastSavedDigest.get(docId) === digest) deps.editorSession.markSavedExternally(docId, digest);
    }
    lastSavedDigest.clear();
    collabCursors.reset();
    updateContextKeys();
    schedulePresence();
  };

  // View-only guest: every editor is read-only for the whole session (the
  // mirror is the host's folder). New editors (split view) follow.
  const viewGuard = getEditorOperationGuard(deps.editorSession);
  const syncViewLock = () => {
    const viewer = collabSession.isViewer();
    viewGuard.setLocked("collab-view", viewer);
    // Typing in a locked editor says why, in the user's language.
    const message = viewer ? { value: uiText("You joined to view, so you cannot edit.", "閲覧のみで参加しているため、編集できません。") } : undefined;
    for (const group of deps.editorSession.getEditorGroups()) (group.editor as any)?.updateOptions?.({ readOnlyMessage: message });
  };
  window.addEventListener("tex64:editor-created", () => { if (collabSession.isViewer()) syncViewLock(); });

  collabSession.onChange((state) => {
    syncViewLock();
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
      publishLocation();
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
    if (path && hash) {
      lastSavedDigest.set(path, hash);
      deps.editorSession.markSavedExternally(path, hash);
    }
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
          clearHiddenSelections();
          publishLocation();
          schedulePresence();
        }, 0);
      });
      editor.onDidFocusEditorWidget?.(() => {
        if (!collabSession.isActive()) return;
        publishLocation();
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
