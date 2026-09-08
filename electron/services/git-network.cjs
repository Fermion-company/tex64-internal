'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { validateGitHubUrl, activeFilters } = require('./git-state.cjs');
const { GitRunner } = require('./git-runner.cjs');
const fail = (code, message) => Object.assign(new Error(message), { code });
const text = result => result.stdout.toString('utf8').trim();
const oidPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const remotePattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const identity = stat => `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
const quote = input => `'${input.replace(/'/g, `'\\''`)}'`;
const parseConfig = bytes => bytes.toString('utf8').split('\0').filter(Boolean).map(record => { const split = record.indexOf('\n'); return { key: record.slice(0, split), value: record.slice(split + 1) }; });

// Main-only API. withMutation must serialize all Git operations for this root;
// the caller supplies workspace quiescence / saved-buffer / plan generation
// validation when an operation changes the working tree. No renderer args API.
class GitNetwork {
  constructor({ runner, runtime, withMutation = action => action(), allowTestLocalRemote = false, spawnImpl = spawn }) {
    if (!runner || !runtime || !path.isAbsolute(runtime.credentialManager || '')) throw fail('GIT_RUNTIME_MISSING', 'Bundled Git is required.');
    this.runner = runner; this.runtime = runtime; this.withMutation = withMutation;
    this.allowTestLocalRemote = allowTestLocalRemote === true; this.spawnImpl = spawnImpl; this.checked = new Map(); this.authenticationPlans = new Map(); this.authenticationApproval = null;
  }
  async url(input) {
    if (this.allowTestLocalRemote && typeof input === 'string' && path.isAbsolute(input)) {
      const resolved = await fs.realpath(input);
      if (!(await fs.stat(resolved)).isDirectory()) throw fail('GIT_URL_INVALID', 'The test remote is not a directory.');
      return { url: resolved, transport: 'file' };
    }
    return validateGitHubUrl(input);
  }
  async config(runner = this.runner) { return parseConfig((await runner.run(['config', '--null', '--list', '--includes'], { readOnly: true })).stdout); }
  async assertNetworkTrust(runner = this.runner, { localOnly = false, allowHelperOverride = false, checkout = false } = {}) {
    const config = await this.config(runner);
    for (const item of config) {
      if (/^url\..*\.(?:insteadof|pushinsteadof)$/i.test(item.key)) throw fail('GIT_URL_REWRITE_UNTRUSTED', 'URL rewriting is configured. Review it before connecting.');
      if (!localOnly && checkout && /^filter\..*\.(?:clean|smudge|process)$/i.test(item.key) && item.value) throw fail('GIT_NETWORK_CONFIG_UNTRUSTED', 'Cloning with external Git filters requires review.');
      if (/^remote\..*\.(?:uploadpack|receivepack|vcs|proxy)$/i.test(item.key) || /^core\.(?:sshcommand|hookspath|fsmonitor)$/i.test(item.key) && item.value && !/^(false|0|no|off)$/i.test(item.value) || /^(?:http(?:\..*)?\.(?:extraheader|proxy)|core\.gitproxy)$/i.test(item.key)) throw fail('GIT_NETWORK_CONFIG_UNTRUSTED', 'This repository uses executable or credential-bearing network settings. Review them first.');
      if (/^http(?:\..*)?\.sslverify$/i.test(item.key) && /^(false|0|no|off)$/i.test(item.value)) throw fail('GIT_TLS_UNTRUSTED', 'TLS verification is disabled in Git settings.');
      if (!localOnly && /^credential(?:\..*)?\.(?:provider|oauthclientid|oauthclientsecret|oauthauthurl|oauthtokenurl|credentialstore|plaintextstorepath)$/i.test(item.key)) throw fail('GIT_CREDENTIAL_CONFIG_UNTRUSTED', 'Custom authentication settings require review.');
      if (!localOnly && !allowHelperOverride && /^credential(?:\..*)?\.helper$/i.test(item.key) && item.value && ![this.runtime.credentialManager, quote(this.runtime.credentialManager)].includes(item.value) && this.authenticationApproval !== this.authenticationFingerprint(config)) throw fail('GIT_CREDENTIAL_HELPER_UNTRUSTED', 'An unrecognized credential helper is configured.');
    }
    // A pre-push hook can execute arbitrary project code. Never silently skip it.
    const gitDir = await runner.run(['rev-parse', '--absolute-git-dir'], { allowFailure: true, readOnly: true });
    if (!gitDir.code) {
      try { const hook = await fs.stat(path.join(text(gitDir), 'hooks', 'pre-push')); if (hook.isFile() && (hook.mode & 0o111)) throw fail('GIT_HOOK_UNTRUSTED', 'A pre-push hook needs approval before network operations.'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return config;
  }
  authenticationFingerprint(config) {
    return crypto.createHash('sha256').update(JSON.stringify([this.runner.root, this.runtime.credentialManager, config])).digest('hex');
  }
  async planAuthentication() {
    const config = await this.assertNetworkTrust(this.runner, { allowHelperOverride: true });
    const planId = crypto.randomUUID(); this.authenticationPlans.clear();
    this.authenticationPlans.set(planId, this.authenticationFingerprint(config));
    return { planId, review: { title: 'TeX64の認証を使う', details: ['このプロジェクトでは同梱のGitHub認証を使います。', '既存のGit設定は変更しません。設定が変わった場合は再確認します。'], actionLabel: 'TeX64の認証を使う' } };
  }
  async approveAuthentication({ planId } = {}) {
    const fingerprint = this.authenticationPlans.get(planId); this.authenticationPlans.delete(planId);
    if (!fingerprint) throw fail('GIT_PLAN_EXPIRED', 'Review the authentication choice again.');
    const config = await this.assertNetworkTrust(this.runner, { allowHelperOverride: true });
    if (this.authenticationFingerprint(config) !== fingerprint) throw fail('STATE_CHANGED', 'Git settings changed after the authentication review.');
    this.authenticationApproval = fingerprint;
    return { approved: true };
  }
  flags(transport) {
    if (transport === 'ssh') throw fail('GIT_SSH_TRUST_REQUIRED', 'SSH configuration needs approval. Use an HTTPS URL for this connection.');
    return ['-c', 'protocol.allow=never', '-c', `protocol.${transport === 'file' ? 'file' : 'https'}.allow=always`,
      '-c', 'credential.helper=', '-c', `credential.helper=${quote(this.runtime.credentialManager)}`,
      '-c', 'credential.interactive=false', '-c', 'credential.credentialStore=keychain',
      '-c', 'fetch.recurseSubmodules=false', '-c', 'submodule.recurse=false'];
  }
  async endpoint(remote, { push = false, runner = this.runner } = {}) {
    if (!remotePattern.test(remote || '')) throw fail('GIT_REMOTE_INVALID', 'Choose a repository connection.');
    const config = await this.assertNetworkTrust(runner);
    const urls = config.filter(item => item.key.toLowerCase() === `remote.${remote}.url`.toLowerCase());
    const pushUrls = config.filter(item => item.key.toLowerCase() === `remote.${remote}.pushurl`.toLowerCase());
    if (urls.length !== 1 || pushUrls.length > 1) throw fail('GIT_REMOTE_AMBIGUOUS', 'This connection must have exactly one repository URL.');
    const source = await this.url(urls[0].value);
    if (pushUrls.length) { const destination = await this.url(pushUrls[0].value); if (destination.url !== source.url) throw fail('GIT_PUSH_URL_DIFFERENT', 'The push destination differs from the repository URL. Review connection settings.'); }
    return { ...source, remote, flags: this.flags(source.transport) };
  }
  async connect({ url, name, initialize = false, signal } = {}) {
    const validated = await this.url(url);
    if (name !== undefined && !remotePattern.test(name)) throw fail('GIT_REMOTE_INVALID', 'Enter a short connection name.');
    return this.withMutation(async () => {
      const config = await this.assertNetworkTrust(this.runner, { localOnly: true });
      for (const item of config) {
        const match = /^remote\.(.+)\.url$/i.exec(item.key); if (!match) continue;
        let existing; try { existing = await this.url(item.value); } catch { continue; }
        if (existing.transport === 'file' ? existing.url === validated.url : existing.url.toLowerCase() === validated.url.toLowerCase()) return { remote: match[1], url: validated.url, created: false, initialized: false };
      }
      const names = new Set(config.map(item => /^remote\.(.+)\./i.exec(item.key)?.[1]).filter(Boolean));
      let remote = name || 'origin'; if (name && names.has(name)) throw fail('GIT_REMOTE_EXISTS', 'That connection name is already in use.');
      if (!name && names.has(remote)) { remote = 'github'; let n = 2; while (names.has(remote)) remote = `github-${n++}`; }
      const found = await this.runner.run(['rev-parse', '--show-toplevel'], { readOnly: true, allowFailure: true, signal });
      let initialized = false;
      if (found.code) { if (!/not a git repository/i.test(found.stderr)) throw fail('GIT_REPOSITORY_UNAVAILABLE', 'Cannot inspect this project repository.'); if (!initialize) throw fail('GIT_INITIALIZE_REQUIRED', 'Start Git for this project first.'); await this.runner.run(['init', `--template=${path.join(this.runtime.root, 'share', 'git-core', 'templates')}`, '-b', 'main'], { signal }); initialized = true; }
      else if (await fs.realpath(text(found)) !== this.runner.root) throw fail('GIT_ROOT_UNSUPPORTED', 'Open the Git repository root before connecting.');
      await this.runner.run(['remote', 'add', remote, validated.url], { signal });
      return { remote, url: validated.url, created: true, initialized };
    });
  }
  async fetch({ remote, signal } = {}) {
    return this.withMutation(async () => {
      const endpoint = await this.endpoint(remote);
      await this.runner.run([...endpoint.flags, 'fetch', '--no-tags', '--no-recurse-submodules', '--', endpoint.url, `refs/heads/*:refs/remotes/${remote}/*`], { signal, timeoutMs: 120000 });
      const refs = text(await this.runner.run(['for-each-ref', '--format=%(refname)%00%(objectname)', `refs/remotes/${remote}/`], { readOnly: true })).split('\n').filter(Boolean).map(row => { const [ref, oid] = row.split('\0'); return { ref, oid }; });
      const checkedAt = new Date().toISOString(); this.checked.set(remote, checkedAt); return { remote, checkedAt, refs };
    });
  }
  async validateRef(ref, prefix) {
    if (typeof ref !== 'string' || !ref.startsWith(prefix) || ref.includes('\0')) throw fail('GIT_REF_INVALID', 'Choose a full Git reference.');
    const result = await this.runner.run(['check-ref-format', ref], { readOnly: true, allowFailure: true }); if (result.code) throw fail('GIT_REF_INVALID', 'The reference name is invalid.');
  }
  async aheadBehind({ localRef, remoteRef } = {}) {
    await this.validateRef(localRef, 'refs/heads/'); await this.validateRef(remoteRef, 'refs/remotes/');
    const result = await this.runner.run(['rev-list', '--left-right', '--count', `${localRef}...${remoteRef}`, '--'], { readOnly: true });
    const match = /^(\d+)\s+(\d+)$/.exec(text(result)); if (!match) throw fail('GIT_COUNTS_INVALID', 'Cannot read the commit counts.');
    const base = await this.runner.run(['merge-base', localRef, remoteRef], { readOnly: true, allowFailure: true });
    if (![0, 1].includes(base.code)) throw fail('GIT_HISTORY_UNAVAILABLE', 'Cannot compare these histories.');
    return { ahead: Number(match[1]), behind: Number(match[2]), ...(base.code === 1 ? { related: false } : {}) };
  }
  async remoteOid(endpoint, ref) {
    const result = await this.runner.run([...endpoint.flags, 'ls-remote', '--refs', '--', endpoint.url, ref], { timeoutMs: 20000, readOnly: true });
    const rows = text(result).split('\n').filter(Boolean).map(row => row.split('\t')).filter(row => row[1] === ref);
    if (rows.length > 1 || rows.some(row => !oidPattern.test(row[0]))) throw fail('GIT_REMOTE_RESPONSE_INVALID', 'Cannot verify the remote reference.');
    return rows[0]?.[0] || null;
  }
  async verifyPush({ remote, ref, oid } = {}) {
    await this.validateRef(ref, ref?.startsWith('refs/tags/') ? 'refs/tags/' : 'refs/heads/');
    if (!oidPattern.test(oid || '')) throw fail('GIT_OID_INVALID', 'Choose the exact commit or tag to send.');
    try { const endpoint = await this.endpoint(remote, { push: true }); const remoteOid = await this.remoteOid(endpoint, ref); return { status: remoteOid === oid ? 'confirmed' : 'unknown', remoteOid }; }
    catch (error) { return { status: 'unknown', remoteOid: null, reason: error.code || 'GIT_VERIFY_FAILED' }; }
  }
  async push(options = {}) { return this.sendRef(options, 'refs/heads/'); }
  async pushTag(options = {}) { return this.sendRef(options, 'refs/tags/'); }
  async sendRef({ remote, ref, oid, expectedRemoteOid, signal }, prefix) {
    await this.validateRef(ref, prefix);
    if (!oidPattern.test(oid || '') || expectedRemoteOid !== undefined && expectedRemoteOid !== null && !oidPattern.test(expectedRemoteOid)) throw fail('GIT_OID_INVALID', 'Choose the exact commit or tag to send.');
    return this.withMutation(async () => {
      const endpoint = await this.endpoint(remote, { push: true });
      const current = text(await this.runner.run(['rev-parse', '--verify', ref], { readOnly: true }));
      if (current !== oid) throw fail('STATE_CHANGED', 'The selected commit or tag changed.');
      const before = await this.remoteOid(endpoint, ref);
      if (expectedRemoteOid !== undefined && before !== expectedRemoteOid) throw fail('STATE_CHANGED', 'The remote changed. Check updates before sending.');
      if (before === oid) return { status: 'confirmed', remoteOid: oid, alreadyPresent: true };
      if (prefix === 'refs/tags/' && before) return { status: 'rejected', remoteOid: before, reason: 'GIT_TAG_EXISTS' };
      if (signal?.aborted) throw fail('GIT_CANCELLED', 'Sending was cancelled before starting.');
      let attempt;
      try { attempt = await this.runner.run([...endpoint.flags, '-c', 'push.followTags=false', '-c', 'push.recurseSubmodules=no', 'push', '--porcelain', '--no-follow-tags', '--', endpoint.url, `${oid}:${ref}`], { signal, timeoutMs: 120000, allowFailure: true }); }
      catch (error) { const verified = await this.verifyPush({ remote, ref, oid }); return { ...verified, reason: verified.status === 'confirmed' ? undefined : error.code || 'GIT_SEND_INTERRUPTED' }; }
      const verified = await this.verifyPush({ remote, ref, oid });
      if (verified.status === 'confirmed') return verified;
      // A protocol rejection is conclusive; transport failure / missing response
      // is not. Never translate killed/timed-out push into “not sent”.
      if (attempt.code !== 0 && /^!\t/m.test(attempt.stdout.toString('utf8'))) return { status: 'rejected', remoteOid: verified.remoteOid, reason: 'GIT_PUSH_REJECTED' };
      return { ...verified, reason: attempt.code ? 'GIT_SEND_RESULT_UNKNOWN' : 'GIT_VERIFY_FAILED' };
    });
  }
  async clone({ url, destination, signal } = {}) {
    const endpoint = await this.url(url), flags = this.flags(endpoint.transport);
    if (!path.isAbsolute(destination || '') || !path.basename(destination) || path.basename(destination).startsWith('.tex64-clone-')) throw fail('GIT_CLONE_DESTINATION', 'Choose a new project folder.');
    return this.withMutation(async () => {
      await this.assertNetworkTrust();
      const parent = await fs.realpath(path.dirname(destination)), parentId = identity(await fs.stat(parent));
      const final = path.join(parent, path.basename(destination));
      try { await fs.lstat(final); throw fail('GIT_CLONE_EXISTS', 'Choose a folder that does not already exist.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const staging = await fs.mkdtemp(path.join(parent, '.tex64-clone-'));
      let reserved = null;
      try {
        await this.runner.run([...flags, 'clone', `--template=${path.join(this.runtime.root, 'share', 'git-core', 'templates')}`, '--no-recurse-submodules', '--no-local', '--no-checkout', '--', endpoint.url, staging], { signal, timeoutMs: 180000 });
        if (signal?.aborted) throw fail('GIT_CANCELLED', 'Clone was cancelled.');
        // Inspect the fetched tree before checkout can execute any filter.
        const checkoutRunner = new GitRunner({ binaryPath: this.runner.binaryPath, root: staging, env: this.runner.env });
        const head = await checkoutRunner.run(['rev-parse', '--verify', 'HEAD'], { readOnly: true, allowFailure: true });
        if (!head.code) {
          if ((await activeFilters(checkoutRunner, { source: text(head) })).length) throw fail('GIT_FILTER_UNTRUSTED', 'This project contains files that require an external Git filter.');
          await checkoutRunner.run(['checkout', '--no-overwrite-ignore', text(head), '--', '.'], { signal });
        }

        if (identity(await fs.stat(parent)) !== parentId) throw fail('STATE_CHANGED', 'The destination folder changed.');
        // Exclusive reservation prevents replacement of an existing empty folder.
        await fs.mkdir(final); reserved = identity(await fs.lstat(final));
        if (identity(await fs.lstat(final)) !== reserved || (await fs.readdir(final)).length) throw fail('STATE_CHANGED', 'The destination changed before opening.');
        await fs.rename(staging, final); reserved = null;
        return { root: final };
      } finally {
        await fs.rm(staging, { recursive: true, force: true });
        if (reserved) { try { if (identity(await fs.lstat(final)) === reserved && !(await fs.readdir(final)).length) await fs.rmdir(final); } catch {} }
      }
    });
  }
  async authenticate({ signal } = {}) {
    if (signal?.aborted) throw fail('GIT_CANCELLED', 'Authentication was cancelled.');
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'tex64-github-auth-'));
    const env = { ...this.runtime.env, GCM_INTERACTIVE: '1', GCM_CREDENTIAL_STORE: 'keychain', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
    try {
      return await new Promise((resolve, reject) => {
        let timer, child, killTimer; let stopped = false;
        const stop = () => { stopped = true; child.kill('SIGTERM'); killTimer = setTimeout(() => child.kill('SIGKILL'), 1000); killTimer.unref?.(); };
        try { child = this.spawnImpl(this.runtime.credentialManager, ['github', 'login', '--url', 'https://github.com', '--browser'], { cwd, env, shell: false, stdio: 'ignore', windowsHide: true }); }
        catch { reject(fail('GIT_AUTH_START_FAILED', 'Could not open GitHub authentication.')); return; }
        child.once('error', () => reject(fail('GIT_AUTH_START_FAILED', 'Could not open GitHub authentication.')));
        child.once('close', code => { clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', stop); if (stopped) reject(fail('GIT_AUTH_CANCELLED', 'Authentication was interrupted.')); else if (code === 0) resolve({ authenticated: true }); else reject(fail('GIT_AUTH_FAILED', 'GitHub authentication did not complete.')); });
        signal?.addEventListener('abort', stop, { once: true }); if (signal?.aborted) stop();
        timer = setTimeout(stop, 180000); timer.unref?.();
      });
    } finally { await fs.rm(cwd, { recursive: true, force: true }); }
  }
}
module.exports = { GitNetwork };
