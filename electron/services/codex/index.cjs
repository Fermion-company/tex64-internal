'use strict';

// Codex backend service for TeX64.
//
// ユーザー自身の ChatGPT/Codex サブスクで AI 機能を動かすためのバックエンド。
// `codex app-server`（JSON-RPC over stdio）を子プロセスとして1本保持し、
// 会話キーごとに thread を張って、ログイン・ターン・承認応答を
// TeX64 向けの正規化イベントに変換する。
//
// Axiom(openprism) とは独立の並走実装。既存経路には触れない。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { CodexAppServerClient } = require('./app-server-client.cjs');

// codex バイナリ探索先。パッケージ版アプリは login shell の PATH を継承しないため、
// 一般的なインストール先を明示的に走査する。
function candidateBinPaths() {
  const home = os.homedir();
  const names = process.platform === 'win32' ? ['codex.exe', 'codex.cmd'] : ['codex'];
  const dirs = [
    ...(process.env.PATH || '').split(path.delimiter),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(home, '.local', 'bin'),
    path.join(home, '.codex', 'bin'),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.volta', 'bin'),
    path.join(home, '.bun', 'bin'),
    path.join(home, '.nodenv', 'shims'),
  ];
  const out = [];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const name of names) out.push(path.join(dir, name));
  }
  return out;
}

function resolveCodexBinary(customPath) {
  if (customPath && fs.existsSync(customPath)) return customPath;
  for (const p of candidateBinPaths()) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch (_) { /* keep looking */ }
  }
  return null;
}

