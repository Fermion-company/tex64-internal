'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { getGitRuntime } = require('../electron/services/git-runtime.cjs');
const { GitRunner } = require('../electron/services/git-runner.cjs');
const { GitNetwork } = require('../electron/services/git-network.cjs');
const out = result => result.stdout.toString('utf8').trim();
async function fixture(t) {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tex64-network-test-'))); t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const home = path.join(temp, 'home'), root = path.join(temp, 'project'), remote = path.join(temp, 'remote.git'); await fs.mkdir(home); await fs.mkdir(root);
  const runtime = getGitRuntime({ baseEnv: { HOME: home, XDG_CONFIG_HOME: home, PATH: '/usr/bin:/bin' } });
  const runner = new GitRunner({ binaryPath: runtime.binary, root, env: runtime.env });
  const network = new GitNetwork({ runner, runtime, allowTestLocalRemote: true });
  await runner.run(['init', '--bare', remote]);
  const run = async args => out(await runner.run(args));
  const initialize = async () => { await network.connect({ url: remote, initialize: true }); await run(['config', 'user.name', 'Fixture']); await run(['config', 'user.email', 'fixture@example.invalid']); };
  const commit = async (content, message = 'Fixture') => { await fs.writeFile(path.join(root, 'main.tex'), content); await run(['add', '--', 'main.tex']); await run(['commit', '-m', message]); return run(['rev-parse', 'HEAD']); };
  return { temp, root, remote, runtime, runner, network, run, initialize, commit };
}
test('connect preserves files and existing origin, deduplicates, and never pushes', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.root, 'main.tex'), 'Unchanged');
  const first = await f.network.connect({ url: f.remote, initialize: true }); assert.equal(first.remote, 'origin'); assert.equal(first.initialized, true);
  assert.equal((await f.network.connect({ url: f.remote })).created, false);
  const second = path.join(f.temp, 'second.git'); await f.run(['init', '--bare', second]);
  assert.equal((await f.network.connect({ url: second })).remote, 'github');
  assert.equal(await f.run(['remote', 'get-url', 'origin']), f.remote);
  assert.equal(await fs.readFile(path.join(f.root, 'main.tex'), 'utf8'), 'Unchanged');
  assert.equal(await f.run(['--git-dir', f.remote, 'for-each-ref']), '');
});
test('explicit push/fetch/count/tag preserves other refs and rejects stale or conflicting tags', async t => {
  const f = await fixture(t); await f.initialize(); const a = await f.commit('A');
  assert.equal((await f.network.push({ remote: 'origin', ref: 'refs/heads/main', oid: a, expectedRemoteOid: null })).status, 'confirmed');
  await f.network.fetch({ remote: 'origin' }); assert.deepEqual(await f.network.aheadBehind({ localRef: 'refs/heads/main', remoteRef: 'refs/remotes/origin/main' }), { ahead: 0, behind: 0 });
  await f.run(['tag', 'v1']); await f.run(['tag', 'unsent']);
  assert.equal((await f.network.pushTag({ remote: 'origin', ref: 'refs/tags/v1', oid: a, expectedRemoteOid: null })).status, 'confirmed');
  assert.equal(await f.run(['--git-dir', f.remote, 'for-each-ref', '--format=%(refname)', 'refs/tags']), 'refs/tags/v1');
  const b = await f.commit('B'); await assert.rejects(f.network.push({ remote: 'origin', ref: 'refs/heads/main', oid: a }), { code: 'STATE_CHANGED' });
  await assert.rejects(f.network.push({ remote: 'origin', ref: 'refs/heads/main', oid: b, expectedRemoteOid: null }), { code: 'STATE_CHANGED' });
  await f.run(['tag', '-f', 'v1']); assert.equal((await f.network.pushTag({ remote: 'origin', ref: 'refs/tags/v1', oid: b })).reason, 'GIT_TAG_EXISTS');
  assert.equal(await f.run(['--git-dir', f.remote, 'rev-parse', 'refs/tags/v1']), a);
});
test('non-fast-forward refusal never forces and interrupted accepted push is verified', async t => {
  const f = await fixture(t); await f.initialize(); const a = await f.commit('A'); await f.network.push({ remote: 'origin', ref: 'refs/heads/main', oid: a });
  const b = await f.commit('B'); await f.network.push({ remote: 'origin', ref: 'refs/heads/main', oid: b });
  await f.run(['reset', '--hard', a]); const c = await f.commit('C');
  const denied = await f.network.push({ remote: 'origin', ref: 'refs/heads/main', oid: c }); assert.equal(denied.status, 'rejected'); assert.equal(await f.run(['--git-dir', f.remote, 'rev-parse', 'refs/heads/main']), b);
  await f.run(['switch', '-c', 'new']); const original = f.runner.run.bind(f.runner);
  f.runner.run = async (args, options) => { const result = await original(args, options); if (args.includes('push')) throw Object.assign(new Error('interrupted after completion'), { code: 'GIT_TIMEOUT' }); return result; };
  assert.equal((await f.network.push({ remote: 'origin', ref: 'refs/heads/new', oid: c })).status, 'confirmed');
});
test('clone completes separately and existing folder/cancel remain untouched', async t => {
  const f = await fixture(t); await f.initialize(); const oid = await f.commit('A'); await f.network.push({ remote: 'origin', ref: 'refs/heads/main', oid }); await f.run(['--git-dir', f.remote, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  const destination = path.join(f.temp, 'cloned'); assert.equal((await f.network.clone({ url: f.remote, destination })).root, destination); assert.equal(await fs.readFile(path.join(destination, 'main.tex'), 'utf8'), 'A');
  await assert.rejects(f.network.clone({ url: f.remote, destination }), { code: 'GIT_CLONE_EXISTS' });
  const cancelled = path.join(f.temp, 'cancelled'), controller = new AbortController(); controller.abort();
  await assert.rejects(f.network.clone({ url: f.remote, destination: cancelled, signal: controller.signal }), { code: 'GIT_CANCELLED' });
  await assert.rejects(fs.stat(cancelled), { code: 'ENOENT' }); assert.equal((await fs.readdir(f.temp)).some(x => x.startsWith('.tex64-clone-')), false);
});
test('untrusted rewrites/push destination/helper/TLS are rejected before network', async t => {
  const f = await fixture(t); await f.initialize();
  for (const [key, value, code] of [['url.https://example.invalid/.insteadOf', 'https://github.com/', 'GIT_URL_REWRITE_UNTRUSTED'], ['credential.helper', '!touch /tmp/not-executed', 'GIT_CREDENTIAL_HELPER_UNTRUSTED'], ['http.sslVerify', 'false', 'GIT_TLS_UNTRUSTED']]) {
    await f.run(['config', key, value]); await assert.rejects(f.network.fetch({ remote: 'origin' }), { code }); await f.run(['config', '--unset', key]);
  }
  await f.run(['config', 'remote.origin.pushurl', 'https://github.com/other/repository.git']); await assert.rejects(f.network.fetch({ remote: 'origin' }), { code: 'GIT_PUSH_URL_DIFFERENT' });
  const production = new GitNetwork({ runner: f.runner, runtime: f.runtime }); await assert.rejects(production.connect({ url: f.remote }), { code: 'GIT_URL_INVALID' });
});
test('authentication invokes only explicit browser login with isolated config and no output pipes', async t => {
  const f = await fixture(t); let called = null;
  const network = new GitNetwork({ runner: f.runner, runtime: f.runtime, spawnImpl: (binary, args, options) => { called = { binary, args, options }; const child = new EventEmitter(); child.kill = () => {}; queueMicrotask(() => child.emit('close', 0)); return child; } });
  assert.deepEqual(await network.authenticate(), { authenticated: true });
  assert.equal(called.binary, f.runtime.credentialManager); assert.deepEqual(called.args, ['github', 'login', '--url', 'https://github.com', '--browser']);
  assert.equal(called.options.stdio, 'ignore'); assert.equal(called.options.shell, false); assert.equal(called.options.env.GCM_INTERACTIVE, '1'); assert.equal(called.options.env.GIT_CONFIG_GLOBAL, '/dev/null'); assert.equal(called.options.env.GCM_CREDENTIAL_STORE, 'keychain');
  await assert.rejects(fs.stat(called.options.cwd), { code: 'ENOENT' });
});
test('unverifiable interrupted push stays unknown and clone interrupted after transfer cleans only owned files', async t => {
  const f = await fixture(t); await f.initialize(); const a = await f.commit('A');
  const original = f.runner.run.bind(f.runner); let attempted = false;
  f.runner.run = async (args, options) => {
    if (args.includes('push')) { attempted = true; throw Object.assign(new Error('connection lost'), { code: 'GIT_TIMEOUT' }); }
    if (attempted && args.includes('ls-remote')) throw Object.assign(new Error('offline'), { code: 'GIT_TIMEOUT' });
    return original(args, options);
  };
  assert.equal((await f.network.push({ remote: 'origin', ref: 'refs/heads/main', oid: a })).status, 'unknown');
  f.runner.run = original; await f.network.push({ remote: 'origin', ref: 'refs/heads/main', oid: a });
  await f.run(['--git-dir', f.remote, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  const destination = path.join(f.temp, 'cancel-transfer'), sentinel = path.join(f.temp, 'keep.txt'); await fs.writeFile(sentinel, 'Keep');
  f.runner.run = async (args, options) => { const result = await original(args, options); if (args.includes('clone')) throw Object.assign(new Error('interrupted'), { code: 'GIT_CANCELLED' }); return result; };
  await assert.rejects(f.network.clone({ url: f.remote, destination }), { code: 'GIT_CANCELLED' });
  await assert.rejects(fs.stat(destination), { code: 'ENOENT' }); assert.equal(await fs.readFile(sentinel, 'utf8'), 'Keep');
  assert.equal((await fs.readdir(f.temp)).some(x => x.startsWith('.tex64-clone-')), false);
});

test('connect does not invoke global filters or helpers; bundled auth approval binds settings without rewriting them', async t => {
 const f=await fixture(t); const marker=path.join(f.temp,'must-not-execute');
 await f.run(['config','--global','filter.sentinel.clean',`touch '${marker}'; cat`]);
 await f.run(['config','--global','credential.helper',`!touch '${marker}'`]);
 const globalFile=path.join(f.runtime.env.HOME,'.gitconfig'); const original=await fs.readFile(globalFile);
 await f.initialize(); await assert.rejects(f.network.fetch({remote:'origin'}),{code:'GIT_CREDENTIAL_HELPER_UNTRUSTED'});
 let plan=await f.network.planAuthentication(); assert.equal(plan.review.actionLabel,'TeX64の認証を使う'); assert(!JSON.stringify(plan).includes(marker));
 await f.network.approveAuthentication({planId:plan.planId}); const endpoint=await f.network.endpoint('origin'); assert(endpoint.flags.includes('credential.helper=')); assert(endpoint.flags.some(s=>s.includes(f.runtime.credentialManager)));
 await f.network.fetch({remote:'origin'}); assert.deepEqual(await fs.readFile(globalFile),original); await assert.rejects(fs.access(marker));
 await assert.rejects(f.network.approveAuthentication({planId:plan.planId}),{code:'GIT_PLAN_EXPIRED'});
 await f.run(['config','--global','user.name','changed']); await assert.rejects(f.network.fetch({remote:'origin'}),{code:'GIT_CREDENTIAL_HELPER_UNTRUSTED'});
 plan=await f.network.planAuthentication(); await f.run(['config','--global','user.name','changed again']); await assert.rejects(f.network.approveAuthentication({planId:plan.planId}),{code:'STATE_CHANGED'});
 await f.run(['config','http.sslVerify','false']); await assert.rejects(f.network.planAuthentication(),{code:'GIT_TLS_UNTRUSTED'}); await assert.rejects(fs.access(marker));
});
test('clone with registered unused filters succeeds, but effective target or outside global attributes stop before checkout', async t=>{
 const f=await fixture(t); await f.initialize(); const oid=await f.commit('A'); await f.network.push({remote:'origin',ref:'refs/heads/main',oid}); await f.run(['--git-dir',f.remote,'symbolic-ref','HEAD','refs/heads/main']);
 const marker=path.join(f.temp,'filter-sentinel'); await f.run(['config','--global','filter.sentinel.smudge',`touch '${marker}'; cat`]); await f.run(['config','--global','filter.sentinel.clean',`touch '${marker}'; cat`]);
 const safe=path.join(f.temp,'safe-clone'); await f.network.clone({url:f.remote,destination:safe}); assert.equal(await fs.readFile(path.join(safe,'main.tex'),'utf8'),'A'); await assert.rejects(fs.access(marker));
 const attributes=path.join(f.temp,'outside-attributes'); await fs.writeFile(attributes,'*.tex filter=sentinel\n'); await f.run(['config','--global','core.attributesFile',attributes]);
 const blocked=path.join(f.temp,'blocked-clone'); await assert.rejects(f.network.clone({url:f.remote,destination:blocked}),{code:'GIT_FILTER_UNTRUSTED'}); await assert.rejects(fs.access(blocked)); await assert.rejects(fs.access(marker));
 await f.run(['config','--global','--unset','core.attributesFile']); await fs.writeFile(path.join(f.root,'.gitattributes'),'*.tex filter=sentinel\n');
 // Prepare a remote with filter attributes without executing that filter.
 await f.run(['-c','filter.sentinel.clean=cat','add','.gitattributes']); await f.run(['-c','filter.sentinel.clean=cat','commit','-m','attributes']); const next=await f.run(['rev-parse','HEAD']); await f.network.push({remote:'origin',ref:'refs/heads/main',oid:next});
 await assert.rejects(f.network.clone({url:f.remote,destination:blocked}),{code:'GIT_FILTER_UNTRUSTED'}); await assert.rejects(fs.access(marker)); assert.equal((await fs.readdir(f.temp)).some(x=>x.startsWith('.tex64-clone-')),false);
});

test('unrelated roots are distinguished from ordinary incoming and outgoing commits', async t => {
  const f = await fixture(t); await f.initialize(); await f.commit('Local');
  const tree = await f.run(['rev-parse', 'HEAD^{tree}']);
  const root = await f.run(['commit-tree', tree, '-m', 'Independent history']);
  await f.run(['update-ref', 'refs/remotes/origin/other', root]);
  assert.deepEqual(await f.network.aheadBehind({localRef:'refs/heads/main',remoteRef:'refs/remotes/origin/other'}), {ahead:1,behind:1,related:false});
});
