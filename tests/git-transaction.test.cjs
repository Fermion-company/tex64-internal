"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { execFileSync, spawn } = require("node:child_process");
const { once } = require("node:events");
const { GitRunner } = require("../electron/services/git-runner.cjs");
const { GitVault } = require("../electron/services/git-vault.cjs");
const { GitTransaction } = require("../electron/services/git-transaction.cjs");
const binaryPath = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-git-transaction-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, "project"); await fs.mkdir(root);
  const git = (...args) => execFileSync(binaryPath, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "main"); git("config", "user.name", "Vault Test"); git("config", "user.email", "vault@example.invalid");
  await fs.writeFile(path.join(root, "main.tex"), "main content"); git("add", "main.tex"); git("commit", "-m", "initial");
  git("switch", "-c", "other"); await fs.writeFile(path.join(root, "main.tex"), "other content"); git("commit", "-am", "other"); git("switch", "main");
  const runner = new GitRunner({ root, binaryPath });
  const key = crypto.randomBytes(32), vaultDirectory = path.join(base, "vault"), directory = path.join(base, "journal");
  const vault = new GitVault({ directory: vaultDirectory, key });
  const transaction = new GitTransaction({ runner, vault, directory });
  return { base, root, git, runner, vault, key, directory, vaultDirectory, transaction };
}

test("branch switch has durable encrypted before/after metadata and exact changed paths", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, ".env"), "TRANSACTION_SECRET_DO_NOT_LOG");
  const indexBefore = await fs.readFile(path.join(f.root, ".git", "index"));
  const result = await f.transaction.run({ action: "branch-switch", verify: ({ after }) => after.branchRef === "refs/heads/other" ? "completed" : false }, async () => {
    const records = await f.transaction.list(); assert.equal(records[0].phase, "running");
    await f.runner.run(["switch", "--no-overwrite-ignore", "other"]);
    return { selected: "other" };
  });
  assert.deepEqual(result.changedPaths, ["main.tex"]);
  assert.deepEqual(result.result, { selected: "other" });
  assert.equal(result.transaction.recoveryRequired, false);
  const journal = await f.transaction.read(result.transaction.id);
  const before = await f.vault.read(journal.beforeVault), after = await f.vault.read(journal.afterVault);
  assert.deepEqual(before.metadata.git.files.index.content, indexBefore);
  assert.equal(before.metadata.git.branchRef, "refs/heads/main");
  assert.equal(after.metadata.git.branchRef, "refs/heads/other");
  const plainJournal = await fs.readFile(f.transaction.journalPath(journal.id), "utf8");
  assert.equal(plainJournal.includes("TRANSACTION_SECRET_DO_NOT_LOG"), false);
  assert.equal(plainJournal.includes("refs/heads/main"), false);
  assert.equal(plainJournal.includes(".env"), false);
  const restarted = new GitTransaction({ runner: f.runner, vault: f.vault, directory: f.directory });
  assert.equal((await restarted.list())[0].phase, "completed");
  assert.equal((await restarted.recover(journal.id)).match, "terminal");
});

test("verification failure retains both states and refuses another mutation", async (t) => {
  const f = await fixture(t);
  let transactionId;
  await assert.rejects(f.transaction.run({ kind: "branch-switch", verify: () => false }, async () => { await f.runner.run(["switch", "other"]); }), (error) => { transactionId = error.transactionId; return error.code === "GIT_RECOVERY_REQUIRED"; });
  assert.equal(f.git("branch", "--show-current"), "other");
  const journal = await f.transaction.read(transactionId);
  assert.equal(journal.phase, "recovery-required"); assert.ok(journal.beforeVault); assert.ok(journal.afterVault); assert.ok(journal.recoveryVault);
  let called = false;
  await assert.rejects(f.transaction.run({ kind: "branch-switch", verify: () => "completed" }, () => { called = true; }), { code: "GIT_RECOVERY_REQUIRED" });
  assert.equal(called, false);
  await fs.writeFile(path.join(f.root, "main.tex"), "external edit after failure");
  const recovery = await f.transaction.recover(transactionId);
  assert.equal(recovery.match, "different");
  assert.equal(await fs.readFile(path.join(f.root, "main.tex"), "utf8"), "external edit after failure");
  const current = await f.vault.read((await f.transaction.read(transactionId)).recoveryVault);
  assert.equal(current.entries.find((entry) => entry.path === "main.tex").content.toString(), "external edit after failure");
  assert.equal((await f.vault.read(journal.beforeVault)).entries.find((entry) => entry.path === "main.tex").content.toString(), "main content");
});

