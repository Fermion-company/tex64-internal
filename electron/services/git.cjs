"use strict";

const { execFile } = require("child_process");
const fsp = require("fs/promises");
const path = require("path");

// Source control for the open workspace, driven by the `git` binary already on
// the machine (issue #38: "I want GitHub integration"). Authentication is left
// entirely to the user's existing git credential setup — TeX64 stores no tokens
// and never talks to the GitHub API, so `push` behaves exactly as it does in
// their terminal.

const GIT_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 32 * 1024 * 1024;

// Long-running network commands deserve more room than a local status query.
const NETWORK_TIMEOUT_MS = 180_000;

const run = (rootPath, args, { timeoutMs = GIT_TIMEOUT_MS, encoding = "utf8" } = {}) =>
  new Promise((resolve) => {
    execFile(
      "git",
      args,
      {
        cwd: rootPath,
        timeout: timeoutMs,
        maxBuffer: MAX_BUFFER,
        encoding,
        // Never let git try to open an editor or an interactive credential
        // prompt: there is no terminal attached, so it would hang forever.
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_EDITOR: "true",
          GIT_PAGER: "cat",
          LC_ALL: "C",
        },
      },
      (error, stdout, stderr) => {
        if (error) {
          const message =
            (typeof stderr === "string" && stderr.trim()) ||
            (error.message ? error.message.trim() : "git failed");
          resolve({ ok: false, error: message, stdout, stderr });
          return;
        }
        resolve({ ok: true, stdout, stderr });
      }
    );
  });

// porcelain v2 XY codes: index status then worktree status.
const describeCode = (code) => {
  switch (code) {
    case "M":
      return "modified";
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "T":
      return "typechange";
    default:
      return null;
  }
};

// `git status --porcelain=v2 --branch -z`: NUL-separated records, with renames
// carrying a second NUL-separated path. Parsed by hand because the shapes are
// few and a dependency for this would be silly.
const parseStatus = (raw) => {
  const result = {
    branch: "",
    upstream: "",
    ahead: 0,
    behind: 0,
    detached: false,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
  };
  const tokens = String(raw ?? "").split("\0");
  for (let i = 0; i < tokens.length; i += 1) {
    const line = tokens[i];
    if (!line) {
      continue;
    }
    if (line.startsWith("# branch.head ")) {
      const value = line.slice("# branch.head ".length).trim();
      result.detached = value === "(detached)";
      result.branch = value;
      continue;
    }
    if (line.startsWith("# branch.upstream ")) {
      result.upstream = line.slice("# branch.upstream ".length).trim();
      continue;
    }
    if (line.startsWith("# branch.ab ")) {
      const match = line.match(/\+(\d+)\s+-(\d+)/);
      if (match) {
        result.ahead = Number(match[1]);
        result.behind = Number(match[2]);
      }
      continue;
    }
    if (line.startsWith("#")) {
      continue;
    }
    const kind = line[0];
    if (kind === "?") {
      result.untracked.push({ path: line.slice(2), status: "untracked" });
      continue;
    }
    if (kind === "u") {
      const parts = line.split(" ");
      result.conflicted.push({ path: parts.slice(10).join(" "), status: "conflicted" });
      continue;
    }
    if (kind !== "1" && kind !== "2") {
      continue;
    }
    const parts = line.split(" ");
    const xy = parts[1] ?? "..";
    let filePath = parts.slice(kind === "1" ? 8 : 9).join(" ");
    let originalPath = "";
    if (kind === "2") {
      // A rename record is followed by its original path in the next token.
      originalPath = tokens[i + 1] ?? "";
      i += 1;
    }
    const indexStatus = describeCode(xy[0]);
    const workStatus = describeCode(xy[1]);
    if (indexStatus) {
      result.staged.push({ path: filePath, status: indexStatus, originalPath });
    }
    if (workStatus) {
      result.unstaged.push({ path: filePath, status: workStatus, originalPath });
    }
  }
  return result;
};

class GitService {
  constructor({ getRootPath } = {}) {
    this.getRootPath = typeof getRootPath === "function" ? getRootPath : () => null;
  }

