'use strict';

// Minimal JSON-RPC (JSONL over stdio) client for `codex app-server`.
// Wire format: JSON-RPC 2.0 semantics with the `jsonrpc` header omitted,
// one JSON object per line on stdin/stdout.
//
// - request(method, params)  -> Promise<result>
// - notify(method, params)   -> fire-and-forget notification
// - onNotification(fn)       -> fn({ method, params })
// - onServerRequest(fn)      -> fn({ id, method, params }, respond(result), reject(error))
//   サーバー発リクエスト（承認要求など）。ハンドラが respond を呼ばなければ
//   タイムアウト等はサーバー側に委ねる。

const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const CLIENT_INFO = {
  name: 'tex64',
  title: 'TeX64',
  version: '0.1.0',
};

class CodexAppServerClient extends EventEmitter {
  constructor(binPath, opts = {}) {
    super();
    this.binPath = binPath;
    this.opts = opts;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map(); // id -> {resolve, reject, method}
    this.initialized = false;
    this.initializeResult = null;
    this.stderrTail = [];
    this._buf = '';
    this._closed = false;
  }

  isRunning() {
    return !!(this.child && !this._closed);
  }

  async start() {
    if (this.isRunning()) return this.initializeResult;
    this._closed = false;
    const env = { ...process.env, ...(this.opts.env || {}) };
    this.child = spawn(this.binPath, ['app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      cwd: this.opts.cwd || undefined,
    });

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this._onData(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (!text) return;
      this.stderrTail.push(text);
      if (this.stderrTail.length > 50) this.stderrTail.shift();
      this.emit('stderr', text);
    });
    this.child.on('error', (err) => {
      this._failAllPending(new Error(`codex app-server spawn error: ${err.message}`));
      this._closed = true;
      this.emit('exit', { error: err });
    });
    this.child.on('exit', (code, signal) => {
      this._closed = true;
      this.initialized = false;
      this._failAllPending(
        new Error(`codex app-server exited (code=${code}, signal=${signal})`)
      );
      this.emit('exit', { code, signal, stderr: this.stderrTail.join('\n') });
    });

    this.initializeResult = await this.request('initialize', {
      clientInfo: CLIENT_INFO,
      capabilities: { experimentalApi: true },
    });
    this.notify('initialized');
    this.initialized = true;
    return this.initializeResult;
  }

  stop() {
    if (this.child) {
      try { this.child.kill(); } catch (_) { /* already dead */ }
    }
    this._closed = true;
    this.initialized = false;
  }

  request(method, params, { timeoutMs = 0 } = {}) {
    if (!this.child || this._closed) {
      return Promise.reject(new Error('codex app-server is not running'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      let timer = null;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`codex request timed out: ${method}`));
        }, timeoutMs);
      }
      this.pending.set(id, {
        method,
        resolve: (v) => { if (timer) clearTimeout(timer); resolve(v); },
        reject: (e) => { if (timer) clearTimeout(timer); reject(e); },
      });
      this._write({ id, method, params });
    });
  }

  notify(method, params) {
    if (!this.child || this._closed) return;
    this._write(params === undefined ? { method } : { method, params });
  }

  respond(id, result) {
    this._write({ id, result: result === undefined ? null : result });
  }

  respondError(id, message, code = -32000) {
    this._write({ id, error: { code, message } });
  }

  _write(obj) {
    try {
      this.child.stdin.write(JSON.stringify(obj) + '\n');
    } catch (err) {
      this.emit('stderr', `stdin write failed: ${err.message}`);
    }
  }

  _onData(chunk) {
    this._buf += chunk;
    let idx;
    while ((idx = this._buf.indexOf('\n')) >= 0) {
      const line = this._buf.slice(0, idx).trim();
      this._buf = this._buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (_) {
        this.emit('stderr', `unparsable line from app-server: ${line.slice(0, 200)}`);
        continue;
      }
      this._dispatch(msg);
    }
  }

  _dispatch(msg) {
    // Response to one of our requests
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        const e = new Error(msg.error.message || 'codex request failed');
        e.code = msg.error.code;
        e.data = msg.error.data;
        e.rpcMethod = p.method;
        p.reject(e);
      } else {
        p.resolve(msg.result);
      }
      return;
    }
    // Server-initiated request (needs a response) — e.g. approval requests
    if (msg.id !== undefined && msg.method !== undefined) {
      this.emit('server-request', {
        id: msg.id,
        method: msg.method,
        params: msg.params,
        respond: (result) => this.respond(msg.id, result),
        reject: (message, code) => this.respondError(msg.id, message, code),
      });
      return;
    }
    // Notification
    if (msg.method !== undefined) {
      this.emit('notification', { method: msg.method, params: msg.params });
    }
  }

  _failAllPending(err) {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }
}

module.exports = { CodexAppServerClient };
