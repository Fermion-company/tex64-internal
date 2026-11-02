// Session state as the main process reports it, plus the IPC bridge. The
// renderer never opens a socket itself (the CSP stays unchanged): Y.Doc
// frames travel through tex64Collab.send / onMessage.

export type CollabParticipant = {
  id: string;
  name: string;
  color: string;
  connected: boolean;
  host: boolean;
  self: boolean;
};

export type CollabState = {
  active: boolean;
  phase: string;
  role?: "host" | "guest";
  sessionId?: string | null;
  epoch?: number;
  name?: string;
  inviteLink?: string | null;
  selfId?: string;
  connected?: boolean;
  participants: CollabParticipant[];
  textFiles: string[];
  rootPath?: string | null;
};

export type CollabMessage = { type: string; [key: string]: unknown };

type Bridge = {
  call: (action: string, payload?: Record<string, unknown>) => Promise<any>;
  onMessage: (handler: (message: CollabMessage) => void) => () => void;
  send: (docId: string, bytes: Uint8Array | null, meta: { kind: string; sessionId?: string | null; epoch?: number }) => void;
};

const bridge = (window as unknown as { tex64Collab?: Bridge }).tex64Collab ?? null;

let state: CollabState = { active: false, phase: "idle", participants: [], textFiles: [] };
const stateListeners = new Set<(state: CollabState) => void>();
const messageListeners = new Map<string, Set<(message: CollabMessage) => void>>();

const emitState = () => {
  for (const listener of stateListeners) {
    try {
      listener(state);
    } catch (error) {
      console.error("[collab] state listener failed", error);
    }
  }
};

bridge?.onMessage((message) => {
  if (!message || typeof message.type !== "string") return;
  if (message.type === "collab:state") {
    const { type: _type, ...rest } = message;
    state = { participants: [], textFiles: [], ...(rest as Partial<CollabState>), active: rest.active === true, phase: String(rest.phase || "idle") };
    emitState();
  }
  const listeners = messageListeners.get(message.type);
  if (listeners) for (const listener of listeners) {
    try {
      listener(message);
    } catch (error) {
      console.error("[collab] message listener failed", error);
    }
  }
});

const call = async (action: string, payload: Record<string, unknown> = {}) => {
  if (!bridge) throw new Error("Collaboration is not available in this window.");
  const result = await bridge.call(action, payload);
  if (!result?.ok) throw Object.assign(new Error(result?.error || "The collaboration request failed."), { code: result?.code });
  return result;
};

export const collabSession = {
  available: Boolean(bridge),
  getState: () => state,
  isActive: () => state.active,
  isGuest: () => state.active && state.role === "guest",
  isHost: () => state.active && state.role === "host",
  selfParticipant: () => state.participants.find((participant) => participant.self) ?? null,
  isSharedPath: (path: string | null | undefined) => Boolean(path && state.active && state.textFiles.includes(path)),
  onChange: (listener: (state: CollabState) => void) => {
    stateListeners.add(listener);
    return () => stateListeners.delete(listener);
  },
  onMessage: (type: string, listener: (message: CollabMessage) => void) => {
    let listeners = messageListeners.get(type);
    if (!listeners) {
      listeners = new Set();
      messageListeners.set(type, listeners);
    }
    listeners.add(listener);
    return () => listeners?.delete(listener);
  },
  call,
  status: () => call("status"),
  start: (name: string) => call("start", { name }),
  join: (link: string, name: string) => call("join", { link, name }),
  leave: () => call("leave"),
  flush: async (): Promise<boolean> => {
    if (!state.active) return true;
    try {
      const result = await call("flush");
      return result.flushed !== false;
    } catch {
      return false;
    }
  },
  send: (docId: string, kind: "sync" | "awareness" | "open" | "close", bytes: Uint8Array | null) => {
    if (!bridge || !state.active) return;
    bridge.send(docId, bytes, { kind, sessionId: state.sessionId, epoch: state.epoch });
  },
};