function isInside(root, target) {
  if (!root || !target) return false;
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// 一部レスポンスは snake_case / camelCase が混在し得るので両対応で読む。
function pick(obj, ...keys) {
  if (!obj) return undefined;
  for (const k of keys) {
    if (obj[k] !== undefined) return obj[k];
  }
  return undefined;
}

const DEVELOPER_INSTRUCTIONS = [
  "You are the writing assistant inside TeX64, a LaTeX editor. The workspace is the user's LaTeX project.",
  'Edit files directly with minimal diffs, and make sure the document still compiles after substantive edits (use the tex64 MCP tools if available).',
  "Reply briefly in the user's language — your edits are shown to the user as diffs.",
].join(' ');

class CodexService extends EventEmitter {
  constructor() {
    super();
    this.client = null;
    this.clientStartPromise = null;
    this.stopPromise = null;
    this.binPath = null;
    this.account = null;
    this.pendingLoginId = null;
    this.pendingLogin = null;
    this.loginStartPromise = null;
    this.model = null;
    // 会話キー(conversationId) -> { threadId, cwd }
    this.sessions = new Map();
    this.threadStarts = new Map();
    this.threadGenerationByKey = new Map();
    this.threadEpoch = 0;
    // threadId -> 実行中 turnId
    this.turnByThread = new Map();
    // threadId -> cwd（承認判断用の逆引き）
    this.cwdByThread = new Map();
  }

  // ---- lifecycle -----------------------------------------------------------

  async ensureClient(customBinPath) {
    if (this.stopPromise) await this.stopPromise;
    if (this.clientStartPromise) return this.clientStartPromise;
    if (this.client && this.client.isRunning()) return this.client;
    const bin = resolveCodexBinary(customBinPath);
    if (!bin) {
      const err = new Error('codex-not-installed');
      err.code = 'CODEX_NOT_INSTALLED';
      throw err;
    }
    this.binPath = bin;
    const client = new CodexAppServerClient(bin);
    this.client = client;
    client.on('notification', (n) => this._onNotification(n));
    client.on('server-request', (req) => this._onServerRequest(req));
    client.on('exit', (info) => {
      if (this.client && this.client !== client) return;
      if (this.client === client) this.client = null;
      this.sessions.clear();
      this.turnByThread.clear();
      this.cwdByThread.clear();
      this._emit({
        type: 'backend-stopped',
        error: info.error ? info.error.message : `app-server exited (code=${info.code})`,
      });
    });
    const starting = client.start().then(() => client);
    this.clientStartPromise = starting;
    try {
      return await starting;
    } catch (error) {
      if (this.client === client) this.client = null;
      throw error;
    } finally {
      if (this.clientStartPromise === starting) this.clientStartPromise = null;
    }
  }

  stop() {
    if (this.stopPromise) return this.stopPromise;
    const stopPromise = this.client
      ? Promise.resolve(this.client.stop())
      : Promise.resolve();
    this.client = null;
    this.clientStartPromise = null;
    this.sessions.clear();
    this.threadStarts.clear();
    this.threadGenerationByKey.clear();
    this.threadEpoch += 1;
    this.turnByThread.clear();
    this.cwdByThread.clear();
    this.pendingLoginId = null;
    this.pendingLogin = null;
    this.loginStartPromise = null;
    const tracked = stopPromise.finally(() => {
      if (this.stopPromise === tracked) this.stopPromise = null;
    });
    this.stopPromise = tracked;
    return tracked;
  }

  // ---- auth ----------------------------------------------------------------

  async getStatus(customBinPath) {
    const bin = this.binPath || resolveCodexBinary(customBinPath);
    if (!bin) {
      return { installed: false, running: false, authenticated: false, account: null };
    }
    try {
      await this.ensureClient(customBinPath);
      const res = await this.client.request('account/read', { refreshToken: false }, { timeoutMs: 15000 });
      const account = pick(res, 'account');
      this.account = account || null;
      return {
        installed: true,
        binPath: bin,
        running: true,
        authenticated: !!account,
        account: account
          ? {
              type: pick(account, 'type'),
              email: pick(account, 'email'),
              planType: pick(account, 'planType', 'plan_type'),
            }
          : null,
        model: this.model,
      };
    } catch (err) {
      return {
        installed: true,
        binPath: bin,
        running: !!(this.client && this.client.isRunning()),
        authenticated: false,
        account: null,
        error: err.message,
      };
    }
  }

  async loginStart() {
    if (this.pendingLogin?.loginId && this.pendingLogin?.authUrl) {
      return { ...this.pendingLogin };
    }
    if (this.loginStartPromise) return this.loginStartPromise;
    this.loginStartPromise = (async () => {
      await this.ensureClient();
      const res = await this.client.request(
        'account/login/start',
        { type: 'chatgpt' },
        { timeoutMs: 15000 },
      );
      const authUrl = pick(res, 'authUrl', 'auth_url');
      this.pendingLoginId = pick(res, 'loginId', 'login_id');
      this.pendingLogin = { authUrl, loginId: this.pendingLoginId };
      return { ...this.pendingLogin };
    })();
    try {
      return await this.loginStartPromise;
    } finally {
      this.loginStartPromise = null;
    }
  }

  async loginCancel() {
    if (!this.client || !this.pendingLoginId) return;
    try {
      await this.client.request(
        'account/login/cancel',
        {
          loginId: this.pendingLoginId,
          login_id: this.pendingLoginId,
        },
        { timeoutMs: 15000 },
      );
    } catch (_) { /* best effort */ }
    this.pendingLoginId = null;
    this.pendingLogin = null;
  }

  async logout() {
    await this.ensureClient();
    await this.client.request('account/logout', {}, { timeoutMs: 15000 });
    this.account = null;
    this.sessions.clear();
    this._emit({ type: 'account-updated', account: null });
  }

  async rateLimits() {
    await this.ensureClient();
    return this.client.request('account/rateLimits/read', {}, { timeoutMs: 15000 });
  }

  // ---- threads / turns -----------------------------------------------------

  async ensureThread(key, projectDir) {
    await this.ensureClient();
    const client = this.client;
    const epoch = this.threadEpoch;
    const existing = this.sessions.get(key);
    if (existing && existing.cwd === projectDir) return existing.threadId;
    const pending = this.threadStarts.get(key);
    if (pending && pending.cwd === projectDir && pending.client === client) {
      return pending.promise;
    }
    const generation = (this.threadGenerationByKey.get(key) || 0) + 1;
    this.threadGenerationByKey.set(key, generation);
    const isCurrentStart = () =>
      this.threadEpoch === epoch &&
      this.threadGenerationByKey.get(key) === generation &&
      this.client === client &&
      client?.isRunning();
    const promise = (async () => {
      const params = {
        cwd: projectDir,
        developerInstructions: DEVELOPER_INSTRUCTIONS,
        approvalPolicy: 'never',
        sandbox: 'workspace-write',
      };
      let res;
      try {
        res = await client.request('thread/start', params, { timeoutMs: 15000 });
      } catch (err) {
        // Only compatibility failures may retry without the optional enums.
        // A timeout/stop or a superseded workspace must never create a second
        // late thread whose response could overwrite the current session.
        if (
          !isCurrentStart() ||
          /timed out|stopped|exited/i.test(err?.message || '')
        ) {
          throw err;
        }
        res = await client.request(
          'thread/start',
          {
            cwd: projectDir,
            developerInstructions: DEVELOPER_INSTRUCTIONS,
          },
          { timeoutMs: 15000 },
        );
      }
      if (!isCurrentStart()) {
        const error = new Error('Codex thread start was superseded.');
        error.code = 'CODEX_THREAD_SUPERSEDED';
        throw error;
      }
      const threadId = res && res.thread && res.thread.id;
      if (typeof threadId !== 'string' || !threadId) {
        throw new Error('Codex did not return a thread identity.');
      }
      this.sessions.set(key, { threadId, cwd: projectDir });
      this.cwdByThread.set(threadId, projectDir);
      this.model = pick(res, 'model') || this.model;
      this._emit({ type: 'thread-started', key, threadId, model: this.model });
      return threadId;
    })();
    const startEntry = { cwd: projectDir, client, generation, promise };
    this.threadStarts.set(key, startEntry);
    try {
      return await promise;
    } finally {
      if (this.threadStarts.get(key) === startEntry) this.threadStarts.delete(key);
    }
  }

  resetThread(key) {
    const existing = this.sessions.get(key);
    if (existing) {
      this.cwdByThread.delete(existing.threadId);
      this.turnByThread.delete(existing.threadId);
    }
    this.threadGenerationByKey.set(
      key,
      (this.threadGenerationByKey.get(key) || 0) + 1,
    );
    this.threadStarts.delete(key);
    this.sessions.delete(key);
  }

  threadIdFor(key) {
    const entry = this.sessions.get(key);
    return entry ? entry.threadId : null;
  }

  async sendMessage({ key, projectDir, text, images, model }) {
    const threadId = await this.ensureThread(key, projectDir);
    const client = this.client;
    const activeSession = this.sessions.get(key);
    if (
      !client?.isRunning() ||
      activeSession?.threadId !== threadId ||
      activeSession?.cwd !== projectDir
    ) {
      const error = new Error('Codex thread was superseded before the turn started.');
      error.code = 'CODEX_THREAD_SUPERSEDED';
      throw error;
    }
    const input = [{ type: 'text', text }];
    for (const img of images || []) {
      // img: data URL 文字列 or ローカルパス
      if (typeof img === 'string' && img.startsWith('data:')) {
        input.push({ type: 'image', url: img });
      } else if (typeof img === 'string') {
        input.push({ type: 'localImage', path: img });
      }
    }
    const params = { threadId, input };
    if (typeof model === 'string' && model.trim()) params.model = model.trim();
    let res;
    try {
      res = await client.request('turn/start', params, { timeoutMs: 15000 });
    } catch (error) {
      // A timed-out turn/start may still execute after its response was lost.
      // Reset the singleton so no untracked workspace writer can survive.
      await this.stop();
      throw error;
    }
    const turn = res && res.turn;
    const currentSession = this.sessions.get(key);
    if (
      this.client !== client ||
      currentSession?.threadId !== threadId ||
      currentSession?.cwd !== projectDir
    ) {
      // turn/start succeeded, so the backend may already be writing. Stop the
      // process tree before exposing the superseded error to the caller.
      await this.stop();
      const error = new Error('Codex turn started in a superseded thread.');
      error.code = 'CODEX_THREAD_SUPERSEDED';
      throw error;
    }
    if (turn && turn.id) this.turnByThread.set(threadId, turn.id);
    return { threadId, turnId: turn && turn.id };
  }

  async interrupt(key) {
    const threadId = this.threadIdFor(key);
    if (!this.client || !threadId) return;
    const turnId = this.turnByThread.get(threadId);
    if (!turnId) return;
    try {
      await this.client.request(
        'turn/interrupt',
        { threadId, turnId },
        { timeoutMs: 7500 },
      );
    } catch (_) { /* turn may have already finished */ }
  }

  async quiesceThread(key, expectedThreadId = null) {
    const session = this.sessions.get(key);
    const client = this.client;
    const threadId = session?.threadId;
    if (
      !client?.isRunning() ||
      !threadId ||
      (expectedThreadId && threadId !== expectedThreadId)
    ) {
      throw new Error('Codex thread is unavailable for terminal cleanup.');
    }

    const listAll = async () => {
      const terminals = [];
      let cursor = null;
      for (let page = 0; page < 100; page += 1) {
        const response = await client.request(
          'thread/backgroundTerminals/list',
          { threadId, cursor, limit: 100 },
          { timeoutMs: 5000 },
        );
        if (Array.isArray(response?.data)) terminals.push(...response.data);
        cursor = typeof response?.nextCursor === 'string' && response.nextCursor
          ? response.nextCursor
          : null;
        if (!cursor) return terminals;
      }
      throw new Error('Codex returned too many background terminal pages.');
    };

    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const terminals = await listAll();
        for (const terminal of terminals) {
          if (typeof terminal?.processId !== 'string' || !terminal.processId) continue;
          await client.request(
            'thread/backgroundTerminals/terminate',
            { threadId, processId: terminal.processId },
            { timeoutMs: 5000 },
          );
        }
        await client.request(
          'thread/backgroundTerminals/clean',
          { threadId },
          { timeoutMs: 5000 },
        );
        if ((await listAll()).length === 0) return true;
      }
      throw new Error('Codex background terminals did not stop.');
    } catch (error) {
      // Losing conversation reuse is preferable to scanning/building while an
      // untracked workspace writer may still be alive.
      await this.stop();
      throw error;
    }
  }

  // ---- event normalization -------------------------------------------------

  _emit(event) {
    this.emit('event', event);
  }

  _onNotification({ method, params }) {
    const p = params || {};
    const threadId = p.threadId;
    const notificationTurnId = pick(p, 'turnId', 'turn_id');
    const activeNotificationTurnId =
      notificationTurnId || (threadId ? this.turnByThread.get(threadId) : null);
    switch (method) {
      case 'item/agentMessage/delta':
        this._emit({
          type: 'assistant-delta',
          threadId,
          turnId: activeNotificationTurnId,
          itemId: p.itemId,
          text: p.delta || '',
        });
        return;
      case 'item/started':
      case 'item/completed': {
        const item = this._normalizeItem(p.item);
        if (item) {
          this._emit({
            type: method === 'item/started' ? 'item-started' : 'item-completed',
            threadId,
            turnId: activeNotificationTurnId,
            item,
          });
        }
        return;
      }
      case 'item/commandExecution/outputDelta':
        this._emit({
          type: 'command-output-delta',
          threadId,
          turnId: activeNotificationTurnId,
          itemId: p.itemId,
          delta: p.delta || '',
        });
        return;
      case 'turn/started': {
        const turnId = p.turn && p.turn.id;
        if (threadId && turnId) this.turnByThread.set(threadId, turnId);
        this._emit({ type: 'turn-started', threadId, turnId });
        return;
      }
      case 'turn/completed': {
        const turnId = pick(p.turn, 'id') || notificationTurnId;
        if (threadId && turnId && this.turnByThread.get(threadId) === turnId) {
          this.turnByThread.delete(threadId);
        }
        const usage = (p.turn && p.turn.usage) || p.usage || null;
        const status = pick(p.turn, 'status');
        if (status === 'failed' || status === 'interrupted') {
          const turnError = pick(p.turn, 'error');
          this._emit({
            type: 'turn-failed',
            threadId,
            turnId,
            error:
              (turnError && (turnError.message || turnError)) ||
              (status === 'interrupted'
                ? 'Codex turn was interrupted.'
                : 'Codex turn failed.'),
          });
          return;
        }
        this._emit({ type: 'turn-completed', threadId, turnId, usage });
        return;
      }
      case 'turn/failed': {
        const turnId = pick(p.turn, 'id') || notificationTurnId;
        if (threadId && turnId && this.turnByThread.get(threadId) === turnId) {
          this.turnByThread.delete(threadId);
        }
        this._emit({
          type: 'turn-failed',
          threadId,
          turnId,
          error: (p.error && (p.error.message || p.error)) || 'turn failed',
        });
        return;
      }
      case 'account/login/completed': {
        const loginId = pick(p, 'loginId', 'login_id') || this.pendingLoginId;
        this.pendingLoginId = null;
        this.pendingLogin = null;
        this._emit({
          type: 'login-completed',
          loginId,
          success: !!pick(p, 'success'),
          error: pick(p, 'error') || null,
        });
        return;
      }
      case 'account/updated':
        this.account = pick(p, 'account') || this.account;
        this._emit({ type: 'account-updated', account: this.account });
        return;
      case 'error':
        this._emit({
          type: 'error',
          threadId,
          turnId: activeNotificationTurnId,
          message: (p.error && (p.error.message || p.error)) || p.message || 'unknown codex error',
        });
        return;
      default:
        // thread/status/changed, mcpServer/startupStatus/updated, tokenUsage 等は
        // 現状 UI に出さない。必要になったらここで拾う。
        return;
    }
  }

  _normalizeItem(raw) {
    if (!raw) return null;
    const t = raw.type;
    const base = { id: raw.id, kind: t };
    switch (t) {
      case 'agentMessage':
        return { ...base, text: raw.text || '' };
      case 'reasoning':
        return {
          ...base,
          text: Array.isArray(raw.summary) ? raw.summary.join('\n') : (raw.summary || ''),
        };
      case 'commandExecution':
        return {
          ...base,
          command: Array.isArray(raw.command) ? raw.command.join(' ') : (raw.command || ''),
          output: raw.aggregatedOutput || raw.output || '',
          exitCode: raw.exitCode,
          status: raw.status,
        };
      case 'fileChange':
        return {
          ...base,
          status: raw.status,
          changes: (raw.changes || []).map((c) => ({
            path: c.path,
            kind: c.kind && (c.kind.type || c.kind),
            diff: c.diff || '',
          })),
        };
      case 'mcpToolCall':
        return { ...base, server: raw.server, tool: raw.tool, status: raw.status };
      case 'webSearch':
        return { ...base, query: raw.query };
      case 'error':
        return { ...base, text: raw.message || '' };
      case 'userMessage':
        return null; // echo は捨てる（UI 側で既に描画済み）
      default:
        return { ...base };
    }
  }

  // ---- approvals -----------------------------------------------------------

  _cwdForThread(threadId) {
    return (threadId && this.cwdByThread.get(threadId)) || null;
  }

  _onServerRequest(req) {
    const { method, params, respond, reject } = req;
    const p = params || {};
    const root = this._cwdForThread(p.threadId);
    if (method === 'item/commandExecution/requestApproval') {
      const cwd = p.cwd || root;
      const ok = !!root && isInside(root, cwd);
      respond({ decision: ok ? 'accept' : 'decline' });
      this._emit({
        type: 'approval-auto',
        threadId: p.threadId,
        target: 'command',
        decision: ok ? 'accept' : 'decline',
        summary: Array.isArray(p.command) ? p.command.join(' ') : String(p.command || ''),
      });
      return;
    }
    if (method === 'item/fileChange/requestApproval') {
      const changes = p.changes || p.fileChanges || [];
      const paths = changes.map((c) => c.path).filter(Boolean);
      const ok = !!root && (paths.length === 0 || paths.every((f) => isInside(root, path.isAbsolute(f) ? f : path.join(root, f))));
      respond({ decision: ok ? 'accept' : 'decline' });
      this._emit({
        type: 'approval-auto',
        threadId: p.threadId,
        target: 'fileChange',
        decision: ok ? 'accept' : 'decline',
        summary: paths.join(', '),
      });
      return;
    }
    if (method === 'item/permissions/requestApproval') {
      respond({ decision: 'decline' });
      return;
    }
    // requestUserInput / elicitation / attestation 等は現状未対応。
    reject(`unsupported server request: ${method}`);
  }
}

// singleton
let serviceInstance = null;
function getCodexService() {
  if (!serviceInstance) serviceInstance = new CodexService();
  return serviceInstance;
}

module.exports = { getCodexService, resolveCodexBinary, CodexService };