test("invalid/stale plans and a pre-execution cancellation do not call Git mutation", async (t) => {
  const f = await fixture(t); let called = false;
  await assert.rejects(f.transaction.run({ kind: "branch-switch" }, () => { called = true; }), { code: "GIT_VERIFY_REQUIRED" });
  await assert.rejects(f.transaction.run({ kind: "branch-switch", expectedGitFingerprint: "stale", verify: () => "completed" }, () => { called = true; }), { code: "STATE_CHANGED" });
  const signal = AbortSignal.abort();
  await assert.rejects(f.transaction.run({ kind: "branch-switch", signal, verify: () => "completed" }, () => { called = true; }), { code: "GIT_CANCELLED" });
  assert.equal(called, false);
  assert.equal(f.git("branch", "--show-current"), "main");
  assert.equal((await f.transaction.list())[0].phase, "cancelled-before-action");
});

test("killed process leaves running journal recoverable without automatic rollback", async (t) => {
  const f = await fixture(t);
  const moduleRoot = path.resolve(__dirname, "../electron/services");
  const code = `const {GitRunner}=require(${JSON.stringify(path.join(moduleRoot, "git-runner.cjs"))});
const {GitVault}=require(${JSON.stringify(path.join(moduleRoot, "git-vault.cjs"))});
const {GitTransaction}=require(${JSON.stringify(path.join(moduleRoot, "git-transaction.cjs"))});
const runner=new GitRunner({root:process.env.FIXTURE_ROOT,binaryPath:process.env.FIXTURE_GIT});
const vault=new GitVault({directory:process.env.FIXTURE_VAULT,key:Buffer.from(process.env.FIXTURE_KEY,'hex')});
const tx=new GitTransaction({runner,vault,directory:process.env.FIXTURE_JOURNAL});
tx.run({kind:'branch-switch',verify:()=> 'completed'},async()=>{await runner.run(['switch','other']);process.stdout.write('MUTATED\\n');await new Promise(()=>{});}).catch(e=>{process.stderr.write(e.code||'error');process.exit(1)});
setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ["-e", code], { env: { ...process.env, FIXTURE_ROOT: f.root, FIXTURE_GIT: binaryPath, FIXTURE_VAULT: f.vaultDirectory, FIXTURE_KEY: f.key.toString("hex"), FIXTURE_JOURNAL: f.directory }, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { try { child.kill("SIGKILL"); } catch {} });
  let output = "";
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Child transaction did not reach mutation")), 15000);
    child.stdout.on("data", (chunk) => { output += chunk; if (output.includes("MUTATED")) { clearTimeout(timer); resolve(); } });
    child.once("error", reject); child.once("exit", (code) => { if (!output.includes("MUTATED")) { clearTimeout(timer); reject(new Error(`Unexpected child exit ${code}`)); } });
  });
  const closed = once(child, "close"); child.kill("SIGKILL"); await closed;
  assert.equal(f.git("branch", "--show-current"), "other");
  const pending = await f.transaction.list(); assert.equal(pending[0].phase, "running"); assert.equal(pending[0].recoveryRequired, true);
  await fs.writeFile(path.join(f.root, "external.tex"), "keep external content");
  const recovery = await f.transaction.recover(pending[0].id);
  assert.equal(recovery.match, "different");
  assert.equal(recovery.transaction.phase, "recovery-required");
  assert.equal(f.git("branch", "--show-current"), "other");
  assert.equal(await fs.readFile(path.join(f.root, "external.tex"), "utf8"), "keep external content");
  const journal = await f.transaction.read(pending[0].id);
  assert.equal((await f.vault.read(journal.beforeVault)).metadata.git.branchRef, "refs/heads/main");
  assert.equal((await f.vault.read(journal.recoveryVault)).metadata.git.branchRef, "refs/heads/other");
});

test("external edits during verification are retained and cannot be reported as success", async (t) => {
  const f = await fixture(t);
  let transactionId;
  await assert.rejects(f.transaction.run({ kind: "branch-switch", verify: async () => {
    await fs.writeFile(path.join(f.root, "main.tex"), "external during verification");
    return "completed";
  } }, () => f.runner.run(["switch", "other"])), (error) => { transactionId = error.transactionId; return error.code === "GIT_RECOVERY_REQUIRED"; });
  assert.equal(await fs.readFile(path.join(f.root, "main.tex"), "utf8"), "external during verification");
  const journal = await f.transaction.read(transactionId);
  assert.equal(journal.errorCode, "STATE_CHANGED");
  const protectedCurrent = await f.vault.read(journal.recoveryVault);
  assert.equal(protectedCurrent.entries.find((entry) => entry.path === "main.tex").content.toString(), "external during verification");
});

test("a verified merge conflict is recorded as conflict instead of successful completion", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, "main.tex"), "conflicting main content"); f.git("commit", "-am", "main change");
  const result = await f.transaction.run({ kind: "merge", verify: ({ after, result }) => result.code === 1 && after.operation === "merge" ? "conflict" : false }, () => f.runner.run(["merge", "other"], { allowFailure: true }));
  assert.equal(result.transaction.phase, "conflict");
  assert.equal(result.transaction.recoveryRequired, true);
  assert.deepEqual(result.changedPaths, ["main.tex"]);
  const journal = await f.transaction.read(result.transaction.id);
  assert.ok((await f.vault.read(journal.afterVault)).metadata.git.files.MERGE_HEAD);
  assert.match(await fs.readFile(path.join(f.root, "main.tex"), "utf8"), /<<<<<<< HEAD/);
});

test("CAS recovery reverses only owned branch changes and retains unrelated external files", async (t) => {
  const f = await fixture(t); let id;
  const indexBefore = await fs.readFile(path.join(f.root, ".git", "index"));
  await assert.rejects(f.transaction.run({ kind: "branch-switch", verify: () => false }, () => f.runner.run(["switch", "other"])), (error) => { id = error.transactionId; return error.code === "GIT_RECOVERY_REQUIRED"; });
  await fs.writeFile(path.join(f.root, "external.tex"), "unrelated external data");
  const plan = await f.transaction.planRecovery(id);
  assert.deepEqual(plan.blockedPaths, []); assert.equal(plan.blockedGit, false);
  const recovered = await f.transaction.applyRecovery(plan.planId);
  assert.equal(recovered.transaction.phase, "recovered");
  assert.equal(f.git("branch", "--show-current"), "main");
  assert.equal(await fs.readFile(path.join(f.root, "main.tex"), "utf8"), "main content");
  assert.equal(await fs.readFile(path.join(f.root, "external.tex"), "utf8"), "unrelated external data");
  assert.deepEqual(await fs.readFile(path.join(f.root, ".git", "index")), indexBefore);
});

test("recovery rejects an edited owned path and a plan changed after confirmation", async (t) => {
  const f = await fixture(t); let id;
  await assert.rejects(f.transaction.run({ kind: "branch-switch", verify: () => false }, () => f.runner.run(["switch", "other"])), (error) => { id = error.transactionId; return true; });
  let plan = await f.transaction.planRecovery(id);
  await fs.writeFile(path.join(f.root, "main.tex"), "external owned edit");
  await assert.rejects(f.transaction.applyRecovery(plan.planId), { code: "STATE_CHANGED" });
  plan = await f.transaction.planRecovery(id);
  assert.deepEqual(plan.blockedPaths, ["main.tex"]);
  assert.equal(plan.canApply, false);
  await assert.rejects(f.transaction.applyRecovery(plan.planId), { code: "GIT_RECOVERY_BLOCKED" });
  assert.equal(f.git("branch", "--show-current"), "other");
  assert.equal(await fs.readFile(path.join(f.root, "main.tex"), "utf8"), "external owned edit");
});

test("shelve and unshelve preserve partial staging, untracked files, and unrelated edits", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, "main.tex"), "staged content"); f.git("add", "main.tex");
  const stagedOid = f.git("rev-parse", ":main.tex");
  await fs.writeFile(path.join(f.root, "main.tex"), "unstaged content");
  await fs.writeFile(path.join(f.root, "new.tex"), "new file");
  await fs.writeFile(path.join(f.root, "unselected.tex"), "keep me");
  const indexBefore = await fs.readFile(path.join(f.root, ".git", "index"));
  const saved = await f.transaction.shelve({ paths: ["main.tex", "new.tex"] });
  assert.equal(saved.transaction.phase, "shelved");
  assert.equal(await fs.readFile(path.join(f.root, "main.tex"), "utf8"), "main content");
  await assert.rejects(fs.stat(path.join(f.root, "new.tex")), { code: "ENOENT" });
  assert.equal(await fs.readFile(path.join(f.root, "unselected.tex"), "utf8"), "keep me");
  assert.notEqual(f.git("rev-parse", ":main.tex"), stagedOid);
  // Delete the now-unreferenced staged loose object to prove blob protection,
  // rather than relying on the repository's normal garbage-collection grace.
  await fs.unlink(path.join(f.root, ".git", "objects", stagedOid.slice(0, 2), stagedOid.slice(2)));
  const restored = await f.transaction.unshelve(saved.transaction.id);
  assert.equal(restored.transaction.phase, "completed");
  assert.equal((await f.transaction.read(saved.transaction.id)).phase, "unshelved");
  assert.equal(await fs.readFile(path.join(f.root, "main.tex"), "utf8"), "unstaged content");
  assert.equal(await fs.readFile(path.join(f.root, "new.tex"), "utf8"), "new file");
  assert.equal(f.git("show", ":main.tex"), "staged content");
  assert.deepEqual(await fs.readFile(path.join(f.root, ".git", "index")), indexBefore);
});

test("ignored shelving is explicit and unshelve refuses another branch or changed target", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, ".gitignore"), ".env\n");
  await fs.writeFile(path.join(f.root, ".env"), "secret value");
  await assert.rejects(f.transaction.shelve({ paths: [".env"] }), { code: "GIT_IGNORED_SELECTION" });
  const saved = await f.transaction.shelve({ paths: [".env"], ignoredPaths: [".env"] });
  await assert.rejects(fs.stat(path.join(f.root, ".env")), { code: "ENOENT" });
  f.git("switch", "other");
  await assert.rejects(f.transaction.unshelve(saved.transaction.id), { code: "GIT_SHELVE_BASE_CHANGED" });
  f.git("switch", "main");
  await fs.writeFile(path.join(f.root, ".env"), "external secret");
  // Branch switching may also rewrite index stat data; either guard is safe.
  await assert.rejects(f.transaction.unshelve(saved.transaction.id), (error) => ["GIT_SHELVE_FILES_CHANGED", "GIT_SHELVE_INDEX_CHANGED"].includes(error.code));
  assert.equal(await fs.readFile(path.join(f.root, ".env"), "utf8"), "external secret");
});

test("merge conflict can continue via explicit resume id and finish without freeing unrelated recovery", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, "main.tex"), "conflicting main content"); f.git("commit", "-am", "main change");
  const merge = await f.transaction.run({ kind: "merge", verify: ({ after }) => after.operation === "merge" ? "conflict" : false }, () => f.runner.run(["merge", "other"], { allowFailure: true }));
  await fs.writeFile(path.join(f.root, "main.tex"), "resolved content");
  const resolved = await f.transaction.run({ kind: "resolve-stage", resumeId: merge.transaction.id, verify: ({ after }) => after.operation === "merge" ? "conflict" : false }, () => f.runner.run(["add", "main.tex"]));
  assert.equal(resolved.transaction.phase, "completed");
  assert.equal((await f.transaction.read(merge.transaction.id)).phase, "conflict");
  const finished = await f.transaction.run({ kind: "merge-finish", resumeId: merge.transaction.id, verify: ({ after }) => after.operation === "idle" ? "completed" : false }, () => f.runner.run(["commit", "-m", "resolved merge"]));
  assert.equal(finished.transaction.phase, "completed");
  assert.equal((await f.transaction.read(merge.transaction.id)).phase, "completed");
  assert.equal(f.git("rev-list", "--parents", "-n", "1", "HEAD").split(" ").length, 3);
});

test("merge abort preserves intermediate resolution in protection and completes its conflict journal", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, "main.tex"), "conflicting main content"); f.git("commit", "-am", "main change");
  const baselineHead = f.git("rev-parse", "HEAD");
  const merge = await f.transaction.run({ kind: "merge", verify: ({ after }) => after.operation === "merge" ? "conflict" : false }, () => f.runner.run(["merge", "other"], { allowFailure: true }));
  await fs.writeFile(path.join(f.root, "main.tex"), "intermediate resolution to retain");
  const aborted = await f.transaction.run({ kind: "merge-abort", resumeId: merge.transaction.id, verify: ({ after }) => after.operation === "idle" && after.head === baselineHead ? "completed" : false }, () => f.runner.run(["merge", "--abort"]));
  assert.equal((await f.transaction.read(merge.transaction.id)).phase, "completed");
  assert.equal(await fs.readFile(path.join(f.root, "main.tex"), "utf8"), "conflicting main content");
  const protectedBeforeAbort = await f.vault.read((await f.transaction.read(aborted.transaction.id)).beforeVault);
  assert.equal(protectedBeforeAbort.entries.find((entry) => entry.path === "main.tex").content.toString(), "intermediate resolution to retain");
});

test("non-clobber recovery retains an external file created in the replacement gap", async (t) => {
  const f = await fixture(t); let id;
  await assert.rejects(f.transaction.run({ kind: "branch-switch", verify: () => false }, () => f.runner.run(["switch", "other"])), (error) => { id = error.transactionId; return true; });
  const plan = await f.transaction.planRecovery(id);
  const originalLink = fs.link;
  let injected = false;
  fs.link = async (source, destination) => {
    if (!injected && source.endsWith(".new") && destination === path.join(f.runner.root, "main.tex")) { injected = true; await fs.writeFile(destination, "external replacement gap", { flag: "wx" }); }
    return originalLink(source, destination);
  };
  t.after(() => { fs.link = originalLink; });
  await assert.rejects(f.transaction.applyRecovery(plan.planId), { code: "GIT_RECOVERY_REQUIRED" });
  fs.link = originalLink;
  assert.equal(injected, true);
  assert.equal(await fs.readFile(path.join(f.root, "main.tex"), "utf8"), "external replacement gap");
  const oldName = (await fs.readdir(f.root)).find((name) => name.endsWith(".old"));
  assert.ok(oldName);
  assert.equal(await fs.readFile(path.join(f.root, oldName), "utf8"), "other content");
  const journal = await f.transaction.read(id);
  const saved = await f.vault.read(journal.recoveryVault);
  assert.equal(saved.entries.find((entry) => entry.path === "main.tex").content.toString(), "external replacement gap");
});

test("CAS recovery restores a moved branch ref after a fast-forward merge", async (t) => {
  const f = await fixture(t); let id;
  const previous = f.git("rev-parse", "HEAD");
  await assert.rejects(f.transaction.run({ kind: "merge", verify: () => false }, () => f.runner.run(["merge", "--ff-only", "other"])), (error) => { id = error.transactionId; return true; });
  assert.notEqual(f.git("rev-parse", "HEAD"), previous);
  // An unrelated new ref belongs to the external operation, not our recovery.
  f.git("branch", "external-branch");
  const externalRef = f.git("rev-parse", "refs/heads/external-branch");
  const plan = await f.transaction.planRecovery(id);
  assert.equal(plan.blockedGit, false);
  const result = await f.transaction.applyRecovery(plan.planId);
  assert.equal(result.transaction.phase, "recovered");
  assert.equal(f.git("rev-parse", "HEAD"), previous);
  assert.equal(f.git("rev-parse", "refs/heads/external-branch"), externalRef);
  assert.equal(await fs.readFile(path.join(f.root, "main.tex"), "utf8"), "main content");
});

test("shelving preview names exact changes and refuses a stale reviewed plan", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, "main.tex"), "staged content"); f.git("add", "main.tex");
  await fs.writeFile(path.join(f.root, "main.tex"), "main content");
  await fs.writeFile(path.join(f.root, "new.tex"), "new file");
  const plan = await f.transaction.planShelve({ paths: ["main.tex", "new.tex"] });
  assert.deepEqual(plan.changes.map(({ path, action }) => ({ path, action })), [{ path: "main.tex", action: "unstage" }, { path: "new.tex", action: "delete" }]);
  assert.equal(plan.base.branch, "main");
  await fs.writeFile(path.join(f.root, "new.tex"), "external newer file");
  await assert.rejects(f.transaction.shelve({ planId: plan.planId }), { code: "STATE_CHANGED" });
  const refreshed = await f.transaction.planShelve({ paths: ["main.tex", "new.tex"] });
  const result = await f.transaction.shelve({ planId: refreshed.planId });
  assert.equal(result.transaction.phase, "shelved");
  assert.equal(result.transaction.base.branch, "main");
  assert.deepEqual(result.transaction.paths, ["main.tex", "new.tex"]);
  assert.equal(f.git("show", ":main.tex"), "main content");
  await assert.rejects(fs.stat(path.join(f.root, "new.tex")), { code: "ENOENT" });
});

test("unknown recovery exposes metadata-only file choices and explicit non-clobber export", async (t) => {
  const f = await fixture(t); let id;
  await fs.writeFile(path.join(f.root, ".env"), "exported_secret_sentinel");
  await assert.rejects(f.transaction.run({ kind: "branch-switch", verify: () => "completed" }, async () => { await f.runner.run(["switch", "other"]); throw new Error("simulated interruption"); }), (error) => { id = error.transactionId; return true; });
  const plan = await f.transaction.planRecovery(id);
  assert.equal(plan.requiresManualReview, true); assert.equal(plan.canApply, false);
  await assert.rejects(f.transaction.applyRecovery(plan.planId), { code: "GIT_RECOVERY_BLOCKED" });
  const files = await f.transaction.recoveryFiles(id);
  assert.equal(JSON.stringify(files).includes("exported_secret_sentinel"), false);
  assert.deepEqual(files.find((entry) => entry.path === ".env").before, { type: "file", size: 24, exportable: true });
  const destination = path.join(f.base, "exported.env");
  const exported = await f.transaction.exportRecoveryFile(id, { path: ".env", side: "before", destination });
  assert.deepEqual(exported, { exported: true, type: "file", size: 24 });
  assert.equal(await fs.readFile(destination, "utf8"), "exported_secret_sentinel");
  assert.equal((await fs.stat(destination)).mode & 0o777, 0o600);
  await assert.rejects(f.transaction.exportRecoveryFile(id, { path: ".env", side: "before", destination }), { code: "EEXIST" });
  await assert.rejects(f.transaction.exportRecoveryFile(id, { path: ".env", side: "before", destination: path.join(f.root, "export.env") }), { code: "GIT_EXPORT_INVALID" });
});

test("an interrupted transaction still exactly at its before state can be acknowledged as recovered", async (t) => {
  const f = await fixture(t); let id;
  await assert.rejects(f.transaction.run({ kind: "branch-switch", verify: () => "completed" }, () => { throw new Error("never mutated"); }), (error) => { id = error.transactionId; return true; });
  const plan = await f.transaction.planRecovery(id);
  assert.equal(plan.requiresManualReview, false); assert.equal(plan.canApply, true);
  const result = await f.transaction.applyRecovery(plan.planId);
  assert.equal(result.transaction.phase, "recovered");
  assert.equal(f.git("branch", "--show-current"), "main");
});
