"use strict";
const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { redactGitOutput } = require("./git-runner.cjs");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const fail = (code, message) => Object.assign(new Error(message), { code });
const line = bytes => bytes.toString("utf8").replace(/\n$/, "");
const decode = bytes => { try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw fail("GIT_PATH_ENCODING", "A Git filename cannot be displayed safely."); } };

function validateGitHubUrl(input) {
  if (typeof input !== "string" || !input || input !== input.trim() || /[\s\\%?#\x00-\x1f\x7f]/.test(input)) throw fail("GIT_URL_INVALID", "Enter a GitHub repository URL.");
  let match; let transport;
  if ((match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/?$/.exec(input))) transport = "https";
  else if ((match = /^git@github\.com:([^/]+)\/([^/]+)\/?$/.exec(input))) transport = "ssh";
  else if ((match = /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+)\/?$/.exec(input))) transport = "ssh";
  else throw fail("GIT_URL_INVALID", "Use an HTTPS or SSH github.com repository URL without credentials or extra paths.");
  const owner = match[1], repo = match[2].replace(/\.git$/, "");
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner) || owner.includes("--") || !/^[A-Za-z0-9_.-]{1,100}$/.test(repo) || repo === "." || repo === ".." || repo.endsWith(".git")) throw fail("GIT_URL_INVALID", "Enter a valid GitHub owner and repository name.");
  return { owner, repo, transport, url: transport === "https" ? `https://github.com/${owner}/${repo}.git` : `git@github.com:${owner}/${repo}.git`, webUrl: `https://github.com/${owner}/${repo}` };
}

function parsePorcelainV2(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (bytes.length && bytes.at(-1) !== 0) throw fail("GIT_STATUS_INVALID", "Git status ended unexpectedly.");
  const tokens = decode(bytes).split("\0"); if (tokens.at(-1) === "") tokens.pop();
  const entries = [], branch = { oid: null, head: null, upstream: null, ahead: 0, behind: 0 };
  const fields = (text, count) => {
    const values = []; let offset = 0;
    for (let i = 0; i < count; i++) { const end = text.indexOf(" ", offset); if (end < 0) throw fail("GIT_STATUS_INVALID", "Malformed Git status."); values.push(text.slice(offset, end)); offset = end + 1; }
    return { values, name: text.slice(offset) };
  };
  for (let index = 0; index < tokens.length; index++) {
    const text = tokens[index];
    if (text.startsWith("# ")) {
      const space = text.indexOf(" ", 2); const key = text.slice(2, space); const value = text.slice(space + 1);
      if (key === "branch.oid") branch.oid = value === "(initial)" ? null : value;
      else if (key === "branch.head") branch.head = value === "(detached)" ? null : value;
      else if (key === "branch.upstream") branch.upstream = value;
      else if (key === "branch.ab") { const match = /^\+(\d+) -(\d+)$/.exec(value); if (match) { branch.ahead = Number(match[1]); branch.behind = Number(match[2]); } }
      continue;
    }
    if (text.startsWith("? ") || text.startsWith("! ")) {
      entries.push({ kind: text[0] === "?" ? "untracked" : "ignored", path: text.slice(2), originalPath: null, index: ".", worktree: text[0], staged: false, unstaged: text[0] === "?", partiallyStaged: false, unmerged: false }); continue;
    }
    const kind = text[0]; if (!["1", "2", "u"].includes(kind)) throw fail("GIT_STATUS_INVALID", "Unknown Git status record.");
    const { values, name } = fields(text, kind === "1" ? 8 : kind === "2" ? 9 : 10);
    const xy = values[1]; if (xy.length !== 2 || !name) throw fail("GIT_STATUS_INVALID", "Malformed Git status path.");
    const originalPath = kind === "2" ? tokens[++index] : null;
    if (kind === "2" && !originalPath) throw fail("GIT_STATUS_INVALID", "Git rename source is missing.");
    entries.push({ kind: kind === "u" ? "unmerged" : kind === "2" ? "rename" : "ordinary", path: name, originalPath, index: xy[0], worktree: xy[1], submodule: values[2], staged: kind !== "u" && xy[0] !== ".", unstaged: kind !== "u" && xy[1] !== ".", partiallyStaged: kind !== "u" && xy[0] !== "." && xy[1] !== ".", unmerged: kind === "u", score: kind === "2" ? values[8] : null });
  }
  return { branch, entries, clean: entries.every(item => item.kind === "ignored"), hasStaged: entries.some(item => item.staged), hasUnstaged: entries.some(item => item.unstaged), hasUnmerged: entries.some(item => item.unmerged), hasPartialStage: entries.some(item => item.partiallyStaged) };
}

