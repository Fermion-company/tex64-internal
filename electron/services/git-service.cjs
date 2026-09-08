"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { constants } = require("node:fs");
const { GitState, activeFilters } = require("./git-state.cjs");
const fail = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const text = result => result.stdout.toString("utf8").replace(/\n$/, "");
const schema = { stage: ["paths"], unstage: ["paths"], commit: ["message"], "branch-create": ["name", "ref"], "branch-switch": ["ref"], merge: ["ref"], "resolve-stage": ["paths"], "merge-finish": ["message"], "merge-abort": [], "tag-create": ["name", "ref", "message"] };
const titles = { stage: "コミット対象に追加", unstage: "コミット対象から外す", commit: "コミット", "branch-create": "ブランチを作成して切り替える", "branch-switch": "ブランチを切り替える", merge: "変更を取り込む", "resolve-stage": "解決済みにする", "merge-finish": "統合を完了", "merge-abort": "統合を中止", "tag-create": "タグを付ける" };
const literalPath = value => {
  if (typeof value !== "string" || !value || value.includes("\0") || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value) || value.split("/").some(part => !part || part === "." || part === ".." || /^\.git$/i.test(part))) throw fail("GIT_PATH_INVALID", "Choose a project file, not a folder or Git metadata.");
  return value;
};
const message = value => {
  if (typeof value !== "string" || !value.trim() || value.length > 16000 || value.includes("\0")) throw fail("GIT_MESSAGE_REQUIRED", "Enter a short description of the change.");
  return value.trim();
};

