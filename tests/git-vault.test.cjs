"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { GitVault } = require("../electron/services/git-vault.cjs");

async function fixture(t, options = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-git-vault-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, "project");
  const directory = path.join(base, "protected");
  await fs.mkdir(root);
  await fs.mkdir(path.join(root, ".git"));
  await fs.writeFile(path.join(root, ".git", "config"), "git metadata must be handled separately");
  await fs.writeFile(path.join(root, "main.tex"), "first version");
  const key = crypto.randomBytes(32);
  return { base, root, directory, key, vault: new GitVault({ directory, key, ...options }) };
}

test("AES-GCM protects secrets, ignored/generated files, modes, links and Buffer metadata durably", async (t) => {
  const f = await fixture(t);
  const secret = "SENTINEL_SECRET_credential_982738423";
  await fs.writeFile(path.join(f.root, ".env"), secret, { mode: 0o600 });
  await fs.writeFile(path.join(f.root, ".gitignore"), ".env\noutput.log\n");
  await fs.writeFile(path.join(f.root, "output.log"), "generated");
  await fs.mkdir(path.join(f.root, "empty"));
  await fs.symlink("main.tex", path.join(f.root, "linked.tex"));
  await fs.symlink("future.tex", path.join(f.root, "dangling.tex"));
  const metadata = { index: Buffer.from([0, 255, 5]), head: "refs/heads/main", secret };
  const { id, manifest } = await f.vault.capture({ root: f.root, metadata });
  assert.equal(manifest.entries.some((entry) => entry.path.startsWith(".git/")), false);
  assert.equal(manifest.entries.find((entry) => entry.path === ".env").mode, 0o600);
  const encrypted = await fs.readFile(f.vault.file(id));
  for (const clear of [secret, "first version", "main.tex", "refs/heads/main"]) assert.equal(encrypted.includes(Buffer.from(clear)), false);
  assert.equal((await fs.stat(f.vault.file(id))).mode & 0o777, 0o600);
  assert.equal((await fs.stat(f.directory)).mode & 0o777, 0o777 & 0o700);
  assert.deepEqual(await fs.readdir(f.directory), [`${id}.vault`]);
  const restarted = new GitVault({ directory: f.directory, key: f.key });
  const saved = await restarted.read(id);
  assert.deepEqual(saved.metadata, metadata);
  assert.equal(saved.entries.find((entry) => entry.path === ".env").content.toString(), secret);
  assert.equal(saved.entries.find((entry) => entry.path === "output.log").content.toString(), "generated");
  assert.deepEqual(saved.entries.find((entry) => entry.path === "linked.tex"), { path: "linked.tex", mode: (await fs.lstat(path.join(f.root, "linked.tex"))).mode & 0o777, type: "symlink", target: "main.tex" });
  assert.equal(saved.entries.find((entry) => entry.path === "dangling.tex").target, "future.tex");
  assert.equal(saved.entries.find((entry) => entry.path === "empty").type, "directory");
});

test("wrong keys, ciphertext modification and swapping record names are rejected", async (t) => {
  const f = await fixture(t);
  const { id } = await f.vault.capture({ root: f.root });
  const wrong = new GitVault({ directory: f.directory, key: crypto.randomBytes(32) });
  await assert.rejects(wrong.read(id), { code: "VAULT_AUTH" });
  const copyId = crypto.randomBytes(16).toString("hex");
  await fs.copyFile(f.vault.file(id), f.vault.file(copyId));
  await assert.rejects(f.vault.read(copyId), { code: "VAULT_AUTH" });
  const bytes = await fs.readFile(f.vault.file(id)); bytes[bytes.length - 1] ^= 1;
  await fs.writeFile(f.vault.file(id), bytes);
  await assert.rejects(f.vault.read(id), { code: "VAULT_AUTH" });
  await assert.rejects(f.vault.read("../outside"), { code: "VAULT_ID" });
});

test("capacity and unreadable-file failures leave workspace and existing records untouched", async (t) => {
  const f = await fixture(t, { maxCaptureBytes: 16 });
  const { id } = await f.vault.capture({ root: f.root });
  const oldBytes = await fs.readFile(f.vault.file(id));
  await fs.writeFile(path.join(f.root, "large.bin"), Buffer.alloc(17, 1));
  await assert.rejects(f.vault.capture({ root: f.root }), { code: "VAULT_LIMIT" });
  assert.deepEqual(await fs.readdir(f.directory), [`${id}.vault`]);
  assert.deepEqual(await fs.readFile(f.vault.file(id)), oldBytes);
  assert.deepEqual(await fs.readFile(path.join(f.root, "large.bin")), Buffer.alloc(17, 1));
  await fs.unlink(path.join(f.root, "large.bin"));
  f.vault.maxBytes = await f.vault.usage();
  await assert.rejects(f.vault.capture({ root: f.root }), { code: "VAULT_FULL" });
  await fs.chmod(path.join(f.root, "main.tex"), 0o000);
  await assert.rejects(f.vault.capture({ root: f.root }), { code: "VAULT_UNREADABLE" });
  await fs.chmod(path.join(f.root, "main.tex"), 0o600);
  assert.equal(await fs.readFile(path.join(f.root, "main.tex"), "utf8"), "first version");
  await assert.rejects(f.vault.remove(id), { code: "VAULT_DELETE" });
  assert.deepEqual(await fs.readFile(f.vault.file(id)), oldBytes);
  await f.vault.remove(id, { explicit: true });
  assert.deepEqual(await fs.readdir(f.directory), []);
});

