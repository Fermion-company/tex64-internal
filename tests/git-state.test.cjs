"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { GitRunner, redactGitOutput } = require("../electron/services/git-runner.cjs");
const { GitState, parsePorcelainV2, validateGitHubUrl } = require("../electron/services/git-state.cjs");
const binary = process.env.TEX64_TEST_GIT || "/usr/bin/git";
const cleanEnv = { GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-git-state-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const environment = { ...cleanEnv, HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: root };
  const git = (...args) => execFileSync(binary, ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8", env: { ...process.env, ...environment, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" } });
  git("init", "--quiet", "--initial-branch=main");
  const runner = new GitRunner({ binaryPath: binary, root, env: environment });
  const state = new GitState({ runner });
  return { root, git, runner, state, environment, write: (name, content) => fs.writeFile(path.join(root, name), content) };
}

test("strict GitHub URLs accept canonical HTTPS/SSH and reject credentials, helpers and web-file URLs", () => {
  assert.deepEqual(validateGitHubUrl("https://github.com/Fermion-company/TeX64-internal"), { owner: "Fermion-company", repo: "TeX64-internal", transport: "https", url: "https://github.com/Fermion-company/TeX64-internal.git", webUrl: "https://github.com/Fermion-company/TeX64-internal" });
  for (const value of ["git@github.com:owner/repo.git", "ssh://git@github.com/owner/repo"]) assert.equal(validateGitHubUrl(value).url, "git@github.com:owner/repo.git");
  for (const value of ["https://token@github.com/owner/repo", "https://github.com:443/owner/repo", "ssh://git@github.com:22/owner/repo", "ssh://user@github.com/owner/repo", "https://github.com/owner/repo?x=1", "https://github.com/owner/repo#main", "https://github.com/owner/repo/tree/main", "https://github.com/owner/repo/blob/main/a.tex", "https://github.com/owner/repo%2fother", "https://github.com.evil.invalid/owner/repo", "file:///tmp/repo", "ext::sh -c whatever", "/tmp/repo", "https://github.com/../repo", "https://github.com/owner/..", " https://github.com/owner/repo", "https://github.com/owner/repo\n"]) assert.throws(() => validateGitHubUrl(value), { code: "GIT_URL_INVALID" }, value);
});

test("real porcelain v2 preserves rename, whitespace/newline names and partial staging without refreshing index", async t => {
  const f = await fixture(t);
  const unborn = await f.state.read(); assert.equal(unborn.unborn, true); assert.equal(unborn.branch, "main"); assert.equal(unborn.supported, true); assert(!unborn.executableConfig.some(item => item.key === "core.fsmonitor"));
  await f.write("partial.tex", "one\n"); await f.write("old name\n.tex", "original\n");
  f.git("add", "--", "partial.tex", "old name\n.tex"); f.git("commit", "--quiet", "-m", "base");
  f.git("mv", "--", "old name\n.tex", "new name\n.tex");
  await f.write("partial.tex", "one\ntwo\n"); f.git("add", "--", "partial.tex");
  await f.write("partial.tex", "one\ntwo\nthree\n"); await f.write("-untracked name\n.tex", "new");
  const index = await fs.readFile(path.join(f.root, ".git/index"));
  const state = await f.state.read();
  assert.equal(state.status.hasPartialStage, true);
  const partial = state.status.entries.find(item => item.path === "partial.tex");
  assert.equal(partial.index, "M"); assert.equal(partial.worktree, "M"); assert.equal(partial.partiallyStaged, true);
  const rename = state.status.entries.find(item => item.kind === "rename");
  assert.equal(rename.path, "new name\n.tex"); assert.equal(rename.originalPath, "old name\n.tex");
  assert.equal(state.status.entries.find(item => item.kind === "untracked").path, "-untracked name\n.tex");
  assert.deepEqual(await fs.readFile(path.join(f.root, ".git/index")), index);
  assert.equal((await f.state.read()).stateFingerprint, state.stateFingerprint);
  await f.write("partial.tex", "more\n"); f.git("add", "--", "partial.tex");
  assert.notEqual((await f.state.read()).indexFingerprint, state.indexFingerprint);
});

test("detached HEAD and a real unresolved merge remain distinct operation states", async t => {
  const f = await fixture(t); await f.write("main.tex", "base\n"); f.git("add", "main.tex"); f.git("commit", "--quiet", "-m", "base");
  f.git("checkout", "--quiet", "--detach");
  let state = await f.state.read(); assert.equal(state.detached, true); assert.equal(state.branch, null); assert.equal(state.unborn, false);
  f.git("checkout", "--quiet", "main"); f.git("checkout", "--quiet", "-b", "side");
  await f.write("main.tex", "side\n"); f.git("commit", "--quiet", "-am", "side");
  f.git("checkout", "--quiet", "main"); await f.write("main.tex", "main\n"); f.git("commit", "--quiet", "-am", "main");
  assert.throws(() => f.git("merge", "--no-edit", "side"));
  state = await f.state.read(); assert.equal(state.operation, "merge"); assert.equal(state.status.hasUnmerged, true);
  assert.equal(state.status.entries.find(item => item.path === "main.tex").kind, "unmerged");
  assert(state.refs.some(item => item.name === "refs/heads/side"));
});

