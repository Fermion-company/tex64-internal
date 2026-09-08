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

const { EventEmitter } = require('events');
const {
  spawnOwnedProcess,
  terminateWindowsProcessTree,
} = require('../process-tree.cjs');

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
    this.stopPromise = null;
    this.exitNotificationPromise = null;
  }

  isRunning() {
    return !!(this.child && !this._closed);
  }

  async start() {
    if (this.isRunning()) return this.initializeResult;
    this._closed = false;
    this.stopPromise = null;
    this.exitNotificationPromise = null;
    const env = { ...process.env, ...(this.opts.env || {}) };
    const useShell =
      process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(this.binPath);
    this.child = spawnOwnedProcess(this.binPath, ['app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      cwd: this.opts.cwd || undefined,
      detached: process.platform !== 'win32',
      shell: useShell,
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
      this._notifyExitAfterQuiescence({ error: err });
    });
    this.child.on('exit', (code, signal) => {
      this._closed = true;
      this.initialized = false;
      this._failAllPending(
        new Error(`codex app-server exited (code=${code}, signal=${signal})`)
      );
      this._notifyExitAfterQuiescence({
        code,
        signal,
        stderr: this.stderrTail.join('\n'),
      });
    });

    this.initializeResult = await this.request(
      'initialize',
      {
        clientInfo: CLIENT_INFO,
        capabilities: { experimentalApi: true },
      },
      { timeoutMs: 15000 },
    );
    this.notify('initialized');
    this.initialized = true;
    return this.initializeResult;
  }

  stop() {
    if (this.stopPromise) return this.stopPromise;
    const child = this.child;
    this._closed = true;
    this.initialized = false;
    this._failAllPending(new Error('codex app-server stopped'));
    if (!child) return Promise.resolve();

    this.stopPromise = new Promise((resolve, reject) => {
      let settled = false;
      let forceTimer = null;
      let postKillTimer = null;
      let windowsTerminationPromise = null;
      const processGroupAlive = () => {
        if (process.platform === 'win32' || !Number.isInteger(child.pid)) {
          return child.exitCode === null;
        }
        try {
          process.kill(-child.pid, 0);
          return true;
        } catch (error) {
          return error?.code !== 'ESRCH';
        }
      };
      const finish = (error = null) => {
        if (settled) return;
        settled = true;
        if (forceTimer !== null) clearTimeout(forceTimer);
        if (postKillTimer !== null) clearTimeout(postKillTimer);
        child.removeListener('exit', onExit);
        if (this.child === child) this.child = null;
        if (error) reject(error);
        else resolve();
      };
      const onExit = () => {
        // On POSIX the direct process can exit while a same-group descendant
        // still writes to the workspace. Only settle early if the whole group
        // is gone; otherwise the forced group kill below remains authoritative.
        if (process.platform !== 'win32' && !processGroupAlive()) finish();
      };
      child.once('exit', onExit);
      try {
        if (process.platform === 'win32' && Number.isInteger(child.pid)) {
          windowsTerminationPromise = terminateWindowsProcessTree(child);
          void windowsTerminationPromise.then((safe) => {
            finish(
              safe
                ? null
                : new Error('Codex Windows process-tree cleanup could not be verified.'),
            );
          });
        } else if (Number.isInteger(child.pid)) {
          process.kill(-child.pid, 'SIGTERM');
        } else {
          child.kill('SIGTERM');
        }
      } catch (_) { /* already dead */ }
      forceTimer = setTimeout(() => {
        try {
          if (process.platform === 'win32' && Number.isInteger(child.pid)) {
            const retry = windowsTerminationPromise?.then((safe) =>
              safe ? true : terminateWindowsProcessTree(child),
            ) ?? terminateWindowsProcessTree(child);
            void retry.then((safe) => {
              finish(
                safe
                  ? null
                  : new Error('Codex Windows process-tree cleanup could not be verified.'),
              );
            });
          } else if (Number.isInteger(child.pid)) {
            process.kill(-child.pid, 'SIGKILL');
          } else if (child.exitCode === null) {
            child.kill('SIGKILL');
          }
        } catch (_) { /* already dead */ }
        if (process.platform !== 'win32') {
          postKillTimer = setTimeout(finish, 150);
          if (typeof postKillTimer?.unref === 'function') postKillTimer.unref();
        }
      }, 2000);
      if (typeof forceTimer?.unref === 'function') forceTimer.unref();
      if (process.platform !== 'win32' && !processGroupAlive()) finish();
    });
    return this.stopPromise;
  }

  _notifyExitAfterQuiescence(payload) {
    if (this.exitNotificationPromise) return this.exitNotificationPromise;
    // The app-server can die while a detached command in the same process group
    // is still writing. Reuse the normal tree shutdown and only advertise the
    // backend as stopped once descendants have been terminated as well.
    this.exitNotificationPromise = Promise.resolve(this.stop()).then(
      () => {
        this.emit('exit', payload);
      },
      (error) => {
        this.emit('exit', { ...payload, error, cleanupFailed: true });
      },
    );
    return this.exitNotificationPromise;
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