test("capture detects external changes between scans before publishing any protection record", async (t) => {
  const f = await fixture(t);
  const scan = f.vault.scan.bind(f.vault);
  let scans = 0;
  f.vault.scan = async (root) => { const result = await scan(root); if (++scans === 1) await fs.writeFile(path.join(root, "main.tex"), "external edit"); return result; };
  await assert.rejects(f.vault.capture({ root: f.root }), { code: "VAULT_CHANGED" });
  assert.deepEqual(await fs.readdir(f.directory), []);
  assert.equal(await fs.readFile(path.join(f.root, "main.tex"), "utf8"), "external edit");
});

test("restore plans are path-scoped, read-only, immutable and invalidated by any external change", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, "other.tex"), "untouched");
  const { id } = await f.vault.capture({ root: f.root });
  await fs.writeFile(path.join(f.root, "main.tex"), "second version");
  const plan = await f.vault.planRestore({ id, root: f.root, paths: ["main.tex"] });
  assert.equal(plan.changes.length, 1);
  const confirmed = await f.vault.confirmRestore(plan.planId);
  assert.equal(confirmed.changes[0].expected.content.toString(), "second version");
  assert.equal(confirmed.changes[0].desired.content.toString(), "first version");
  assert.equal(await fs.readFile(path.join(f.root, "main.tex"), "utf8"), "second version");
  confirmed.changes[0].desired.content.fill(0);
  assert.equal((await f.vault.confirmRestore(plan.planId)).changes[0].desired.content.toString(), "first version");
  await fs.writeFile(path.join(f.root, "other.tex"), "external other edit");
  await assert.rejects(f.vault.confirmRestore(plan.planId), { code: "VAULT_CHANGED" });
  assert.equal(await fs.readFile(path.join(f.root, "other.tex"), "utf8"), "external other edit");
  for (const paths of [[], ["../outside"], [".git/index"], ["a/../../b"], ["/absolute"], ["a\\b"]]) await assert.rejects(f.vault.planRestore({ id, root: f.root, paths }), { code: "VAULT_PATH" });
  const otherRoot = path.join(f.base, "other"); await fs.mkdir(otherRoot);
  await assert.rejects(f.vault.planRestore({ id, root: otherRoot, paths: ["main.tex"] }), { code: "VAULT_ROOT" });
  const next = await f.vault.planRestore({ id, root: f.root, paths: ["main.tex"] });
  await assert.rejects(f.vault.confirmRestore(plan.planId), { code: "VAULT_PLAN" });
  assert.equal((await f.vault.confirmRestore(next.planId)).changes.length, 1);
});

test("unsupported links, nested repositories and special files fail before touching workspace", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, "sub"));
  await fs.mkdir(path.join(f.root, "sub", ".git"));
  await assert.rejects(f.vault.capture({ root: f.root }), { code: "VAULT_STRUCTURE" });
  await fs.rmdir(path.join(f.root, "sub", ".git"));
  await fs.symlink("sub", path.join(f.root, "directory-link"));
  await assert.rejects(f.vault.capture({ root: f.root }), { code: "VAULT_STRUCTURE" });
  await fs.unlink(path.join(f.root, "directory-link"));
  await fs.symlink(f.base, path.join(f.root, "outside-link"));
  await assert.rejects(f.vault.capture({ root: f.root }), { code: "VAULT_STRUCTURE" });
  await fs.unlink(path.join(f.root, "outside-link"));
  const linkedRoot = path.join(f.base, "root-link"); await fs.symlink(f.root, linkedRoot);
  await assert.rejects(f.vault.capture({ root: linkedRoot }), { code: "VAULT_STRUCTURE" });
  if (process.platform !== "win32") {
    execFileSync("mkfifo", [path.join(f.root, "pipe")]);
    await assert.rejects(f.vault.capture({ root: f.root }), { code: "VAULT_STRUCTURE" });
    await fs.unlink(path.join(f.root, "pipe"));
  }
  assert.equal(await fs.readFile(path.join(f.root, "main.tex"), "utf8"), "first version");
  assert.deepEqual(await fs.readdir(f.directory), []);
});

test("storage inside the project and unavailable keys are rejected", async (t) => {
  const f = await fixture(t);
  assert.throws(() => new GitVault({ directory: f.directory, key: Buffer.alloc(31) }), { code: "VAULT_KEY" });
  const nested = new GitVault({ directory: path.join(f.root, "vault"), key: f.key });
  await assert.rejects(nested.capture({ root: f.root }), { code: "VAULT_PATH" });
  assert.equal(await fs.readFile(path.join(f.root, "main.tex"), "utf8"), "first version");
  await assert.rejects(fs.lstat(path.join(f.root, "vault")), { code: "ENOENT" });
});
