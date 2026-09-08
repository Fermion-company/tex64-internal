'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { GitController } = require('../electron/services/git-controller.cjs');
const { getGitRuntime } = require('../electron/services/git-runtime.cjs');
const { WorkspaceOperationCoordinator } = require('../electron/services/workspace-operation.cjs');
async function fixture(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tex64-controller-test-'))); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'project'), home = path.join(dir, 'home'); await fs.mkdir(root); await fs.mkdir(home);
  const identity = { workspaceId: 'project', workspaceGeneration: 1 }, coordinator = new WorkspaceOperationCoordinator();
  let busy = false, terminals = false, quiesced = 0;
  const runtime = getGitRuntime({ baseEnv: { HOME: home, XDG_CONFIG_HOME: home, PATH: '/usr/bin:/bin' } });
  const deps = { state: identity, coordinator, workspace: { getRootPath: () => root }, directory: () => path.join(dir, 'private'), runtime,
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() },
    notify: () => {}, isAgentBusy: () => busy, hasTerminals: () => terminals,
    withMutation: async action => { coordinator.assertWriterAllowed(); return action(); }, quiesce: async () => { quiesced++; },
    advanceGeneration: () => { identity.workspaceGeneration++; }, afterRestore: async () => {} };
  const controller = new GitController(deps), session = await controller.session();
  const run = async args => (await session.runner.run(args)).stdout.toString('utf8').trim();
  await run(['init', '-b', 'main']); await run(['config', 'user.name', 'Fixture']); await run(['config', 'user.email', 'fixture@example.invalid']);
  await fs.writeFile(path.join(root, 'main.tex'), 'A'); await run(['add', 'main.tex']); await run(['commit', '-m', 'A']);
  const request = (action, args = {}) => controller.request(action, { ...identity, ...args });
  const begin = () => request('begin', { openPaths: ['main.tex'] });
  return { dir, root, identity, coordinator, controller, session, deps, run, request, begin, setBusy: value => { busy = value; }, setTerminals: value => { terminals = value; }, quiesced: () => quiesced };
}
test('saving lease is Git-owned, phase-limited, and stale workspace requests fail', async t => {
  const f = await fixture(t); const { token } = await f.begin();
  assert.equal(f.coordinator.status().owner, 'git'); assert.equal(f.coordinator.status().phase, 'saving'); assert.equal(f.quiesced(), 1);
  await f.controller.run(token, async () => f.coordinator.assertWriterAllowed());
  assert.throws(() => f.coordinator.assertWriterAllowed(), { code: 'HISTORY_BUSY' });
  f.controller.operation.phase = 'working'; assert.throws(() => f.controller.run(token, () => {}), { code: 'GIT_BUSY' }); f.controller.operation.phase = 'saving';
  await assert.rejects(f.controller.request('status', { workspaceId: 'old', workspaceGeneration: 1 }), { code: 'STALE_WORKSPACE' });
  await f.request('release', { token }); assert.equal(f.coordinator.blocked(), false);
});
test('Axiom, terminals, and a history lease stop begin before quiescence', async t => {
  const f = await fixture(t); f.setBusy(true); await assert.rejects(f.begin(), { code: 'WORKSPACE_BUSY' }); f.setBusy(false);
  f.setTerminals(true); await assert.rejects(f.begin(), { code: 'TERMINAL_BUSY' }); f.setTerminals(false);
  f.coordinator.claim('history', { id: 'history', phase: 'saving' }); await assert.rejects(f.begin(), { code: 'GIT_BUSY' });
  assert.equal(f.quiesced(), 0); f.coordinator.release('history', 'history');
});
test('actual branch switch advances generation and requires new model contents before releasing writers', async t => {
  const f = await fixture(t); await f.run(['switch', '-c', 'next']); await fs.writeFile(path.join(f.root, 'main.tex'), 'B'); await f.run(['commit', '-am', 'B']); await f.run(['switch', 'main']);
  const { token } = await f.begin(); const { plan } = await f.request('plan', { token, action: 'branch-switch', args: { ref: 'refs/heads/next' } });
  assert.ok(plan.planId); assert.ok(plan.review); const previous = { ...f.identity };
  const result = await f.request('execute', { token, planId: plan.planId }); assert.deepEqual(result.files, [{ path: 'main.tex', content: 'B' }]); assert.equal(f.identity.workspaceGeneration, previous.workspaceGeneration + 1);
  assert.equal(f.controller.status().phase, 'syncing'); await assert.rejects(f.request('release', { token }), { code: 'GIT_BUSY' });
  await assert.rejects(f.request('ack', { token, buffers: [{ path: 'main.tex', content: 'A', savedContent: 'A' }] }), { code: 'SYNC_REQUIRED' });
  assert.equal(JSON.stringify(result).includes('beforeVault'), false); assert.equal(JSON.stringify(result).includes('configFingerprint'), false);
  await f.request('ack', { token, buffers: [{ path: 'main.tex', content: 'B', savedContent: 'B' }] }); assert.equal(f.controller.status().phase, 'idle');
  await assert.rejects(f.controller.request('status', previous), { code: 'STALE_WORKSPACE' });
});
test('mutation error still synchronizes generation; deleted/binary files cannot retain editable models', async t => {
  const f = await fixture(t); const { token } = await f.begin(); const { plan } = await f.request('plan', { token, action: 'branch-create', args: { name: 'new' } });
  f.session.service.execute = async () => { await fs.unlink(path.join(f.root, 'main.tex')); throw Object.assign(new Error('private diagnostic'), { code: 'GIT_FAILED' }); };
  await assert.rejects(f.request('execute', { token, planId: plan.planId }), error => error.code === 'GIT_FAILED' && !error.message.includes('private diagnostic'));
  assert.equal(f.identity.workspaceGeneration, 2); assert.equal(f.controller.status().phase, 'syncing');
  const sync = await f.request('sync'); assert.deepEqual(sync.files, [{ path: 'main.tex', content: null }]); assert.equal(f.identity.workspaceGeneration, 2);
  await assert.rejects(f.request('ack', { token, buffers: [{ path: 'main.tex', content: '', savedContent: '' }] }), { code: 'SYNC_REQUIRED' });
  await f.request('ack', { token, buffers: [] }); assert.equal(f.coordinator.blocked(), false);
});
test('disk changes during synchronization demand another sync; hidden vault contents never enter status', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.root, '.env'), 'PRIVATE_VALUE=keep');
  const { token } = await f.begin(); const { plan } = await f.request('plan', { token, action: 'branch-create', args: { name: 'new' } });
  await f.request('execute', { token, planId: plan.planId }); await fs.writeFile(path.join(f.root, 'main.tex'), 'External');
  await assert.rejects(f.request('ack', { token, buffers: [{ path: 'main.tex', content: 'A', savedContent: 'A' }] }), { code: 'SYNC_REQUIRED' });
  const sync = await f.request('sync'); assert.deepEqual(sync.files, [{ path: 'main.tex', content: 'External' }]);
  const status = await f.request('status'); const serialized = JSON.stringify(status); assert.equal(serialized.includes('PRIVATE_VALUE'), false); assert.equal(serialized.includes('gitDir'), false); assert.equal(serialized.includes('configFingerprint'), false);
  await f.request('ack', { token, buffers: [{ path: 'main.tex', content: 'External', savedContent: 'External' }] });
});
test('merge keeps a conflict gate through CAS resolution and staging until merge completion', async t => {
  const f = await fixture(t);
  await f.run(['switch', '-c', 'other']); await fs.writeFile(path.join(f.root, 'main.tex'), 'Other\n'); await f.run(['commit', '-am', 'Other']);
  await f.run(['switch', 'main']); await fs.writeFile(path.join(f.root, 'main.tex'), 'Main\n'); await f.run(['commit', '-am', 'Main']);
  const saved = async (purpose, action, args) => {
    const { token } = await f.request('begin', { purpose, openPaths: ['main.tex'] }); const { plan } = await f.request('plan', { token, action, args });
    const result = await f.request('execute', { token, planId: plan.planId });
    await f.request('ack', { token, buffers: result.files.filter(file => file.content !== null).map(file => ({ ...file, savedContent: file.content })) }); return result;
  };
  await saved('merge', 'merge', { ref: 'refs/heads/other' });
  assert.equal(f.controller.status().phase, 'conflict'); assert.equal(f.coordinator.blocked(), true); await assert.rejects(f.request('begin', { purpose: 'commit' }), { code: 'GIT_BUSY' });
  const conflict = await f.request('read-conflict', { path: 'main.tex' }); assert.equal(conflict.original, 'Main\n'); assert.equal(conflict.theirs, 'Other\n'); assert.match(conflict.modified, /<<<<<<</);
  const { token } = await f.request('begin', { purpose: 'resolution', openPaths: ['main.tex'] });
  const result = await f.request('write-resolution', { token, conflictId: conflict.conflictId, content: 'Resolved\n' });
  await f.request('ack', { token, buffers: [{ path: 'main.tex', content: 'Resolved\n', savedContent: 'Resolved\n' }] }); assert.equal(f.controller.status().phase, 'conflict');
  await saved('resolve-stage', 'resolve-stage', { paths: ['main.tex'] }); assert.equal(f.controller.status().phase, 'conflict');
  await saved('merge-finish', 'merge-finish', { message: 'Resolved merge' }); assert.equal(f.controller.status().phase, 'idle'); assert.equal(f.coordinator.blocked(), false);
  assert.equal((await f.run(['rev-list', '--parents', '-n', '1', 'HEAD'])).split(' ').length, 3);
  assert.equal(result.files[0].content, 'Resolved\n');
});
test('persistent boundary survives controller restart and Git runtime absence does not block opening', async t => {
  const f = await fixture(t); const { token } = await f.begin(); const { plan } = await f.request('plan', { token, action: 'branch-create', args: { name: 'new' } });
  await f.request('execute', { token, planId: plan.planId }); await f.request('ack', { token, buffers: [] }); const boundary = f.controller.boundary(f.root); assert.ok(boundary);
  const next = new GitController(f.deps); await next.prepareWorkspace(f.root); assert.equal(next.boundary(f.root), boundary);
  const unavailable = new GitController({ ...f.deps, runtime: () => { throw Object.assign(new Error('Missing'), { code: 'GIT_RUNTIME_MISSING' }); } });
  await unavailable.prepareWorkspace(f.root); assert.equal(unavailable.blocked(), false); assert.equal(unavailable.boundary(f.root), boundary);
  const status = await unavailable.request('status', { ...f.identity }); assert.equal(status.runtimeAvailable, false); assert.equal(status.runtimeError, 'GIT_RUNTIME_MISSING');
});
test('repository author and confirmed upstream settings use fixed keys and preserve existing configuration', async t => {
  const f = await fixture(t); await f.run(['config', 'tex64.keep', 'preserve']);
  let { token } = await f.begin(); await f.request('set-author', { token, args: { name: 'Writer', email: 'writer@example.invalid' } }); await f.request('release', { token });
  assert.equal(await f.run(['config', '--local', '--get', 'user.name']), 'Writer'); assert.equal(await f.run(['config', '--local', '--get', 'tex64.keep']), 'preserve');
  const remote = path.join(f.dir, 'remote.git'); await f.run(['init', '--bare', remote]); await f.run(['remote', 'add', 'origin', remote]); await f.run(['push', 'origin', 'main']); await f.run(['fetch', 'origin']);
  ({ token } = await f.begin()); const { plan } = await f.request('plan', { token, action: 'set-upstream', args: { localRef: 'refs/heads/main', remoteRef: 'refs/remotes/origin/main' } });
  const result = await f.request('execute', { token, planId: plan.planId }); await f.request('ack', { token, buffers: [] });
  assert.equal(result.result.state.refs.find(item => item.name === 'refs/heads/main').upstream, 'refs/remotes/origin/main');
  assert.deepEqual(await f.request('ahead-behind', { args: { localRef: 'refs/heads/main', remoteRef: 'refs/remotes/origin/main' } }), { ahead: 0, behind: 0 });
});
test('shelve plan is reviewed, public listing omits contents, and unshelve synchronizes the original draft', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.root, 'main.tex'), 'Draft');
  let { token } = await f.begin(); const { plan } = await f.request('shelve-plan', { token, paths: ['main.tex'] }); assert.ok(plan.planId); assert.equal(plan.changes[0].path, 'main.tex');
  const shelved = await f.request('shelve', { token, planId: plan.planId }); assert.equal(shelved.files[0].content, 'A'); await f.request('ack', { token, buffers: [{ path: 'main.tex', content: 'A', savedContent: 'A' }] });
  const { shelves } = await f.request('shelves'); assert.equal(shelves.length, 1); assert.equal(JSON.stringify(shelves).includes('Draft'), false); assert.deepEqual(shelves[0].paths, ['main.tex']);
  ({ token } = await f.begin()); const restored = await f.request('unshelve', { token, id: shelves[0].id }); assert.equal(restored.files[0].content, 'Draft');
  await f.request('ack', { token, buffers: [{ path: 'main.tex', content: 'Draft', savedContent: 'Draft' }] }); assert.equal(f.coordinator.blocked(), false);
});
test('restart recovery exposes a token and restoring verified before-state still requires model acknowledgment', async t => {
  const f = await fixture(t); await f.run(['switch', '-c', 'next']); await fs.writeFile(path.join(f.root, 'main.tex'), 'B'); await f.run(['commit', '-am', 'B']); await f.run(['switch', 'main']);
  const original = f.session.service.withMutation;
  f.session.service.withMutation = (meta, action) => original({ ...meta, verify: async () => { throw Object.assign(new Error('Injected post-state verification failure'), { code: 'GIT_RESULT_UNVERIFIED' }); } }, action);
  const { token } = await f.begin(); const { plan } = await f.request('plan', { token, action: 'branch-switch', args: { ref: 'refs/heads/next' } });
  await assert.rejects(f.request('execute', { token, planId: plan.planId }), { code: 'GIT_RECOVERY_REQUIRED' });
  await f.request('ack', { token, buffers: [{ path: 'main.tex', content: 'B', savedContent: 'B' }] }); assert.equal(f.controller.status().phase, 'recovery-required');
  const coordinator = new WorkspaceOperationCoordinator(); const deps = { ...f.deps, coordinator, withMutation: async action => { coordinator.assertWriterAllowed(); return action(); } };
  const reopened = new GitController(deps); await reopened.prepareWorkspace(f.root);
  const request = (action, args = {}) => reopened.request(action, { ...f.identity, ...args });
  const status = await request('status'); assert.equal(status.phase, 'recovery-required'); assert.ok(status.token); assert.ok(status.recoveryId);
  const recovery = await request('recovery-plan', { token: status.token, openPaths: ['main.tex'] }); assert.ok(recovery.planId); assert.deepEqual(recovery.blockedPaths, []);
  const restored = await request('recovery-apply', { token: status.token, planId: recovery.planId }); assert.equal(restored.files[0].content, 'A'); assert.equal(reopened.status().phase, 'syncing'); assert.equal(coordinator.blocked(), true);
  await request('ack', { token: status.token, buffers: [{ path: 'main.tex', content: 'A', savedContent: 'A' }] }); assert.equal(coordinator.blocked(), false);
});
test('index-only stage and commit preserve editor generation and PDF freshness', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.root, 'main.tex'), 'Draft'); const before = f.identity.workspaceGeneration;
  const notifications = []; f.deps.afterRestore = async (paths, options) => notifications.push(options);
  for (const [action, args] of [['stage', { paths: ['main.tex'] }], ['commit', { message: 'Draft' }]]) {
    const { token } = await f.begin(); const { plan } = await f.request('plan', { token, action, args }); const result = await f.request('execute', { token, planId: plan.planId });
    assert.equal(result.resetModels, false); assert.equal(f.identity.workspaceGeneration, before); assert.equal(f.controller.boundary(f.root), null);
    await f.request('ack', { token, buffers: [{ path: 'main.tex', content: 'Draft', savedContent: 'Draft' }] });
  }
  assert.ok(notifications.every(item => item.writesWorktree === false));
});
test('recovery export uses only the native picker destination and revalidates the workspace after it', async t => {
  const f = await fixture(t); let received = null, exports = 0;
  f.session.transaction = { exportRecoveryFile: async (id, options) => { exports++; received = { id, ...options }; return { exported: true }; } };
  f.deps.chooseRecoveryDestination = async selection => { assert.deepEqual(selection, { path: 'main.tex', side: 'before' }); return path.join(f.dir, 'chosen.tex'); };
  await f.request('export-recovery-file', { id: 'fixture', path: 'main.tex', side: 'before', destination: '/untrusted/renderer/path' });
  assert.equal(received.destination, path.join(f.dir, 'chosen.tex')); assert.equal(exports, 1);
  f.deps.chooseRecoveryDestination = async () => { f.identity.workspaceGeneration++; return path.join(f.dir, 'stale.tex'); };
  await assert.rejects(f.request('export-recovery-file', { id: 'fixture', path: 'main.tex', side: 'before' }), { code: 'STALE_WORKSPACE' }); assert.equal(exports, 1);
});
test('completed worktree journal repairs a missing boundary marker after a crash', async t => {
  const f = await fixture(t); const { token } = await f.begin(); const { plan } = await f.request('plan', { token, action: 'branch-create', args: { name: 'new' } });
  await f.request('execute', { token, planId: plan.planId }); await f.request('ack', { token, buffers: [] });
  await fs.unlink(path.join(f.controller.directory(f.root), 'boundary.json'));
  const reopened = new GitController(f.deps); await reopened.prepareWorkspace(f.root); const boundary = reopened.boundary(f.root); assert.match(boundary, /^[a-f0-9]{64}$/);
  const reopenedAgain = new GitController(f.deps); await reopenedAgain.prepareWorkspace(f.root); assert.equal(reopenedAgain.boundary(f.root), boundary);
});

