/**
 * Source control (issue #38). The parser is covered directly because
 * `git status --porcelain=v2` shapes are easy to get subtly wrong, and the
 * service is exercised against a real throwaway repository — the point of this
 * feature is that it drives the user's own git, so a mock would prove nothing.
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { GitService, parseStatus } = require("../electron/services/git.cjs");

const makeRepo = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-git-"));
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  fs.writeFileSync(path.join(root, "main.tex"), "one\n");
  git("add", "-A");
  git("commit", "-qm", "initial");
  return { root, git };
};

test("porcelain v2 output is split into staged, unstaged and untracked", () => {
  const raw = [
    "# branch.head main",
    "# branch.upstream origin/main",
    "# branch.ab +2 -1",
    "1 M. N... 100644 100644 100644 aaa bbb staged.tex",
    "1 .M N... 100644 100644 100644 aaa bbb work.tex",
    "1 MM N... 100644 100644 100644 aaa bbb both.tex",
    "? new.tex",
  ].join("\0");
  const parsed = parseStatus(raw);
  assert.equal(parsed.branch, "main");
  assert.equal(parsed.upstream, "origin/main");
  assert.equal(parsed.ahead, 2);
  assert.equal(parsed.behind, 1);
  assert.deepEqual(parsed.staged.map((entry) => entry.path), ["staged.tex", "both.tex"]);
  assert.deepEqual(parsed.unstaged.map((entry) => entry.path), ["work.tex", "both.tex"]);
  assert.deepEqual(parsed.untracked.map((entry) => entry.path), ["new.tex"]);
});

test("a rename keeps both paths and does not leak the original into the list", () => {
  const raw = ["# branch.head main", "2 R. N... 100644 100644 100644 aaa bbb R100 new.tex", "old.tex"].join(
    "\0"
  );
  const parsed = parseStatus(raw);
  assert.equal(parsed.staged.length, 1);
  assert.equal(parsed.staged[0].path, "new.tex");
  assert.equal(parsed.staged[0].originalPath, "old.tex");
});

test("a folder that is not a repository reports isRepo false", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-nogit-"));
  const service = new GitService({ getRootPath: () => root });
  const status = await service.status();
  assert.equal(status.ok, true);
  assert.equal(status.isRepo, false);
});

test("stage, commit and status follow the working tree", async () => {
  const { root } = makeRepo();
  const service = new GitService({ getRootPath: () => root });

  let status = await service.status();
  assert.equal(status.isRepo, true);
  assert.equal(status.branch, "main");
  assert.equal(status.staged.length + status.unstaged.length + status.untracked.length, 0);

  fs.writeFileSync(path.join(root, "main.tex"), "two\n");
  fs.writeFileSync(path.join(root, "extra.tex"), "new\n");
  status = await service.status();
  assert.deepEqual(status.unstaged.map((entry) => entry.path), ["main.tex"]);
  assert.deepEqual(status.untracked.map((entry) => entry.path), ["extra.tex"]);

  assert.equal((await service.stage(["main.tex"])).ok, true);
  status = await service.status();
  assert.deepEqual(status.staged.map((entry) => entry.path), ["main.tex"]);

  assert.equal((await service.commit("second")).ok, true);
  status = await service.status();
  assert.equal(status.staged.length, 0);
  assert.match(status.lastCommit, /second$/);
});

test("a diff returns both sides as text", async () => {
  const { root } = makeRepo();
  const service = new GitService({ getRootPath: () => root });
  fs.writeFileSync(path.join(root, "main.tex"), "two\n");
  const diff = await service.diff("main.tex", { staged: false });
  assert.equal(diff.ok, true);
  assert.equal(diff.original, "one\n");
  assert.equal(diff.modified, "two\n");
});

test("discard restores a tracked file and removes an untracked one", async () => {
  const { root } = makeRepo();
  const service = new GitService({ getRootPath: () => root });
  fs.writeFileSync(path.join(root, "main.tex"), "wrecked\n");
  fs.writeFileSync(path.join(root, "junk.tex"), "junk\n");
  await service.discard(["main.tex", "junk.tex"]);
  assert.equal(fs.readFileSync(path.join(root, "main.tex"), "utf8"), "one\n");
  assert.equal(fs.existsSync(path.join(root, "junk.tex")), false);
});

test("paths outside the workspace never reach git", async () => {
  const { root } = makeRepo();
  const service = new GitService({ getRootPath: () => root });
  const result = await service.stage(["../escape.tex"]);
  assert.equal(result.ok, false);
});

test("a branch name git would reject is refused before it is run", async () => {
  const { root } = makeRepo();
  const service = new GitService({ getRootPath: () => root });
  for (const bad of ["--force", "a b", "", "a;rm -rf /"]) {
    const result = await service.checkout(bad);
    assert.equal(result.ok, false, bad);
  }
  assert.equal((await service.checkout("feature/x", { create: true })).ok, true);
  assert.equal((await service.status()).branch, "feature/x");
});

test("committing with nothing staged says so instead of failing silently", async () => {
  const { root } = makeRepo();
  const service = new GitService({ getRootPath: () => root });
  const result = await service.commit("empty");
  assert.equal(result.ok, false);
  assert.match(result.error, /staged/i);
});