test("executable config is reported without executing fsmonitor/filter commands or exposing secrets", async t => {
  const f = await fixture(t); await f.write("main.tex", "base"); f.git("add", "main.tex"); f.git("commit", "--quiet", "-m", "base");
  const marker = path.join(f.root, "must-not-run");
  f.git("config", "core.fsmonitor", `touch '${marker}'`);
  let state = await f.state.read(); assert(state.executableConfig.some(item => item.key === "core.fsmonitor")); await assert.rejects(fs.access(marker));
  f.git("config", "filter.danger.clean", `touch '${marker}'`); await f.write(".gitattributes", "*.tex filter=danger\n");
  f.git("config", "remote.MyRemote.url", "https://ghp_privateToken@github.com/owner/repo.git");
  state = await f.state.read(); assert.equal(state.status, null); assert.equal(state.supported, false); assert.equal(state.unsupportedReason, "untrusted-filter");
  assert.equal(state.remotes[0].name, "MyRemote"); assert.equal(state.remotes[0].validated, false); assert(!JSON.stringify(state).includes("privateToken")); await assert.rejects(fs.access(marker));
  assert.equal(redactGitOutput("Authorization: Bearer ghp_secret https://user:pass@github.com/a/b"), "Authorization: [redacted] https://[redacted]@github.com/a/b");
});

test("repository layout detection refuses a nested workspace and a linked worktree", async t => {
  const f = await fixture(t); await f.write("main.tex", "base"); f.git("add", "main.tex"); f.git("commit", "--quiet", "-m", "base");
  await fs.mkdir(path.join(f.root, "nested"));
  const nested = await new GitState({ runner: new GitRunner({ binaryPath: binary, root: path.join(f.root, "nested"), env: f.environment }) }).read();
  assert.equal(nested.layout, "nested-folder"); assert.equal(nested.supported, false);
  const linked = path.join(f.root, "linked"); f.git("worktree", "add", "--quiet", "-b", "linked", linked);
  const result = await new GitState({ runner: new GitRunner({ binaryPath: binary, root: linked, env: f.environment }) }).read();
  assert.equal(result.layout, "linked-worktree"); assert.equal(result.supported, false);
  const bare = path.join(f.root, "bare.git"); f.git("init", "--quiet", "--bare", bare);
  const bareState = await new GitState({ runner: new GitRunner({ binaryPath: binary, root: bare, env: f.environment }) }).read();
  assert.equal(bareState.layout, "bare"); assert.equal(bareState.status, null); assert.equal(bareState.supported, false);
});

test("parser fails closed on truncated rename and non-UTF8 paths", () => {
  assert.throws(() => parsePorcelainV2(Buffer.from("? incomplete")), { code: "GIT_STATUS_INVALID" });
  assert.throws(() => parsePorcelainV2(Buffer.from([63, 32, 255, 0])), { code: "GIT_PATH_ENCODING" });
});

test("runner bounds output, waits for termination on timeout/cancel, and pins root identity", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-git-runner-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runner = new GitRunner({ binaryPath: process.execPath, root, timeoutMs: 1000, maxOutputBytes: 100 });
  await assert.rejects(runner.run(["-e", "process.stdout.write('x'.repeat(10000)); setInterval(()=>{},1000)"]), { code: "GIT_OUTPUT_LIMIT" });
  const pidFile = path.join(root, "pid");
  await assert.rejects(runner.run(["-e", `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`]), { code: "GIT_TIMEOUT" });
  const pid = Number(await fs.readFile(pidFile, "utf8")); assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  const abort = new AbortController();
  const running = runner.run(["-e", "setInterval(()=>{},1000)"], { signal: abort.signal, timeoutMs: 2000 }); abort.abort();
  await assert.rejects(running, { code: "GIT_CANCELLED" });
  const moved = `${root}-moved`; await fs.rename(root, moved); t.after(() => fs.rm(moved, { recursive: true, force: true })); await fs.mkdir(root);
  await assert.rejects(runner.run(["--version"]), { code: "STALE_WORKSPACE" });
});


