#!/usr/bin/env node
"use strict";

// Installs (or removes) the local-deploy git hook for this clone.
//
//   node scripts/install-git-hooks.cjs             # install post-commit
//   node scripts/install-git-hooks.cjs --uninstall # remove it
//
// The hook lives in .git/hooks, which git does not version, so this script is
// how the versioned template in scripts/hooks/ gets there. The node binary is
// pinned at install time because GUI git clients do not see nvm's PATH.

const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const HOOK_NAME = "post-commit";
const MARKER = "tex64-local-deploy-hook";
const templatePath = path.join(repoRoot, "scripts", "hooks", HOOK_NAME);

const uninstall = process.argv.slice(2).includes("--uninstall");

function git(args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
}

function resolveHooksDir() {
  const configured = spawnSync("git", ["config", "--get", "core.hooksPath"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (configured.status === 0 && configured.stdout.trim()) {
    return path.resolve(repoRoot, configured.stdout.trim());
  }
  const commonDir = spawnSync("git", ["rev-parse", "--git-common-dir"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const gitDir =
    commonDir.status === 0 && commonDir.stdout.trim()
      ? commonDir.stdout.trim()
      : git(["rev-parse", "--git-dir"]);
  return path.join(path.resolve(repoRoot, gitDir), "hooks");
}

function main() {
  const hooksDir = resolveHooksDir();
  const hookPath = path.join(hooksDir, HOOK_NAME);
  const existing = fs.existsSync(hookPath) ? fs.readFileSync(hookPath, "utf8") : null;

  if (uninstall) {
    if (existing === null) {
      console.log(`No ${HOOK_NAME} hook installed.`);
      return;
    }
    if (!existing.includes(MARKER)) {
      console.error(`ERROR: ${hookPath} is not the TeX64 hook — leaving it alone.`);
      process.exit(1);
    }
    fs.rmSync(hookPath);
    console.log(`Removed ${hookPath}. Commits no longer refresh /Applications/TeX64.app.`);
    return;
  }

  if (existing !== null && !existing.includes(MARKER)) {
    const backup = `${hookPath}.backup-${Date.now()}`;
    fs.renameSync(hookPath, backup);
    console.log(`Existing ${HOOK_NAME} hook backed up to ${backup}.`);
  }

  const template = fs.readFileSync(templatePath, "utf8");
  const hook = template.replace("@@NODE_BIN@@", process.execPath);
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(hookPath, hook, { mode: 0o755 });
  fs.chmodSync(hookPath, 0o755);

  console.log(`Installed ${hookPath}`);
  console.log(`  node: ${process.execPath}`);
  console.log("  every commit now repackages the app and refreshes /Applications/TeX64.app");
  console.log("  log:  ~/Library/Logs/tex64-local-deploy.log");
}

main();