const executableKey = key => /^(?:core\.(?:hookspath|fsmonitor|sshcommand|editor|pager)|credential(?:\..*)?\.helper|filter\..*\.(?:clean|smudge|process)|diff(?:\..*)?\.(?:command|textconv)|diff\.external|merge\..*\.driver|gpg(?:\..*)?\.program|sequence\.editor|pager\.|alias\.|url\..*\.(?:insteadof|pushinsteadof)|remote\..*\.(?:uploadpack|receivepack|vcs|proxy)|http(?:\..*)?\.extraheader)/i.test(key);
const configEntries = bytes => decode(bytes).split("\0").filter(Boolean).map(record => { const split = record.indexOf("\n"); return { key: (split < 0 ? record : record.slice(0, split)), value: split < 0 ? "" : record.slice(split + 1) }; });

// check-attr reads effective attributes (including global and info/attributes)
// without running clean/smudge/process commands. Never run status before this.
async function activeFilters(runner, { source = null, paths = null } = {}) {
  const read = (args, options = {}) => runner.run(args, { ...options, readOnly: true });
  const candidates = paths || decode((await read(source ? ["ls-tree", "-r", "--name-only", "-z", source] : ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])).stdout).split("\0").filter(Boolean);
  const unique = [...new Set(candidates)];
  if (!unique.length) return [];
  const result = await read(["check-attr", ...(source ? [`--source=${source}`] : []), "--all", "-z", "--stdin"], { input: Buffer.from(unique.join("\0") + "\0") });
  const fields = decode(result.stdout).split("\0"); fields.pop();
  if (fields.length % 3) throw fail("GIT_ATTRIBUTES_INVALID", "Cannot inspect file attributes safely.");
  const active = [];
  for (let i = 0; i < fields.length; i += 3) if (fields[i + 1] === "filter" && !["unset", "unspecified"].includes(fields[i + 2])) active.push({ path: fields[i], filter: fields[i + 2] });
  return active;
}

