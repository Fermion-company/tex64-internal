// Thin LSP client that speaks JSON-RPC over the tex64Lsp bridge (preload). The
// main process is a dumb stdio relay to texlab; all protocol logic — handshake,
// id-matched request/response, notification dispatch, server→client requests —
// lives here. Deliberately does NOT depend on monaco; the provider glue layer
// adapts results to monaco separately.
export class LspError extends Error {
    constructor(error) {
        var _a;
        super((_a = error === null || error === void 0 ? void 0 : error.message) !== null && _a !== void 0 ? _a : "LSP error");
        this.name = "LspError";
        this.code = typeof (error === null || error === void 0 ? void 0 : error.code) === "number" ? error.code : -32603;
        this.data = error === null || error === void 0 ? void 0 : error.data;
    }
}
export class LspClient {
    constructor(bridge) {
        this.nextId = 1;
        this.pending = new Map();
        this.notificationHandlers = new Map();
        this.requestHandlers = new Map();
        this.serverCapabilities = null;
        this.initialized = false;
        this.initializing = null;
        this.bridge = bridge;
        this.bridge.onMessage((message) => this.handleMessage(message));
        this.bridge.onStatus((status) => this.handleStatus(status));
    }
    get capabilities() {
        return this.serverCapabilities;
    }
    isReady() {
        return this.initialized;
    }
    handleStatus(status) {
        if ((status === null || status === void 0 ? void 0 : status.status) === "stopped" || (status === null || status === void 0 ? void 0 : status.status) === "unavailable") {
            this.reset(new Error(`LSP server ${status.status}${status.detail ? `: ${status.detail}` : ""}`));
        }
    }
    reset(reason) {
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
    handleMessage(message) {
        if (!message || typeof message !== "object") {
            return;
        }
        const hasId = message.id !== undefined && message.id !== null;
        // Response to a client→server request.
        if (hasId && (("result" in message) || ("error" in message)) && message.method === undefined) {
            const entry = this.pending.get(message.id);
            if (!entry) {
                return;
            }
            this.pending.delete(message.id);
            clearTimeout(entry.timer);
            if (message.error) {
                entry.reject(new LspError(message.error));
            }
            else {
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
                    }
                    catch (error) {
                        console.error(`[lsp] notification handler failed for ${message.method}`, error);
                    }
                });
            }
        }
    }
    handleServerRequest(message) {
        const method = message.method;
        const id = message.id;
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
            this.bridge.send({ jsonrpc: "2.0", id, result: result !== null && result !== void 0 ? result : null });
        })
            .catch((error) => {
            this.bridge.send({
                jsonrpc: "2.0",
                id,
                error: { code: -32603, message: error && error.message ? error.message : String(error) },
            });
        });
    }
    notify(method, params) {
        this.bridge.send({ jsonrpc: "2.0", method, params });
    }
    request(method, params, timeoutMs = 15000) {
        return new Promise((resolve, reject) => {
            const id = this.nextId++;
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`LSP request timed out: ${method}`));
            }, timeoutMs);
            this.pending.set(id, {
                resolve: resolve,
                reject,
                timer,
            });
            this.bridge.send({ jsonrpc: "2.0", id, method, params });
        });
    }
    onNotification(method, handler) {
        let handlers = this.notificationHandlers.get(method);
        if (!handlers) {
            handlers = new Set();
            this.notificationHandlers.set(method, handlers);
        }
        handlers.add(handler);
        return () => {
            handlers === null || handlers === void 0 ? void 0 : handlers.delete(handler);
        };
    }
    onRequest(method, handler) {
        this.requestHandlers.set(method, handler);
    }
    async initialize(params) {
        if (this.initialized) {
            return;
        }
        if (this.initializing) {
            return this.initializing;
        }
        this.initializing = (async () => {
            var _a, _b;
            const result = (_a = (await this.request("initialize", params, 20000))) !== null && _a !== void 0 ? _a : {};
            this.serverCapabilities = (_b = result.capabilities) !== null && _b !== void 0 ? _b : {};
            this.notify("initialized", {});
            this.initialized = true;
        })();
        try {
            await this.initializing;
        }
        catch (error) {
            this.initializing = null;
            throw error;
        }
    }
}