class GitService {
  constructor({ runner, withMutation }) { this.runner = runner; this.reader = new GitState({ runner }); this.withMutation = withMutation; this.plans = new Map(); }
  status() { return this.reader.read(); }
  async read(args, options = {}) { return this.runner.run(args, { ...options, readOnly: true }); }
  async validRef(ref, namespace = null) {
    if (typeof ref !== "string" || ref.length > 1024 || !ref.startsWith("refs/") || (namespace && !ref.startsWith(namespace))) throw fail("GIT_REF_INVALID", "Choose an explicit branch or tag.");
    const result = await this.read(["check-ref-format", ref], { allowFailure: true });
    if (result.code !== 0) throw fail("GIT_REF_INVALID", "This branch or tag name is invalid.");
    return ref;
  }
  async target(ref, state) {
    if (ref === undefined) { if (!state.head) throw fail("GIT_NO_COMMIT", "Create the first commit before this operation."); return { ref: state.branchRef, oid: state.head }; }
    if (/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(ref)) return { ref: null, oid: text(await this.read(["rev-parse", "--verify", `${ref}^{commit}`])) };
    await this.validRef(ref);
    if (!state.refs.some(item => item.name === ref)) throw fail("GIT_REF_NOT_FOUND", "The selected branch or tag no longer exists.");
    return { ref, oid: text(await this.read(["rev-parse", "--verify", `${ref}^{commit}`])) };
  }
  async filesFingerprint(paths) {
    const result = [];
    for (const relative of paths) {
      literalPath(relative);
      const parts = relative.split("/");
      for (let index = 1; index < parts.length; index++) {
        const parent = await fs.lstat(path.join(this.runner.root, ...parts.slice(0, index))).catch(error => { if (error.code === "ENOENT") return null; throw error; });
        if (parent && (!parent.isDirectory() || parent.isSymbolicLink())) throw fail("GIT_PATH_UNSAFE", "A project path passes through a link or non-directory.");
      }
      const file = path.join(this.runner.root, relative);
      const stat = await fs.lstat(file).catch(error => { if (error.code === "ENOENT") return null; throw error; });
      if (!stat) { result.push({ path: relative, kind: "missing" }); continue; }
      if (stat.isSymbolicLink()) { result.push({ path: relative, kind: "link", hash: sha(await fs.readlink(file)), mode: stat.mode }); continue; }
      if (!stat.isFile() || stat.size > 128 * 1024 * 1024) throw fail("GIT_PATH_UNSUPPORTED", "This file cannot be protected safely for the selected operation.");
      const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      try {
        const before = await handle.stat(); const bytes = await handle.readFile(); const after = await handle.stat();
        if (before.ino !== stat.ino || before.dev !== stat.dev || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.size !== after.size) throw fail("STATE_CHANGED", "A file changed while the operation was being prepared.");
        result.push({ path: relative, kind: "file", hash: sha(bytes), mode: after.mode });
      } finally { await handle.close(); }
    }
    return sha(JSON.stringify(result));
  }
  async indexTree() {
    const raw = (await this.read(["ls-files", "--stage", "-z"])).stdout.toString("utf8");
    const tuples = raw.split("\0").filter(Boolean).map(item => {
      const match = /^(\d+) ([a-f0-9]+) (\d)\t([\s\S]+)$/.exec(item);
      if (!match || match[3] !== "0") throw fail("GIT_UNMERGED", "Resolve every file before committing.");
      return `${match[1]} ${match[2]}\t${match[4]}`;
    });
    return sha(tuples.sort().join("\0"));
  }
  async committedTree(oid) {
    const raw = (await this.read(["ls-tree", "-r", "-z", "--full-tree", oid])).stdout.toString("utf8");
    return sha(raw.split("\0").filter(Boolean).map(item => item.replace(/^(\d+) (?:blob|commit) /, "$1 ")).sort().join("\0"));
  }
  async assertTrusted(action, state) {
    const configBlocked = state.executableConfig.filter(item => /^(?:core\.(?:hookspath|fsmonitor)|merge\..*\.driver|gpg(?:\..*)?\.program)/i.test(item.key));
    if (configBlocked.length) throw fail("GIT_EXECUTABLE_CONFIG", "Review executable Git configuration before running this operation.", { reasons: configBlocked.map(item => item.key) });
    const hooks = await fs.readdir(path.join(state.gitDir, "hooks"), { withFileTypes: true }).catch(error => { if (error.code === "ENOENT") return []; throw error; });
    const active = [];
    for (const entry of hooks) {
      if (entry.name.endsWith(".sample") || entry.isDirectory()) continue;
      const info = await fs.lstat(path.join(state.gitDir, "hooks", entry.name));
      if (info.isSymbolicLink() || (info.mode & 0o111)) active.push(entry.name);
    }
    if (active.length) throw fail("GIT_HOOKS_UNTRUSTED", "Review repository hooks before running this operation.", { reasons: active });
    if (action === "merge") {
      const options = await this.read(["config", "--get", `branch.${state.branch}.mergeOptions`], { allowFailure: true });
      if (options.code === 0 && text(options).trim()) throw fail("GIT_EXECUTABLE_CONFIG", "Review custom merge options before running this operation.", { reasons: [`branch.${state.branch}.mergeOptions`] });
    }
    const keys = action === "tag-create" ? ["tag.gpgSign", "tag.forceSignAnnotated"] : action === "merge" ? ["merge.verifySignatures", "commit.gpgSign"] : ["commit", "merge-finish"].includes(action) ? ["commit.gpgSign"] : [];
    for (const key of keys) {
      const signed = await this.read(["config", "--type=bool", "--get", key], { allowFailure: true });
      if (signed.code === 0 && text(signed) === "true") throw fail("GIT_SIGNING_REQUIRED", "This repository requires signing. Configure a trusted signing path before continuing.", { reasons: [key] });
      if (![0, 1].includes(signed.code)) throw fail("GIT_CONFIG_INVALID", "Git signing configuration is invalid.");
    }
  }
  async assertTargetFilters(oid) {
    const current = (await this.read(["ls-files", "--cached", "--others", "--exclude-standard", "-z"])).stdout.toString("utf8").split("\0").filter(Boolean);
    const target = (await this.read(["ls-tree", "-r", "--name-only", "-z", oid])).stdout.toString("utf8").split("\0").filter(Boolean);
    const paths = [...new Set([...current, ...target])];
    // Merge can combine one side's attributes with the other side's new file.
    if ((await activeFilters(this.runner, { source: oid, paths })).length || (await activeFilters(this.runner, { paths })).length) throw fail("GIT_FILTER_UNTRUSTED", "The target contains files that need an external Git filter.");
  }
  async author() {
    const name = await this.read(["config", "--get", "user.name"], { allowFailure: true });
    const email = await this.read(["config", "--get", "user.email"], { allowFailure: true });
    if (name.code !== 0 || email.code !== 0 || !text(name).trim() || !text(email).trim()) throw fail("GIT_AUTHOR_REQUIRED", "Set the commit name and email for this repository.");
  }
  async mergeHeads(gitDir) {
    try { const value = (await fs.readFile(path.join(gitDir, "MERGE_HEAD"), "utf8")).trim().split(/\s+/); if (!value.every(oid => /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(oid))) throw new Error(); return value; }
    catch { throw fail("GIT_MERGE_STATE_INVALID", "The merge state changed. Refresh before continuing."); }
  }
  async plan(action, args = {}) {
    if (!Object.hasOwn(schema, action) || !args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some(key => !schema[action].includes(key))) throw fail("GIT_ACTION_INVALID", "Invalid Git operation.");
    const state = await this.status();
    if (!state.repository) throw fail("GIT_NOT_INITIALIZED", "Connect or initialize this project first.");
    if (!state.supported) throw fail("GIT_LAYOUT_UNSUPPORTED", "This repository configuration needs external Git tools.", { reason: state.unsupportedReason });
    await this.assertTrusted(action, state);
    const mergeAction = ["resolve-stage", "merge-finish", "merge-abort"].includes(action);
    if (mergeAction ? state.operation !== "merge" : state.operation !== "idle") throw fail("GIT_OPERATION_IN_PROGRESS", "Finish the current Git operation first.");
    if (state.status.hasUnmerged && !["resolve-stage", "merge-abort"].includes(action)) throw fail("GIT_UNMERGED", "Resolve every file before continuing.");
    const plan = { action, state, args: {}, paths: [], createdAt: Date.now(), writesWorktree: ["branch-create", "branch-switch", "merge", "merge-abort"].includes(action) };
    if (["stage", "unstage", "resolve-stage"].includes(action)) {
      if (!Array.isArray(args.paths) || !args.paths.length || args.paths.length > 500) throw fail("GIT_PATH_INVALID", "Choose the files for this operation.");
      plan.paths = [...new Set(args.paths.map(literalPath))].sort();
      if (action === "resolve-stage" && plan.paths.some(file => !state.status.entries.some(entry => entry.path === file && entry.unmerged))) throw fail("GIT_PATH_INVALID", "Choose an unresolved file.");
      if (action === "unstage" && state.unborn) plan.emptyTree = text(await this.read(["hash-object", "-t", "tree", "--stdin"]));
    }
    if (["commit", "merge-finish", "tag-create"].includes(action)) {
      await this.author(); plan.args.message = action === "tag-create" && args.message === undefined ? args.name : message(args.message);
    }
    if (["commit", "merge-finish"].includes(action)) {
      if (action === "commit" && !state.status.hasStaged) throw fail("GIT_NOTHING_STAGED", "Choose changes to commit first.");
      plan.indexTree = await this.indexTree();
      plan.paths = state.status.entries.filter(item => item.staged).flatMap(item => [item.path, ...(item.originalPath ? [item.originalPath] : [])]);
      if (action === "merge-finish") plan.mergeHeads = await this.mergeHeads(state.gitDir);
    }
    if (["branch-create", "branch-switch", "merge", "tag-create"].includes(action)) {
      if (action === "branch-create" || action === "tag-create") {
        if (typeof args.name !== "string" || args.name.startsWith("-") || args.name.startsWith("refs/")) throw fail("GIT_REF_INVALID", "Enter a branch or tag name.");
        plan.newRef = await this.validRef(`${action === "tag-create" ? "refs/tags/" : "refs/heads/"}${args.name}`);
        if (state.refs.some(item => item.name === plan.newRef)) throw fail("GIT_REF_EXISTS", "This branch or tag already exists.");
        plan.args.name = args.name;
      }
      if (action === "branch-switch") {
        await this.validRef(args.ref, "refs/heads/");
        if (args.ref.slice("refs/heads/".length).startsWith("-")) throw fail("GIT_REF_INVALID", "Choose a branch with a supported name.");
      }
      plan.target = await this.target(args.ref, state);
      if (["branch-create", "branch-switch", "merge"].includes(action)) await this.assertTargetFilters(plan.target.oid);
      if (action === "branch-switch" && !plan.target.ref?.startsWith("refs/heads/")) throw fail("GIT_REF_INVALID", "Choose a local branch.");
      if (["branch-switch", "merge"].includes(action) || (action === "branch-create" && plan.target.oid !== state.head)) {
        if (!state.status.clean) throw fail("GIT_DIRTY", "Commit or set aside the current changes before switching or merging.");
      }
      if (["branch-create", "branch-switch", "merge"].includes(action) && state.head) {
        plan.paths = (await this.read(["diff", "--name-only", "-z", "--no-ext-diff", "--no-textconv", state.head, plan.target.oid, "--"])).stdout.toString("utf8").split("\0").filter(Boolean);
      }
      if (action === "merge") {
        if (!state.branchRef) throw fail("GIT_DETACHED", "Switch to a branch before merging.");
        const ancestor = await this.read(["merge-base", "--is-ancestor", plan.target.oid, state.head], { allowFailure: true });
        const forward = await this.read(["merge-base", "--is-ancestor", state.head, plan.target.oid], { allowFailure: true });
        if (![0, 1].includes(ancestor.code) || ![0, 1].includes(forward.code)) throw fail("GIT_HISTORY_UNAVAILABLE", "Cannot compare these histories.");
        plan.mergeMode = ancestor.code === 0 ? "unchanged" : forward.code === 0 ? "fast-forward" : "merge";
        if (plan.mergeMode === "merge") {
          const base = await this.read(["merge-base", state.head, plan.target.oid], { allowFailure: true });
          if (base.code !== 0) throw fail("GIT_UNRELATED_HISTORIES", "These histories cannot be merged automatically.");
        }
      }
    }
    if (action === "merge-abort") { plan.mergeHeads = await this.mergeHeads(state.gitDir); plan.paths = state.status.entries.map(item => item.path); }
    plan.paths = [...new Set(plan.paths)].sort();
    plan.filesFingerprint = await this.filesFingerprint(plan.paths);
    const planId = crypto.randomUUID();
    const details = [];
    if (plan.target) {
      const targetName = (plan.target.ref || "").replace(/^refs\/(heads|remotes|tags)\//, "") || plan.target.oid.slice(0, 12);
      if (action === "merge") details.push(`${targetName} を ${state.branch || "HEAD"} に統合`);
      else if (action === "tag-create") details.push(`${plan.args.name}：${targetName}（${plan.target.oid.slice(0, 12)}）`);
      else details.push(`${state.branch || "HEAD"} → ${plan.args.name || targetName}`);
    }
    if (action === "commit" || action === "merge-finish") details.push(plan.args.message);
    if (action === "merge-abort") details.push("統合前に戻します。途中の編集は退避します。");
    if (action === "tag-create" && !state.status.clean) details.push("未コミットの変更は含まれません。");
    if (action === "stage" && state.status.entries.some(item => plan.paths.includes(item.path) && item.partiallyStaged)) details.push("選んだファイルの残りの変更もコミット対象に追加します。");
    this.plans.clear(); this.plans.set(planId, plan);
    return { planId, review: { title: titles[action], details, actionLabel: titles[action], changedPaths: plan.paths } };
  }
  async verify(plan, state) {
    const expected = (condition, reason) => { if (!condition) throw fail("GIT_RESULT_UNCERTAIN", reason); };
    expected(state.repositoryId === plan.state.repositoryId, "The repository changed while Git was running.");
    if (["stage", "unstage", "resolve-stage"].includes(plan.action)) {
      expected(state.head === plan.state.head && state.branchRef === plan.state.branchRef, "Git changed the current branch unexpectedly.");
      const args = plan.action === "unstage" ? ["diff", "--cached", "--quiet", "--no-ext-diff", "--no-textconv", plan.state.head || plan.emptyTree, "--", ...plan.paths] : ["diff", "--quiet", "--no-ext-diff", "--no-textconv", "--", ...plan.paths];
      expected((await this.read(["--literal-pathspecs", ...args], { allowFailure: true })).code === 0, "The selected files do not match the expected index state.");
      expected(!state.status.entries.some(item => plan.paths.includes(item.path) && item.unmerged), "A selected file remains unresolved.");
    } else if (["commit", "merge-finish"].includes(plan.action)) {
      const parents = text(await this.read(["rev-list", "--parents", "-n", "1", state.head])).split(" ").slice(1);
      expected(JSON.stringify(parents) === JSON.stringify([...(plan.state.head ? [plan.state.head] : []), ...(plan.mergeHeads || [])]), "The new commit has unexpected parents.");
      expected(await this.committedTree(state.head) === plan.indexTree, "The new commit differs from the reviewed index.");
      expected(state.branchRef === plan.state.branchRef && state.operation === "idle", "Git did not finish the commit on the selected branch.");
    } else if (plan.action === "branch-create" || plan.action === "branch-switch") {
      expected(state.head === plan.target.oid && state.branchRef === (plan.newRef || plan.target.ref), "Git did not switch to the selected branch.");
    } else if (plan.action === "tag-create") {
      expected(text(await this.read(["cat-file", "-t", plan.newRef])) === "tag", "Git did not create an annotated tag.");
      expected(text(await this.read(["rev-parse", "--verify", `${plan.newRef}^{commit}`])) === plan.target.oid, "The tag points to another commit.");
      expected(state.head === plan.state.head && state.branchRef === plan.state.branchRef, "Tag creation changed the current branch.");
    } else if (plan.action === "merge") {
      expected(state.branchRef === plan.state.branchRef, "The merge changed the selected branch.");
      if (plan.mergeMode === "merge") {
        expected(state.head === plan.state.head && state.operation === "merge", "The merge did not stop for review before committing.");
        expected(JSON.stringify(await this.mergeHeads(state.gitDir)) === JSON.stringify([plan.target.oid]), "The merge target changed.");
        return "conflict";
      }
      expected(state.head === (plan.mergeMode === "unchanged" ? plan.state.head : plan.target.oid) && state.operation === "idle", "The fast-forward result is unexpected.");
    } else if (plan.action === "merge-abort") expected(state.head === plan.state.head && state.operation === "idle", "Git could not return to the pre-merge branch state.");
    return plan.action === "resolve-stage" && state.operation === "merge" ? "conflict" : "completed";
  }
  async execute(planId) {
    const plan = this.plans.get(planId);
    if (!plan) throw fail("GIT_PLAN_EXPIRED", "Review this Git operation again.");
    this.plans.delete(planId);
    if (typeof this.withMutation !== "function") throw fail("GIT_MUTATION_GUARD_REQUIRED", "Git changes require workspace protection.");
    const verify = async () => this.verify(plan, await this.status());
    return this.withMutation({ action: plan.action, writesWorktree: plan.writesWorktree, paths: [...plan.paths], verify }, async () => {
      const current = await this.status();
      if (current.stateFingerprint !== plan.state.stateFingerprint || await this.filesFingerprint(plan.paths) !== plan.filesFingerprint) throw fail("STATE_CHANGED", "The project changed after confirmation. Review the operation again.");
      await this.assertTrusted(plan.action, current);
      if (plan.target && ["branch-create", "branch-switch", "merge"].includes(plan.action)) await this.assertTargetFilters(plan.target.oid);
      const run = (args, options) => this.runner.run(args, options);
      let result = { code: 0 };
      switch (plan.action) {
        case "stage": case "resolve-stage": result = await run(["--literal-pathspecs", "add", "--", ...plan.paths]); break;
        case "unstage":
          if (plan.emptyTree) await run(["hash-object", "-t", "tree", "-w", "--stdin"]);
          result = await run(["--literal-pathspecs", "restore", "--staged", `--source=${plan.state.head || plan.emptyTree}`, "--", ...plan.paths]); break;
        case "commit": case "merge-finish": result = await run(["commit", "-m", plan.args.message]); break;
        case "branch-create": result = await run(["switch", "--no-guess", "--no-overwrite-ignore", "-c", plan.args.name, plan.target.oid]); break;
        case "branch-switch": result = await run(["switch", "--no-guess", "--no-overwrite-ignore", "--", plan.target.ref.slice("refs/heads/".length)]); break;
        case "merge":
          if (plan.mergeMode !== "unchanged") result = await run(["merge", plan.mergeMode === "fast-forward" ? "--ff-only" : "--no-ff", "--no-commit", "--no-edit", "--no-autostash", "--no-overwrite-ignore", plan.target.oid], { allowFailure: true });
          break;
        case "merge-abort": result = await run(["merge", "--abort"]); break;
        case "tag-create": result = await run(["tag", "-a", plan.args.name, plan.target.oid, "-m", plan.args.message]); break;
      }
      const state = await this.status();
      const completion = await this.verify(plan, state);
      if (result.code !== 0 && !(plan.action === "merge" && state.status?.hasUnmerged && completion === "conflict")) throw fail("GIT_FAILED", result.stderr || "Git operation failed.");
      return { action: plan.action, state, conflict: Boolean(state.status?.hasUnmerged), mergePending: state.operation === "merge", completion };
    });
  }
}
module.exports = { GitService };