  #root() {
    const rootPath = this.getRootPath();
    if (!rootPath) {
      throw new Error("No workspace is selected.");
    }
    return rootPath;
  }

  // Paths always come from the renderer's own status listing, but they are
  // still confined to the workspace before reaching git.
  #safePaths(rootPath, paths) {
    if (!Array.isArray(paths)) {
      return [];
    }
    const resolvedRoot = path.resolve(rootPath);
    const safe = [];
    for (const value of paths) {
      if (typeof value !== "string" || !value.trim()) {
        continue;
      }
      const absolute = path.resolve(resolvedRoot, value);
      if (absolute !== resolvedRoot && !absolute.startsWith(resolvedRoot + path.sep)) {
        continue;
      }
      safe.push(value);
    }
    return safe;
  }

  async status() {
    let rootPath;
    try {
      rootPath = this.#root();
    } catch (error) {
      return { ok: false, error: error.message, isRepo: false };
    }
    const inside = await run(rootPath, ["rev-parse", "--is-inside-work-tree"]);
    if (!inside.ok || String(inside.stdout).trim() !== "true") {
      return { ok: true, isRepo: false, gitAvailable: !/not found|ENOENT/i.test(inside.error ?? "") };
    }
    const [statusResult, remoteResult, headResult] = await Promise.all([
      run(rootPath, ["status", "--porcelain=v2", "--branch", "-z"]),
      run(rootPath, ["remote", "get-url", "origin"]),
      run(rootPath, ["log", "-1", "--pretty=%h %s"]),
    ]);
    if (!statusResult.ok) {
      return { ok: false, isRepo: true, error: statusResult.error };
    }
    const parsed = parseStatus(statusResult.stdout);
    return {
      ok: true,
      isRepo: true,
      ...parsed,
      remoteUrl: remoteResult.ok ? String(remoteResult.stdout).trim() : "",
      lastCommit: headResult.ok ? String(headResult.stdout).trim() : "",
    };
  }

  async branches() {
    const rootPath = this.#root();
    const result = await run(rootPath, [
      "for-each-ref",
      "--format=%(refname:short)",
      "refs/heads",
    ]);
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    const branches = String(result.stdout)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    return { ok: true, branches };
  }

  // Both sides of a change as plain text, so the renderer can show it in the
  // same Monaco diff editor the AI proposals use.
  async diff(relativePath, { staged = false } = {}) {
    const rootPath = this.#root();
    const [safePath] = this.#safePaths(rootPath, [relativePath]);
    if (!safePath) {
      return { ok: false, error: "Invalid path." };
    }
    const baseRef = staged ? "HEAD" : ":0";
    const base = await run(rootPath, ["show", `${baseRef}:${safePath}`]);
    let modified = "";
    if (staged) {
      const stagedContent = await run(rootPath, ["show", `:0:${safePath}`]);
      modified = stagedContent.ok ? stagedContent.stdout : "";
    } else {
      modified = await fsp
        .readFile(path.resolve(rootPath, safePath), "utf8")
        .catch(() => "");
    }
    return {
      ok: true,
      path: safePath,
      staged,
      // A file that is new on this side has no base; an empty original is the
      // honest representation of that.
      original: base.ok ? base.stdout : "",
      modified,
    };
  }

  async stage(paths) {
    const rootPath = this.#root();
    const safe = this.#safePaths(rootPath, paths);
    if (safe.length === 0) {
      return { ok: false, error: "Nothing to stage." };
    }
    return run(rootPath, ["add", "--", ...safe]);
  }

  async stageAll() {
    return run(this.#root(), ["add", "-A"]);
  }

  async unstage(paths) {
    const rootPath = this.#root();
    const safe = this.#safePaths(rootPath, paths);
    if (safe.length === 0) {
      return { ok: false, error: "Nothing to unstage." };
    }
    return run(rootPath, ["restore", "--staged", "--", ...safe]);
  }

  // Throws away edits, so it is only ever reached from an explicit confirmation
  // in the renderer.
  async discard(paths) {
    const rootPath = this.#root();
    const safe = this.#safePaths(rootPath, paths);
    if (safe.length === 0) {
      return { ok: false, error: "Nothing to discard." };
    }
    const tracked = [];
    for (const value of safe) {
      const known = await run(rootPath, ["ls-files", "--error-unmatch", "--", value]);
      if (known.ok) {
        tracked.push(value);
      } else {
        await fsp.rm(path.resolve(rootPath, value), { force: true, recursive: true }).catch(() => {});
      }
    }
    if (tracked.length === 0) {
      return { ok: true };
    }
    return run(rootPath, ["restore", "--worktree", "--staged", "--", ...tracked]);
  }

  async commit(message, { amend = false } = {}) {
    const rootPath = this.#root();
    const text = typeof message === "string" ? message.trim() : "";
    if (!text && !amend) {
      return { ok: false, error: "A commit message is required." };
    }
    const args = ["commit"];
    if (amend) {
      args.push("--amend");
    }
    args.push("-m", text || "amend");
    const result = await run(rootPath, args);
    if (!result.ok && /nothing to commit/i.test(`${result.error}${result.stdout ?? ""}`)) {
      return { ok: false, error: "Nothing is staged." };
    }
    return result;
  }

  async fetch() {
    return run(this.#root(), ["fetch", "--all", "--prune"], { timeoutMs: NETWORK_TIMEOUT_MS });
  }

  async pull() {
    return run(this.#root(), ["pull", "--ff-only"], { timeoutMs: NETWORK_TIMEOUT_MS });
  }

  async push({ setUpstream = false, branch = "" } = {}) {
    const rootPath = this.#root();
    const args = ["push"];
    if (setUpstream && branch) {
      args.push("--set-upstream", "origin", branch);
    }
    return run(rootPath, args, { timeoutMs: NETWORK_TIMEOUT_MS });
  }

  async checkout(branch, { create = false } = {}) {
    const rootPath = this.#root();
    const name = typeof branch === "string" ? branch.trim() : "";
    // Refuse anything git itself would reject as a ref, before it reaches the
    // command line.
    if (!name || !/^[\w./-]+$/.test(name) || name.startsWith("-")) {
      return { ok: false, error: "Invalid branch name." };
    }
    const args = create ? ["switch", "--create", name] : ["switch", name];
    return run(rootPath, args);
  }

  async init() {
    const rootPath = this.#root();
    return run(rootPath, ["init"]);
  }
}

module.exports = { GitService, parseStatus };
