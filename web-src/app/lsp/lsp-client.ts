// Thin LSP client that speaks JSON-RPC over the tex64Lsp bridge (preload). The
// main process is a dumb stdio relay to texlab; all protocol logic — handshake,
// id-matched request/response, notification dispatch, server→client requests —
// lives here. Deliberately does NOT depend on monaco; the provider glue layer
// adapts results to monaco separately.

export type JsonRpcId = number | string;

export type LspBridge = {
  send: (message: unknown) => void;
  onMessage: (handler: (message: unknown) => void) => () => void;
  onStatus: (
    handler: (status: { status: string; detail?: string | null }) => void
  ) => () => void;
  getStatus: () => Promise<{ available: boolean; running: boolean }>;
};

export class LspError extends Error {
  code: number;
  data: unknown;
  constructor(error: { code?: number; message?: string; data?: unknown }) {
    super(error?.message ?? "LSP error");
    this.name = "LspError";
    this.code = typeof error?.code === "number" ? error.code : -32603;
    this.data = error?.data;
  }
}

type PendingEntry = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

type AnyMessage = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

export class LspClient {
  private bridge: LspBridge;
  private nextId = 1;
  private pending = new Map<JsonRpcId, PendingEntry>();
  private notificationHandlers = new Map<string, Set<(params: unknown) => void>>();
  private requestHandlers = new Map<string, (params: unknown) => unknown>();
  private serverCapabilities: Record<string, unknown> | null = null;
  private initialized = false;
  private initializing: Promise<void> | null = null;

  constructor(bridge: LspBridge) {
    this.bridge = bridge;
    this.bridge.onMessage((message) => this.handleMessage(message as AnyMessage));
    this.bridge.onStatus((status) => this.handleStatus(status));
  }

  get capabilities(): Record<string, unknown> | null {
    return this.serverCapabilities;
  }

  isReady(): boolean {
    return this.initialized;
  }

  private handleStatus(status: { status: string; detail?: string | null }): void {
    if (status?.status === "stopped" || status?.status === "unavailable") {
      this.reset(new Error(`LSP server ${status.status}${status.detail ? `: ${status.detail}` : ""}`));
    }
  }

  private reset(reason: Error): void {
    this.initialized = false;
    this.initializing = null;
    this.serverCapabilities = null;
    const pending = Array.from(this.pending.values());
    this.pending.clear();
    pending.forEach((entry) => {
      clearTimeout(entry.timer);
      entry.reject(reason);
    });
  }

  private handleMessage(message: AnyMessage): void {
    if (!message || typeof message !== "object") {
      return;
    }
    const hasId = message.id !== undefined && message.id !== null;
    // Response to a client→server request.
    if (hasId && (("result" in message) || ("error" in message)) && message.method === undefined) {
      const entry = this.pending.get(message.id as JsonRpcId);
      if (!entry) {
        return;
      }
      this.pending.delete(message.id as JsonRpcId);
      clearTimeout(entry.timer);
      if (message.error) {
        entry.reject(new LspError(message.error));
      } else {
        entry.resolve(message.result);
      }
      return;
    }
    // Server→client request (needs a response).
    if (hasId && typeof message.method === "string") {
      this.handleServerRequest(message);
      return;
    }
    // Notification.
    if (typeof message.method === "string") {
      const handlers = this.notificationHandlers.get(message.method);
      if (handlers) {
        handlers.forEach((handler) => {
          try {
            handler(message.params);
          } catch (error) {
            console.error(`[lsp] notification handler failed for ${message.method}`, error);
          }
        });
      }
    }
  }

  private handleServerRequest(message: AnyMessage): void {
    const method = message.method as string;
    const id = message.id as JsonRpcId;
    const handler = this.requestHandlers.get(method);
    if (!handler) {
      this.bridge.send({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      });
      return;
    }
    Promise.resolve()
      .then(() => handler(message.params))
      .then((result) => {
        this.bridge.send({ jsonrpc: "2.0", id, result: result ?? null });
      })
      .catch((error) => {
        this.bridge.send({
          jsonrpc: "2.0",
          id,
          error: { code: -32603, message: error && error.message ? error.message : String(error) },
        });
      });
  }

  notify(method: string, params?: unknown): void {
    this.bridge.send({ jsonrpc: "2.0", method, params });
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs = 15000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      this.bridge.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  onNotification(method: string, handler: (params: unknown) => void): () => void {
    let handlers = this.notificationHandlers.get(method);
    if (!handlers) {
      handlers = new Set();
      this.notificationHandlers.set(method, handlers);
    }
    handlers.add(handler);
    return () => {
      handlers?.delete(handler);
    };
  }

  onRequest(method: string, handler: (params: unknown) => unknown): void {
    this.requestHandlers.set(method, handler);
  }

  async initialize(params: Record<string, unknown>): Promise<void> {
    if (this.initialized) {
      return;
    }
    if (this.initializing) {
      return this.initializing;
    }
    this.initializing = (async () => {
      const result = (await this.request<{ capabilities?: Record<string, unknown> }>(
        "initialize",
        params,
        20000
      )) ?? {};
      this.serverCapabilities = result.capabilities ?? {};
      this.notify("initialized", {});
      this.initialized = true;
    })();
    try {
      await this.initializing;
    } catch (error) {
      this.initializing = null;
      throw error;
    }
  }
}