test('read-only file diff separates HEAD/index/worktree and returns binary metadata without external diff/textconv',async t=>{
 const f=await fixture(t); const marker=path.join(f.dir,'must-not-run');
 await f.run(['config','diff.external',`touch '${marker}'`]); await f.run(['config','diff.fixture.textconv',`touch '${marker}'`]); await fs.writeFile(path.join(f.root,'.gitattributes'),'*.tex diff=fixture\n');
 await fs.writeFile(path.join(f.root,'main.tex'),'B'); await f.run(['add','main.tex']); await fs.writeFile(path.join(f.root,'main.tex'),'C');
 let result=await f.request('diff',{path:'main.tex',side:'staged'});assert.equal(result.text,true);assert.equal(result.original,'A');assert.equal(result.modified,'B');
 result=await f.request('diff',{path:'main.tex',side:'unstaged'});assert.equal(result.original,'B');assert.equal(result.modified,'C');assert.equal(result.modifiedInfo.hash,await f.run(['hash-object','--no-filters','main.tex']));
 const name=':(glob)*\n.tex';await fs.writeFile(path.join(f.root,name),'new');result=await f.request('diff',{path:name,side:'unstaged'});assert.equal(result.original,'');assert.equal(result.modified,'new');assert.equal(result.originalInfo.exists,false);
 await fs.writeFile(path.join(f.root,'main.tex'),Buffer.from([0,1,2,3]));result=await f.request('diff',{path:'main.tex',side:'unstaged'});assert.equal(result.text,false);assert.equal(result.original,null);assert.equal(result.modified,null);assert.equal(result.modifiedInfo.size,4);assert.match(result.modifiedInfo.hash,/^[a-f0-9]{40}$/);await assert.rejects(fs.access(marker));
 await fs.unlink(path.join(f.root,'main.tex'));result=await f.request('diff',{path:'main.tex',side:'unstaged'});assert.equal(result.original,'B');assert.equal(result.modified,'');assert.equal(result.modifiedInfo.exists,false);
 await assert.rejects(f.request('diff',{path:'../outside',side:'unstaged'}),{code:'GIT_PATH_INVALID'});await assert.rejects(f.request('diff',{path:name,side:'other'}),{code:'GIT_DIFF_SIDE'});
 assert.equal(f.coordinator.status().phase,'idle');
});
test('staged rename compares original HEAD path and deletion works when its parent directory is absent',async t=>{
 const f=await fixture(t);await f.run(['mv','main.tex','renamed.tex']);let result=await f.request('diff',{path:'renamed.tex',side:'staged'});assert.equal(result.original,'A');assert.equal(result.modified,'A');
 await fs.mkdir(path.join(f.root,'folder'));await fs.writeFile(path.join(f.root,'folder/nested.tex'),'nested');await f.run(['add','folder/nested.tex']);await f.run(['commit','-m','nested']);await fs.rm(path.join(f.root,'folder'),{recursive:true});
 result=await f.request('diff',{path:'folder/nested.tex',side:'unstaged'});assert.equal(result.original,'nested');assert.equal(result.modified,'');
});