test("merged runtime environment cannot redirect the repository or enable credential traces", async t => {
  const first = await fixture(t), other = await fixture(t);
  const trace = path.join(first.root, "must-not-trace");
  const runner = new GitRunner({ binaryPath: binary, root: first.root, env: {
    ...first.environment,
    GIT_DIR: path.join(other.root, ".git"), GIT_WORK_TREE: other.root,
    GIT_INDEX_FILE: path.join(other.root, ".git", "index"),
    GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.worktree", GIT_CONFIG_VALUE_0: other.root,
    GIT_TRACE: trace, GIT_TRACE_PACKET: trace, GCM_TRACE: trace, GCM_TRACE_SECRETS: "1",
  } });
  const state = await new GitState({ runner }).read();
  assert.equal(state.root, runner.root);
  assert.equal(state.gitDir, path.join(runner.root, ".git"));
  await assert.rejects(fs.access(trace));
  const injected = {
    DOTNET_STARTUP_HOOKS: "/untrusted/hook.dll", COMPlus_StartupHook: "/untrusted/other.dll",
    DYLD_INSERT_LIBRARIES: "/untrusted/injected.dylib", GCM_PROVIDER: "untrusted-provider", GCM_TRACE_SECRETS: "1",
    BROWSER: "/untrusted/browser", GH_TOKEN: "ghp_private", GITHUB_TOKEN: "github_pat_private",
    GH_ENTERPRISE_TOKEN: "private-enterprise", GITHUB_ENTERPRISE_TOKEN: "private-enterprise-2",
  };
  // Model getGitRuntime() removing a process-env key before passing its env
  // object to GitRunner: a missing key must not reappear through the merge.
  const previousHook = process.env.DOTNET_STARTUP_HOOKS;
  process.env.DOTNET_STARTUP_HOOKS = injected.DOTNET_STARTUP_HOOKS;
  try {
    const constructorInjection = { ...injected }; delete constructorInjection.DOTNET_STARTUP_HOOKS;
    const inspect = new GitRunner({ binaryPath: process.execPath, root: first.root, env: {
      ...constructorInjection,
      GIT_DIR: other.root, GCM_TRACE: trace, GIT_EXEC_PATH: "/trusted/runtime/libexec", GIT_TEMPLATE_DIR: "/trusted/runtime/templates",
      DOTNET_MULTILEVEL_LOOKUP: "1", GCM_CREDENTIAL_STORE: "keychain", GCM_INTERACTIVE: "1",
    } });
    const inspectCode = `const names=${JSON.stringify(Object.keys(injected))};process.stdout.write(JSON.stringify({gitDir:process.env.GIT_DIR,trace:process.env.GCM_TRACE,execPath:process.env.GIT_EXEC_PATH,templates:process.env.GIT_TEMPLATE_DIR,lookup:process.env.DOTNET_MULTILEVEL_LOOKUP,store:process.env.GCM_CREDENTIAL_STORE,interactive:process.env.GCM_INTERACTIVE,injected:Object.fromEntries(names.filter(n=>process.env[n]!==undefined).map(n=>[n,process.env[n]]))}))`;
    const result = JSON.parse((await inspect.run(["-e", inspectCode])).stdout);
    assert.deepEqual(result, { execPath: "/trusted/runtime/libexec", templates: "/trusted/runtime/templates", lookup: "0", store: "keychain", interactive: "0", injected: {} });
  } finally {
    if (previousHook === undefined) delete process.env.DOTNET_STARTUP_HOOKS;
    else process.env.DOTNET_STARTUP_HOOKS = previousHook;
  }
});

test('effective global/info/project filter attributes are checked without executing registered commands', async t=>{
 const f=await fixture(t); await f.write('main.tex','plain'); f.git('add','main.tex'); f.git('commit','--quiet','-m','base');
 const marker=path.join(f.root,'filter-sentinel'); await f.runner.run(['config','--global','filter.sentinel.clean',`touch '${marker}'; cat`]);
 let state=await f.state.read(); assert.equal(state.supported,true); assert.equal(state.status.clean,false); await assert.rejects(fs.access(marker));
 await f.write('main.tex','changed'); state=await f.state.read(); assert.equal(state.supported,true); await assert.rejects(fs.access(marker));
 await fs.writeFile(path.join(f.root,'.git/info/attributes'),'*.tex filter=sentinel\n'); state=await f.state.read(); assert.equal(state.supported,false); assert.deepEqual(state.filteredPaths,[{path:'main.tex',filter:'sentinel'}]); await assert.rejects(fs.access(marker));
 await fs.unlink(path.join(f.root,'.git/info/attributes')); const outside=path.join(await fs.mkdtemp(path.join(os.tmpdir(),'tex64-attrs-')),'global'); t.after(()=>fs.rm(path.dirname(outside),{recursive:true,force:true})); await fs.writeFile(outside,'*.tex filter=sentinel\n'); await f.runner.run(['config','--global','core.attributesFile',outside]);
 state=await f.state.read(); assert.equal(state.supported,false); await assert.rejects(fs.access(marker));
 await f.runner.run(['config','--global','--unset','core.attributesFile']); await f.write('.gitattributes','*.tex filter=sentinel\n'); state=await f.state.read(); assert.equal(state.supported,false); await assert.rejects(fs.access(marker));
});
