'use strict';
const fs = require('node:fs/promises');
const { constants, realpathSync } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { WorkspaceOperationCoordinator } = require('./workspace-operation.cjs');
const { GitRunner } = require('./git-runner.cjs');
const { GitService } = require('./git-service.cjs');
const { GitNetwork } = require('./git-network.cjs');
const { GitVault } = require('./git-vault.cjs');
const { getGitVaultKey } = require('./git-vault-key.cjs');
const { GitTransaction } = require('./git-transaction.cjs');
const { getGitRuntime } = require('./git-runtime.cjs');
const fail = (code, message) => Object.assign(new Error(message), { code });
const safePath = value => {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.includes('\\') || path.isAbsolute(value) || value.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) throw fail('GIT_PATH_INVALID', 'Choose an open project file.');
  return value;
};
const publicTransaction = value => value ? Object.fromEntries(['id','kind','phase','outcome','recoveryRequired','hasBefore','hasAfter','hasRecoveryProtection'].filter(key => Object.hasOwn(value,key)).map(key => [key,value[key]])) : null;
const publicState = state => {
  if (!state) return null;
  const keys = ['repository', 'layout', 'supported', 'unsupportedReason', 'head', 'branchRef', 'branch', 'unborn', 'detached', 'refs', 'status', 'operation', 'remotes'];
  return Object.fromEntries(keys.filter(key => Object.hasOwn(state, key)).map(key => [key, state[key]]));
};
class GitController {
  constructor(deps) {
    this.deps = deps; this.coordinator = deps.coordinator || new WorkspaceOperationCoordinator();
    this.operation = null; this.sessions = new Map(); this.plans = new Map(); this.preparedRoot = null; this.boundaries = new Map(); this.boundaryJournals = new Map(); this.conflicts = new Map();
  }
  directory(root = this.deps.workspace.getRootPath()) {
    const base = typeof this.deps.directory === 'function' ? this.deps.directory() : this.deps.directory;
    return path.join(base, crypto.createHash('sha256').update(realpathSync(root)).digest('hex'));
  }
  boundary(root) { return this.boundaries.get(root) || null; }
  async loadBoundary(root) {
    try { const value = JSON.parse(await fs.readFile(path.join(this.directory(root), 'boundary.json'), 'utf8')); if (typeof value.id !== 'string' || !/^(?:[a-f0-9-]{36}|[a-f0-9]{64})$/.test(value.id)) throw fail('GIT_BOUNDARY_INVALID', 'Git boundary is invalid.'); this.boundaries.set(root, value.id); this.boundaryJournals.set(root, value.journals || null); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  journalFingerprint(journals) {
    const rows = journals.filter(item => ['branch-create','branch-switch','merge','merge-abort','resolution','shelve','unshelve'].includes(item.kind) || ['recovery-required','recovered'].includes(item.phase)).map(item => [item.id, item.createdAt, item.phase === 'unshelved', item.phase === 'recovered']).sort((a,b) => a[0].localeCompare(b[0]));
    return rows.length ? crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex') : null;
  }
  async persistBoundary(op) {
    const directory = this.directory(op.root); await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const session = this.sessions.get(await fs.realpath(op.root));
    const journals = session?.transaction ? this.journalFingerprint(await session.transaction.list()) : null;
    const filename = path.join(directory, 'boundary.json'), temporary = path.join(directory, `.boundary-${crypto.randomUUID()}.tmp`);
    try { const fd = await fs.open(temporary, 'wx', 0o600); try { await fd.writeFile(JSON.stringify({ id: op.boundaryId || op.id, journals })); await fd.sync(); } finally { await fd.close(); } await fs.rename(temporary, filename); const parent = await fs.open(directory, 'r'); try { await parent.sync(); } finally { await parent.close(); } this.boundaries.set(op.root, op.boundaryId || op.id); this.boundaryJournals.set(op.root, journals); }
    finally { await fs.unlink(temporary).catch(() => {}); }
  }
  identity() { return { workspaceId: this.deps.state.workspaceId, workspaceGeneration: this.deps.state.workspaceGeneration }; }
  validate(request) {
    const current = this.identity();
    if (!this.deps.workspace.getRootPath() || !request || request.workspaceId !== current.workspaceId || !Number.isSafeInteger(request.workspaceGeneration) || request.workspaceGeneration !== current.workspaceGeneration) throw fail('STALE_WORKSPACE', 'The project changed. Reopen Git and try again.');
  }
  status() { const op = this.operation; return { ...this.identity(), phase: op?.phase || 'idle', error: op?.error || null, ...(['recovery-required', 'syncing', 'conflict'].includes(op?.phase) ? { token: op.id, recoveryId: op.recoveryId || null } : {}) }; }
  emit() { this.deps.notify?.('git:state', this.status()); this.coordinator.emit(); }
  claim(op) { this.coordinator.claim('git', op); this.operation = op; this.emit(); }
  clear() { if (this.operation) this.coordinator.release('git', this.operation.id); this.operation = null; this.plans.clear(); this.conflicts.clear(); this.emit(); }
  blocked() { return this.coordinator.blocked(); }
  assertWriterAllowed() { this.coordinator.assertWriterAllowed(); }
  // Public writer lease: only final CAS saves during saving may use this token.
  run(token, action) {
    if (token !== null && token !== undefined && (this.operation?.id !== token || this.operation.phase !== 'saving')) throw fail('GIT_BUSY', 'This saving permission has expired.');
    return this.coordinator.run(token, action);
  }
  async session() {
    const root = await fs.realpath(this.deps.workspace.getRootPath());
    if (!this.sessions.has(root)) {
      const runtime = typeof this.deps.runtime === 'function' ? this.deps.runtime() : this.deps.runtime || getGitRuntime();
      const runner = new GitRunner({ binaryPath: runtime.binary, root, env: runtime.env });
      const session = { root, runtime, runner, transaction: null };
      session.service = new GitService({ runner, withMutation: async (meta, action) => {
        const tx = await this.transaction(session);
        this.operation.writesWorktree = Boolean(meta.writesWorktree);
        this.operation.beforeFingerprint = await session.vault.fingerprint({ root: session.root });
        const resume = (await tx.list()).find(item => item.phase === 'conflict');
        return tx.run({ ...meta, ...(resume ? { resumeId: resume.id } : {}) }, action);
      } });
      session.network = new GitNetwork({ runner, runtime, allowTestLocalRemote: this.deps.allowTestLocalRemote === true, withMutation: action => action() });
      this.sessions.set(root, session);
    }
    return this.sessions.get(root);
  }
  async transaction(session) {
    if (!session.transaction) {
      const directory = this.directory(session.root);
      const key = await getGitVaultKey({ directory, safeStorage: this.deps.safeStorage });
      try { session.vault = new GitVault({ directory: path.join(directory, 'vault'), key }); }
      finally { key.fill(0); }
      session.transaction = new GitTransaction({ runner: session.runner, vault: session.vault, directory: path.join(directory, 'journals') });
    }
    return session.transaction;
  }
  async prepareWorkspace(root) {
    if (!root || root !== this.deps.workspace.getRootPath() || this.preparedRoot === root || this.blocked()) return;
    await this.loadBoundary(root);
    let session;
    try { session = await this.session(); } catch (error) { if (/^GIT_RUNTIME_/.test(error.code || '')) { this.runtimeError = error.code; this.preparedRoot = root; return; } throw error; }
    // Read-only status remains available without Keychain. Only existing
    // journals need a recovery gate before editing this root.
    const directory = this.directory(session.root);
    try { await fs.access(path.join(directory, 'journals')); } catch (error) { if (error.code === 'ENOENT') { this.preparedRoot = root; if ((await session.service.status()).operation === 'merge') this.claim({ id: crypto.randomUUID(), ...this.identity(), phase: 'conflict', conflict: true, root, openPaths: [] }); return; } throw error; }
    const op = { id: crypto.randomUUID(), ...this.identity(), phase: 'recovery', root, openPaths: [] };
    this.claim(op);
    try {
      const journals = await (await this.transaction(session)).list();
      const journalBoundary = this.journalFingerprint(journals);
      if (journalBoundary && journalBoundary !== this.boundaryJournals.get(root)) this.boundaries.set(root, journalBoundary);
      const pending = journals.filter(item => item.recoveryRequired && item.phase !== 'conflict');
      if (pending.length) { op.phase = 'recovery-required'; op.error = 'Gitの中断した操作を確認してください。'; op.recoveryId = pending[0].id; this.emit(); }
      else if (journals.some(item => item.phase === 'conflict')) { this.preparedRoot = root; op.phase = 'conflict'; op.conflict = true; this.emit(); }
      else { this.preparedRoot = root; this.clear(); }
    } catch { op.phase = 'recovery-required'; op.error = 'Gitの保護データを確認できません。'; this.emit(); }
  }
  async begin(request) {
    this.validate(request);
    const continuingConflict = this.operation?.phase === 'conflict' && ['resolution', 'resolve-stage', 'merge-finish', 'merge-abort'].includes(request.purpose);
    if (this.blocked() && !continuingConflict) throw fail('GIT_BUSY', 'Finish the current project operation first.');
    if (this.deps.isAgentBusy?.()) throw fail('WORKSPACE_BUSY', 'Wait for Axiom to finish editing.');
    if (this.deps.hasTerminals?.()) throw fail('TERMINAL_BUSY', 'Close the terminal sessions before changing this project.');
    if (!Array.isArray(request.openPaths || []) || (request.openPaths || []).length > 500) throw fail('GIT_PATH_INVALID', 'Too many open files.');
    const op = { id: crypto.randomUUID(), ...this.identity(), root: this.deps.workspace.getRootPath(), phase: 'preparing', purpose: request.purpose, writesWorktree: false, beforeFingerprint: null, openPaths: [...new Set((request.openPaths || []).map(safePath))] };
    if (continuingConflict) { Object.assign(this.operation, op, { id: this.operation.id, conflict: true, generationAdvanced: false, boundaryId: null }); this.emit(); }
    else this.claim(op);
    const active = this.operation;
    try { await this.deps.quiesce(); this.validate(request); active.phase = 'saving'; this.emit(); return { token: active.id }; }
    catch (error) { if (continuingConflict) { active.phase = 'conflict'; this.emit(); } else this.clear(); throw error; }
  }
  lease(request, phase = 'saving') {
    const op = this.operation;
    if (!op || op.id !== request.token || op.phase !== phase || op.root !== this.deps.workspace.getRootPath()) throw fail('GIT_BUSY', 'Prepare this Git operation again.');
    return op;
  }
  async mutation(action) {
    const op = this.operation;
    return this.coordinator.run(op.id, () => this.deps.withMutation(action));
  }
  async syncFiles(op) {
    const root = await fs.realpath(op.root); const files = [];
    for (const relative of op.openPaths) {
      const full = path.join(root, relative); let content = null;
      try {
        const parent = await fs.realpath(path.dirname(full));
        if (parent !== root && !parent.startsWith(root + path.sep)) throw fail('GIT_PATH_UNSAFE', 'An open file moved outside the project.');
        const fd = await fs.open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const before = await fd.stat();
          if (before.isFile() && before.size <= 16 * 1024 * 1024) {
            const bytes = await fd.readFile(); const after = await fd.stat();
            if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw fail('STATE_CHANGED', 'A file changed during editor synchronization.');
            if (!bytes.includes(0) && Buffer.from(bytes.toString('utf8')).equals(bytes)) content = bytes.toString('utf8');
          }
        } finally { await fd.close(); }
      } catch (error) { if (!['ENOENT', 'ELOOP'].includes(error.code)) throw error; }
      files.push({ path: relative, content });
    }
    return files;
  }
  async synchronize(op, changedPaths = []) {
    if (changedPaths.length) op.writesWorktree = true;
    if (op.writesWorktree && !op.generationAdvanced) { this.deps.advanceGeneration?.(); op.generationAdvanced = true; op.boundaryId = crypto.randomUUID(); }
    if (op.writesWorktree) await this.persistBoundary(op);
    op.phase = 'syncing'; op.changedPaths = changedPaths; this.emit();
    op.syncFiles = await this.syncFiles(op);
    await this.deps.afterRestore?.(changedPaths.map(name => ({ path: name })), { writesWorktree: Boolean(op.writesWorktree) });
    return { ...this.identity(), token: op.id, files: op.syncFiles, resetModels: Boolean(op.writesWorktree) };
  }
  async resolutionFile(root, relative) {
    const full = path.join(root, safePath(relative));
    try {
      const parent = await fs.realpath(path.dirname(full));
      if (parent !== root && !parent.startsWith(root + path.sep)) throw fail('GIT_PATH_UNSAFE', 'The conflict path is outside this project.');
      const fd = await fs.open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = await fd.stat(); if (!before.isFile() || before.size > 8 * 1024 * 1024) throw fail('GIT_RESOLUTION_UNSUPPORTED', 'This conflict needs an external editor.');
        const bytes = await fd.readFile(); const after = await fd.stat();
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw fail('STATE_CHANGED', 'The conflict changed while being read.');
        return { bytes, mode: before.mode & 0o777, hash: crypto.createHash('sha256').update(bytes).digest('hex') };
      } finally { await fd.close(); }
    } catch (error) { if (error.code === 'ENOENT') return { bytes: null, mode: 0o644, hash: null }; throw error; }
  }
  async readDiff(session, request) {
    const relative = safePath(request.path);
    if (!['staged', 'unstaged'].includes(request.side)) throw fail('GIT_DIFF_SIDE', 'Choose staged or unstaged changes.');
    const state = await session.service.status(), entry = state.status?.entries.find(item => item.path === relative);
    if (!state.supported || !entry) throw fail('GIT_DIFF_UNAVAILABLE', 'Refresh the changed files before comparing.');
    if (entry.unmerged) throw fail('GIT_UNMERGED', 'Open conflict resolution for this file.');
    const read = args => session.runner.run(args, { readOnly: true });
    const limit = 8 * 1024 * 1024;
    const missing = { content: '', size: 0, hash: null, exists: false, kind: 'missing' };
    const decode = bytes => !bytes.includes(0) && Buffer.from(bytes.toString('utf8')).equals(bytes) ? bytes.toString('utf8') : null;
    const blob = async record => {
      if (!record) return { ...missing };
      const { mode, oid } = record;
      const size = Number((await read(['cat-file', '-s', oid])).stdout.toString('utf8').trim());
      const regular = /^100(?:644|755)$/.test(mode);
      if (!Number.isSafeInteger(size) || size < 0) throw fail('GIT_DIFF_UNAVAILABLE', 'Cannot inspect this Git object.');
      const content = regular && size < limit ? decode((await read(['cat-file', 'blob', oid])).stdout) : null;
      return { content, size, hash: oid, exists: true, kind: regular ? 'file' : mode === '120000' ? 'link' : 'submodule' };
    };
    const indexOutput = (await read(['--literal-pathspecs', 'ls-files', '--stage', '-z', '--', relative])).stdout.toString('utf8');
    const index = indexOutput.split('\0').filter(Boolean).map(line => /^(\d+) ([a-f0-9]+) (\d)\t([\s\S]+)$/.exec(line)).find(match => match && match[4] === relative && match[3] === '0');
    let original, modified;
    if (request.side === 'staged') {
      let head = null;
      if (state.head) {
        const originalPath = entry.originalPath || relative;
        const tree = (await read(['--literal-pathspecs', 'ls-tree', '-z', state.head, '--', originalPath])).stdout.toString('utf8');
        head = tree.split('\0').filter(Boolean).map(line => /^(\d+) (?:blob|commit) ([a-f0-9]+)\t([\s\S]+)$/.exec(line)).find(match => match && match[3] === originalPath);
      }
      original = await blob(head ? { mode: head[1], oid: head[2] } : null);
      modified = await blob(index ? { mode: index[1], oid: index[2] } : null);
    } else {
      original = await blob(index ? { mode: index[1], oid: index[2] } : null);
      const full = path.join(session.root, relative), parent = await fs.realpath(path.dirname(full)).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (parent !== null && parent !== session.root && !parent.startsWith(session.root + path.sep)) throw fail('GIT_PATH_UNSAFE', 'This file moved outside the project.');
      let stat; try { stat = await fs.lstat(full); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const algorithm = (await read(['rev-parse', '--show-object-format'])).stdout.toString('utf8').trim();
      if (!['sha1', 'sha256'].includes(algorithm)) throw fail('GIT_DIFF_UNAVAILABLE', 'Unsupported Git object format.');
      if (!stat) modified = { ...missing };
      else if (stat.isSymbolicLink()) {
        const bytes = Buffer.from(await fs.readlink(full));
        modified = { content: null, size: bytes.length, hash: crypto.createHash(algorithm).update(`blob ${bytes.length}\0`).update(bytes).digest('hex'), exists: true, kind: 'link' };
      } else if (!stat.isFile()) modified = { content: null, size: null, hash: null, exists: true, kind: 'directory' };
      else {
        const fd = await fs.open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const before = await fd.stat();
          if (before.ino !== stat.ino || before.dev !== stat.dev || before.size > 512 * 1024 * 1024) throw fail('GIT_DIFF_UNAVAILABLE', 'This file cannot be inspected safely.');
          const digest = crypto.createHash(algorithm).update(`blob ${before.size}\0`), chunks = [];
          const buffer = Buffer.alloc(1024 * 1024); let total = 0;
          while (true) { const { bytesRead } = await fd.read(buffer, 0, buffer.length, null); if (!bytesRead) break; total += bytesRead; if (total > before.size) throw fail('STATE_CHANGED', 'The file changed during comparison.'); digest.update(buffer.subarray(0, bytesRead)); if (before.size < limit) chunks.push(Buffer.from(buffer.subarray(0, bytesRead))); }
          const after = await fd.stat();
          if (total !== before.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw fail('STATE_CHANGED', 'The file changed during comparison.');
          modified = { content: before.size < limit ? decode(Buffer.concat(chunks)) : null, size: before.size, hash: digest.digest('hex'), exists: true, kind: 'file' };
        } finally { await fd.close(); }
      }
    }
    this.validate(request);
    if ((await session.service.status()).stateFingerprint !== state.stateFingerprint) throw fail('STATE_CHANGED', 'The Git comparison changed. Open it again.');
    const text = original.content !== null && modified.content !== null;
    const metadata = ({ content, ...info }) => info;
    return { path: relative, side: request.side, text, original: text ? original.content : null, modified: text ? modified.content : null, originalInfo: metadata(original), modifiedInfo: metadata(modified) };
  }
  async readConflict(session, request) {
    const relative = safePath(request.path), state = await session.service.status();
    if (state.operation !== 'merge' || !state.status.entries.some(item => item.path === relative && item.unmerged)) throw fail('GIT_CONFLICT_MISSING', 'This file is no longer unresolved.');
    const entries = (await session.runner.run(['--literal-pathspecs', 'ls-files', '--stage', '-z', '--', relative], { readOnly: true })).stdout.toString('utf8').split('\0').filter(Boolean);
    if (entries.some(line => !/^100(?:644|755) /.test(line))) throw fail('GIT_RESOLUTION_UNSUPPORTED', 'This file type requires external conflict resolution.');
    const sides = {};
    for (const [name, stage] of [['base', 1], ['ours', 2], ['theirs', 3]]) {
      const result = await session.runner.run(['show', `:${stage}:${relative}`], { readOnly: true, allowFailure: true });
      sides[name] = result.code === 0 ? result.stdout : null;
    }
    const disk = await this.resolutionFile(session.root, relative);
    if ((await session.service.status()).stateFingerprint !== state.stateFingerprint) throw fail('STATE_CHANGED', 'The conflict changed while being read.');
    const conflictId = crypto.randomUUID(); this.conflicts.clear();
    this.conflicts.set(conflictId, { ...this.identity(), path: relative, root: session.root, indexFingerprint: state.indexFingerprint, disk, sides });
    const asText = bytes => bytes && !bytes.includes(0) && Buffer.from(bytes.toString('utf8')).equals(bytes) ? bytes.toString('utf8') : null;
    return { path: relative, conflictId, original: asText(sides.ours), modified: asText(disk.bytes), base: asText(sides.base), theirs: asText(sides.theirs), binary: Object.values(sides).some(bytes => bytes && asText(bytes) === null), hasOurs: sides.ours !== null, hasTheirs: sides.theirs !== null };
  }
  async writeResolution(session, op, request) {
    const plan = this.conflicts.get(request.conflictId);
    if (!plan || plan.root !== session.root || plan.workspaceId !== request.workspaceId || plan.workspaceGeneration !== request.workspaceGeneration) throw fail('GIT_CONFLICT_EXPIRED', 'Open this conflict again before saving.');
    let bytes;
    if (request.source === 'ours' || request.source === 'theirs') bytes = plan.sides[request.source];
    else if (request.source !== undefined || typeof request.content !== 'string' || Buffer.byteLength(request.content) > 8 * 1024 * 1024) throw fail('GIT_RESOLUTION_INVALID', 'Enter the resolved file contents.');
    else bytes = Buffer.from(request.content);
    const expected = bytes === null ? null : crypto.createHash('sha256').update(bytes).digest('hex');
    this.conflicts.delete(request.conflictId); op.writesWorktree = true; op.phase = 'working'; this.emit();
    try {
      const checkState = await session.service.status(), checkDisk = await this.resolutionFile(session.root, plan.path);
      if (checkState.operation !== 'merge' || checkState.indexFingerprint !== plan.indexFingerprint || checkDisk.hash !== plan.disk.hash) throw fail('STATE_CHANGED', 'The conflict changed. Open it again before saving.');
      const transaction = await this.transaction(session), resume = (await transaction.list()).find(item => item.phase === 'conflict');
      const result = await this.mutation(() => transaction.run({ action: 'resolution', ...(resume ? { resumeId: resume.id } : {}), verify: async ({ before, after }) => {
        if (before.head !== after.head || before.branchRef !== after.branchRef || (await this.resolutionFile(session.root, plan.path)).hash !== expected) throw fail('GIT_RESULT_UNCERTAIN', 'The conflict resolution could not be verified.');
        return 'completed';
      } }, async () => {
        const state = await session.service.status(), disk = await this.resolutionFile(session.root, plan.path);
        if (state.operation !== 'merge' || state.indexFingerprint !== plan.indexFingerprint || disk.hash !== plan.disk.hash) throw fail('STATE_CHANGED', 'The conflict changed. Open it again before saving.');
        const full = path.join(session.root, plan.path), temporary = path.join(path.dirname(full), `.tex64-resolution-${crypto.randomUUID()}`);
        if (bytes === null) { if (disk.bytes !== null) await fs.unlink(full); }
        else {
          try { const fd = await fs.open(temporary, 'wx', disk.mode); try { await fd.writeFile(bytes); await fd.sync(); } finally { await fd.close(); }
            if ((await this.resolutionFile(session.root, plan.path)).hash !== disk.hash) throw fail('STATE_CHANGED', 'The conflict changed while saving.');
            await fs.rename(temporary, full);
          } finally { await fs.unlink(temporary).catch(() => {}); }
        }
        const parent = await fs.open(path.dirname(full), 'r'); try { await parent.sync(); } finally { await parent.close(); }
        return {};
      }));
      op.conflict = true;
      return { ...(await this.synchronize(op, [plan.path])), result: { transaction: publicTransaction(result.transaction) } };
    } catch (error) {
      op.recoveryRequired = error.code === 'GIT_RECOVERY_REQUIRED'; op.recoveryId = error.transactionId || null;
      try { await this.synchronize(op, [plan.path]); } catch { op.phase = 'syncing'; this.emit(); }
      throw fail(error.code || 'GIT_RESOLUTION_FAILED', '競合の保存結果を確認してください。');
    }
  }
  async request(action, request = {}) {
    this.validate(request);
    if (action === 'begin') return this.begin(request);
    if (action === 'status') { try { const session = await this.session(); return { ...this.status(), state: publicState(await session.service.status()), transactions: session.transaction ? (await session.transaction.list()).map(publicTransaction) : [] }; } catch (error) { if (/^GIT_RUNTIME_/.test(error.code || '')) return { ...this.status(), state: null, runtimeAvailable: false, runtimeError: error.code }; throw error; } }
    if (action === 'release') { const op = this.lease(request); if (op.conflict) { op.phase = 'conflict'; this.emit(); } else this.clear(); return {}; }
    if (action === 'sync') {
      const op = this.operation; if (!op || op.phase !== 'syncing') throw fail('GIT_BUSY', 'No changed editor state is waiting.');
      return this.synchronize(op, op.changedPaths || []);
    }
    if (action === 'ack') {
      const op = this.lease(request, 'syncing');
      if (!Array.isArray(request.buffers) || !Array.isArray(op.syncFiles)) throw fail('SYNC_REQUIRED', 'Confirm the current editor state before continuing.');
      const current = await this.syncFiles(op);
      if (JSON.stringify(current) !== JSON.stringify(op.syncFiles)) { op.syncFiles = current; throw fail('SYNC_REQUIRED', 'Files changed again. Synchronize the editor again.'); }
      for (const file of op.syncFiles) {
        const buffers = request.buffers.filter(item => item.path === file.path);
        if (buffers.length > 1 || buffers.some(buffer => file.content === null || buffer.content !== file.content || buffer.savedContent !== file.content)) throw fail('SYNC_REQUIRED', 'An editor still contains the previous state.');
      }
      if (op.recoveryRequired) { op.phase = 'recovery-required'; this.emit(); return { recoveryRequired: true }; }
      if (op.conflict) { op.phase = 'conflict'; this.emit(); return { conflict: true }; }
      this.clear(); return {};
    }
    if (this.coordinator.current && this.coordinator.current.owner !== 'git') throw fail('GIT_BUSY', 'Finish the current project operation first.');
    const session = await this.session();
    if (action === 'plan-authentication') return session.network.planAuthentication();
    if (action === 'approve-authentication') return session.network.approveAuthentication({ planId: request.planId });
    if (action === 'ahead-behind') return session.network.aheadBehind(request.args || {});
    if (action === 'verify-push') return session.network.verifyPush(request.args || {});
    if (action === 'recovery-files') return { files: await (await this.transaction(session)).recoveryFiles(request.id || this.operation?.recoveryId) };
    if (action === 'export-recovery-file') {
      safePath(request.path); if (!['before', 'after', 'current'].includes(request.side)) throw fail('GIT_RECOVERY_SIDE', 'Choose a saved file version.');
      if (typeof this.deps.chooseRecoveryDestination !== 'function') throw fail('GIT_EXPORT_UNAVAILABLE', 'Choose a save destination in the application.');
      const destination = await this.deps.chooseRecoveryDestination({ path: request.path, side: request.side });
      this.validate(request); if (!destination) return { canceled: true, cancelled: true };
      return (await this.transaction(session)).exportRecoveryFile(request.id || this.operation?.recoveryId, { path: request.path, side: request.side, destination });
    }
    if (action === 'shelves') { const tx = await this.transaction(session); return { shelves: (await tx.list()).filter(item => item.kind === 'shelve' && item.phase === 'shelved').map(item => ({ id: item.id, branch: item.base?.branch || null, head: item.base?.commit || null, createdAt: item.createdAt, paths: item.paths || [] })) }; }
    if (action === 'diff') return this.readDiff(session, request);
    if (action === 'read-conflict') return this.readConflict(session, request);
    if (action === 'authenticate') { if (this.blocked()) throw fail('GIT_BUSY', 'Finish the current project operation first.'); return session.network.authenticate(); }
    if (action === 'recover') {
      const op = this.lease(request, 'recovery-required');
      if (request.openPaths) op.openPaths = [...new Set(request.openPaths.map(safePath))];
      const tx = await this.transaction(session);
      const id = request.id || op.recoveryId;
      const result = await this.mutation(() => tx.recover(id));
      return { transaction: publicTransaction(result.transaction), match: result.match };
    }
    if (['plan-recovery', 'apply-recovery', 'recovery-plan', 'recovery-apply'].includes(action)) {
      const op = this.lease(request, 'recovery-required'), tx = await this.transaction(session);
      if (request.openPaths) { if (!Array.isArray(request.openPaths) || request.openPaths.length > 500) throw fail('GIT_PATH_INVALID', 'Too many open files.'); op.openPaths = [...new Set(request.openPaths.map(safePath))]; }
      if (action === 'plan-recovery' || action === 'recovery-plan') return tx.planRecovery(request.id || op.recoveryId, { paths: request.paths });
      op.phase = 'working'; op.writesWorktree = true; op.generationAdvanced = false; this.emit();
      try { const result = await this.mutation(() => tx.applyRecovery(request.planId)); op.recoveryRequired = false; op.conflict = (await session.service.status()).operation === 'merge'; return { ...(await this.synchronize(op, result.changedPaths || [])), transaction: publicTransaction(result.transaction) }; }
      catch (error) { op.recoveryRequired = true; try { await this.synchronize(op); } catch { op.phase = 'syncing'; this.emit(); } throw fail(error.code || 'GIT_RECOVERY_REQUIRED', 'Gitの復旧結果を確認してください。'); }
    }
    const op = this.lease(request);
    if (op.conflict && !(action === 'write-resolution' || action === 'execute' || action === 'plan' && ['resolve-stage', 'merge-finish', 'merge-abort'].includes(request.action))) throw fail('GIT_CONFLICT_ACTIVE', 'Finish resolving the merge first.');
    if (action === 'shelve-plan') { op.phase = 'planning'; this.emit(); try { return { plan: await (await this.transaction(session)).planShelve({ paths: request.paths, ignoredPaths: request.ignoredPaths }) }; } finally { op.phase = 'saving'; this.emit(); } }
    if (action === 'shelve' || action === 'unshelve') {
      const tx = await this.transaction(session); op.writesWorktree = true; op.phase = 'working'; this.emit();
      try { const result = await this.mutation(() => action === 'shelve' ? tx.shelve({ planId: request.planId }) : tx.unshelve(request.id)); return { ...(await this.synchronize(op, result.changedPaths || [])), transaction: publicTransaction(result.transaction), shelveId: result.result?.shelveId || null }; }
      catch (error) { op.recoveryRequired = error.code === 'GIT_RECOVERY_REQUIRED'; op.recoveryId = error.transactionId || null; try { await this.synchronize(op); } catch { op.phase = 'syncing'; this.emit(); } throw fail(error.code || 'GIT_PROTECTION_FAILED', '退避操作の結果を確認してください。'); }
    }
    if (action === 'set-author') {
      const { name, email } = request.args || {};
      if (typeof name !== 'string' || typeof email !== 'string' || !name.trim() || !email.trim() || name.length > 200 || email.length > 320 || /[\x00-\x1f\x7f]/.test(name + email) || !/^[^\s@]+@[^\s@]+$/.test(email)) throw fail('GIT_AUTHOR_INVALID', 'Enter a commit name and email address.');
      op.phase = 'working'; this.emit();
      try {
        await this.mutation(async () => {
          const state = await session.service.status(); if (!state.repository || state.layout !== 'standard' || state.operation !== 'idle') throw fail('GIT_AUTHOR_UNAVAILABLE', 'Finish the current repository operation first.');
          const file = path.join(state.gitDir, 'config'), temporary = path.join(state.gitDir, `.tex64-author-${crypto.randomUUID()}`);
          const fd = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW); let bytes, mode;
          try { const stat = await fd.stat(); if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw fail('GIT_CONFIG_UNSUPPORTED', 'Repository configuration is too large.'); bytes = await fd.readFile(); mode = stat.mode & 0o777; } finally { await fd.close(); }
          try {
            await fs.writeFile(temporary, bytes, { flag: 'wx', mode });
            await session.runner.run(['config', '--file', temporary, 'user.name', name.trim()]); await session.runner.run(['config', '--file', temporary, 'user.email', email.trim()]);
            if (!Buffer.from(await fs.readFile(file)).equals(bytes)) throw fail('STATE_CHANGED', 'Repository configuration changed. Try again.');
            const write = await fs.open(temporary, 'r'); try { await write.sync(); } finally { await write.close(); }
            await fs.rename(temporary, file);
            const directory = await fs.open(state.gitDir, 'r'); try { await directory.sync(); } finally { await directory.close(); }
          } finally { await fs.unlink(temporary).catch(() => {}); }
        });
        return { configured: true };
      } finally { op.phase = 'saving'; this.emit(); }
    }
    if (action === 'write-resolution') return this.writeResolution(session, op, request);
    if (action === 'plan') {
      op.phase = 'planning'; this.emit();
      try {
        if (request.action === 'set-upstream') {
          const { localRef, remoteRef } = request.args || {}; await session.service.validRef(localRef, 'refs/heads/'); await session.service.validRef(remoteRef, 'refs/remotes/');
          const state = await session.service.status();
          if (!state.supported || state.operation !== 'idle' || !state.refs.some(item => item.name === localRef) || !state.refs.some(item => item.name === remoteRef)) throw fail('GIT_UPSTREAM_UNAVAILABLE', 'Fetch this remote branch before selecting it.');
          const planId = crypto.randomUUID(); this.plans.clear(); this.plans.set(planId, { token: op.id, ...this.identity(), kind: 'set-upstream', localRef, remoteRef, fingerprint: state.stateFingerprint });
          return { plan: { planId, review: { title: '追跡先を設定', details: [localRef.slice(11) + ' → ' + remoteRef.slice(13)], actionLabel: '設定する', changedPaths: [] } } };
        }
        const plan = await session.service.plan(request.action, request.args || {}); this.validate(request);
        this.plans.clear(); this.plans.set(plan.planId, { token: op.id, ...this.identity(), writesWorktree: ['branch-create', 'branch-switch', 'merge', 'merge-abort'].includes(request.action) });
        return { plan };
      } finally { op.phase = 'saving'; this.emit(); }
    }
    if (action === 'execute') {
      const plan = this.plans.get(request.planId);
      if (!plan || plan.token !== op.id || plan.workspaceGeneration !== request.workspaceGeneration) throw fail('GIT_PLAN_EXPIRED', 'Review the Git operation again.');
      this.plans.delete(request.planId); op.writesWorktree = Boolean(plan.writesWorktree); op.phase = 'working'; this.emit();
      try {
        const result = await this.mutation(async () => {
          if (plan.kind !== 'set-upstream') return session.service.execute(request.planId);
          if ((await session.service.status()).stateFingerprint !== plan.fingerprint) throw fail('STATE_CHANGED', 'The repository changed. Review the tracking branch again.');
          await session.runner.run(['branch', `--set-upstream-to=${plan.remoteRef}`, plan.localRef.slice('refs/heads/'.length)]);
          const state = await session.service.status(); if (state.refs.find(item => item.name === plan.localRef)?.upstream !== plan.remoteRef) throw fail('GIT_RESULT_UNCERTAIN', 'The tracking branch could not be verified.');
          return { result: { action: 'set-upstream', state }, changedPaths: [] };
        });
        op.conflict = result.result?.state?.operation === 'merge';
        const sync = await this.synchronize(op, result.changedPaths || []);
        return { ...sync, result: { action: result.result?.action, state: publicState(result.result?.state), conflict: result.result?.conflict, mergePending: result.result?.mergePending, transaction: publicTransaction(result.transaction) } };
      } catch (error) {
        if (op.beforeFingerprint && session.vault) { try { if (await session.vault.fingerprint({ root: session.root }) !== op.beforeFingerprint) op.writesWorktree = true; } catch { op.writesWorktree = true; } }
        op.error = error.code || 'GIT_OPERATION_FAILED';
        op.recoveryRequired = error.code === 'GIT_RECOVERY_REQUIRED'; op.recoveryId = error.transactionId || null;
        try { await this.synchronize(op); } catch { op.phase = 'syncing'; this.emit(); }
        throw Object.assign(fail(error.code || 'GIT_OPERATION_FAILED', 'Gitの操作結果を確認してください。編集状態を同期するまで保護を続けます。'), { causeCode: /^[A-Z0-9_]{1,64}$/.test(error.causeCode || '') ? error.causeCode : null });
      }
    }
    const networkMethods = { connect: 'connect', fetch: 'fetch', push: 'push', 'push-tag': 'pushTag', clone: 'clone' };
    if (networkMethods[action]) {
      op.phase = 'network'; this.emit();
      try { this.validate(request); return await this.mutation(() => session.network[networkMethods[action]](request.args || {})); }
      finally { op.phase = 'saving'; this.emit(); }
    }
    throw fail('GIT_ACTION_INVALID', 'Unknown Git operation.');
  }
}
module.exports = { GitController, publicState };