class GitState {
  constructor({ runner }) { this.runner = runner; }
  run(args, options = {}) { return this.runner.run(args, { ...options, readOnly: true }); }
  async read() {
    const detected = await this.run(["rev-parse", "--absolute-git-dir"], { allowFailure: true });
    if (detected.code !== 0) {
      if (/not a git repository/i.test(detected.stderr)) return { repository: false, root: this.runner.root, layout: "none", supported: true };
      throw fail("GIT_REPOSITORY_UNAVAILABLE", detected.stderr || "Cannot read this repository.");
    }
    const gitDir = line(detected.stdout);
    const bare = line((await this.run(["rev-parse", "--is-bare-repository"])).stdout) === "true";
    const commonDir = line((await this.run(["rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout);
    const root = bare ? null : line((await this.run(["rev-parse", "--show-toplevel"])).stdout);
    const superproject = bare ? "" : line((await this.run(["rev-parse", "--show-superproject-working-tree"])).stdout);
    let layout = bare ? "bare" : superproject ? "submodule" : gitDir !== commonDir ? "linked-worktree" : root !== this.runner.root ? "nested-folder" : "standard";
    if (layout === "standard" && path.resolve(gitDir) !== path.join(root, ".git")) layout = "separate-git-dir";
    const rawConfig = (await this.runner.run(["config", "--null", "--list", "--includes"])).stdout;
    const config = configEntries(rawConfig);
    const executableConfig = config.filter(item => executableKey(item.key) && item.value && !(/^core\.fsmonitor$/i.test(item.key) && /^(false|0|no|off)$/i.test(item.value))).map(item => ({ key: redactGitOutput(item.key), category: /^filter\./i.test(item.key) ? "filter" : /^credential/i.test(item.key) ? "credential" : /^url\./i.test(item.key) ? "url-rewrite" : "executable" }));
    if (layout === "standard" && config.some(item => /^core\.sparsecheckout$/i.test(item.key) && /^(true|1|yes|on)$/i.test(item.value))) layout = "sparse-checkout";
    const filteredPaths = bare ? [] : await activeFilters(this.runner);
    const hasFilter = filteredPaths.length > 0;
    const status = bare || hasFilter ? null : parsePorcelainV2((await this.run(["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all", "--ignore-submodules=all"])).stdout);
    const headResult = await this.run(["rev-parse", "--verify", "HEAD"], { allowFailure: true });
    const symbolic = await this.run(["symbolic-ref", "--quiet", "HEAD"], { allowFailure: true });
    const head = headResult.code === 0 ? line(headResult.stdout) : null;
    const branchRef = symbolic.code === 0 ? line(symbolic.stdout) : null;
    const refsResult = await this.run(["for-each-ref", "--format=%(refname)%00%(objectname)%00%(upstream)%00", "refs/heads", "refs/remotes", "refs/tags"]);
    const refs = decode(refsResult.stdout).split("\n").filter(Boolean).map(record => { const [name, oid, upstream] = record.split("\0"); return { name, oid, upstream: upstream || null }; });
    let indexFingerprint = null;
    let indexHandle;
    try {
      indexHandle = await fs.open(path.join(gitDir, "index"), constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const before = await indexHandle.stat();
      if (!before.isFile() || before.size > 64 * 1024 * 1024) throw fail("GIT_INDEX_UNSUPPORTED", "Git index cannot be inspected safely.");
      const index = await indexHandle.readFile();
      const after = await indexHandle.stat();
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw fail("STATE_CHANGED", "Git index changed while being read.");
      indexFingerprint = hash(index);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    finally { await indexHandle?.close(); }
    const operationMarkers = [];
    for (const name of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer", "BISECT_LOG", "index.lock"]) {
      try { await fs.lstat(path.join(gitDir, name)); operationMarkers.push(name); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    const operation = operationMarkers.includes("MERGE_HEAD") ? "merge" : operationMarkers.some(item => item.startsWith("rebase-")) ? "rebase" : operationMarkers.includes("CHERRY_PICK_HEAD") ? "cherry-pick" : operationMarkers.includes("REVERT_HEAD") ? "revert" : operationMarkers.includes("BISECT_LOG") ? "bisect" : operationMarkers.includes("sequencer") ? "sequencer" : operationMarkers.includes("index.lock") ? "locked" : "idle";
    const remotes = [];
    for (const item of config) {
      const match = /^remote\.(.+)\.(url|pushurl)$/i.exec(item.key); if (!match) continue;
      let validated = null; try { validated = validateGitHubUrl(item.value); } catch {}
      remotes.push({ name: match[1], kind: match[2], url: validated ? item.value : "[unsupported URL]", validated: Boolean(validated), transport: validated?.transport || null });
    }
    this.runner.assertRoot();
    const stat = await fs.stat(gitDir);
    const repositoryId = hash(`${gitDir}\0${commonDir}\0${stat.dev}:${stat.ino}:${stat.birthtimeMs}`);
    return { repository: true, root, gitDir, commonDir, repositoryId, layout, supported: layout === "standard" && !hasFilter, unsupportedReason: layout !== "standard" ? layout : hasFilter ? "untrusted-filter" : null, head, branchRef, branch: branchRef?.replace(/^refs\/heads\//, "") || null, unborn: head === null && branchRef !== null, detached: head !== null && branchRef === null, refs, status, indexFingerprint, operation, operationMarkers, executableConfig, filteredPaths, remotes, configFingerprint: hash(rawConfig), stateFingerprint: hash(JSON.stringify({ repositoryId, head, branchRef, refs, indexFingerprint, operationMarkers, status, config: hash(rawConfig) })) };
  }
}
module.exports = { GitState, parsePorcelainV2, validateGitHubUrl, activeFilters };
