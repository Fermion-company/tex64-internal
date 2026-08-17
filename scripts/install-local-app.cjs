#!/usr/bin/env node
"use strict";

// Builds the production app bundle (the very same bundle electron-builder puts
// inside the dmg) and installs it into /Applications on this Mac.
//
//   node scripts/install-local-app.cjs               # build + install + relaunch if it was running
//   node scripts/install-local-app.cjs --skip-build  # install whatever is already in dist/
//   node scripts/install-local-app.cjs --launch      # always start the app afterwards
//   node scripts/install-local-app.cjs --from-hook   # git hook mode (lock, change filter, quiet)
//
// There is no Developer ID identity on this machine, so electron-builder skips
// signing and leaves a broken seal behind. We re-sign the bundle ad-hoc with the
// production entitlements so the installed app behaves like the shipped one.

const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const APP_BASENAME = "TeX64.app";
const BUNDLE_ID = "com.wedd.tex64";
const DEFAULT_TARGET = path.join("/Applications", APP_BASENAME);
const LOCK_DIR = path.join(os.homedir(), "Library", "Caches", "TeX64", "local-deploy.lock");
const RERUN_FLAG = path.join(os.homedir(), "Library", "Caches", "TeX64", "local-deploy.rerun");
const LOCAL_SIGNING_NAME = "TeX64 Local Signing";
const LOCAL_SIGNING_KEYCHAIN = path.join(os.homedir(), "Library", "Keychains", "tex64-local-signing.keychain-db");

// Commits that only touch these never change the packaged app.
const IRRELEVANT_PREFIXES = [
  "docs/",
  "tests/",
  "marketing/",
  "marketing-video/",
  "prototypes/",
  "store/",
  "api/",
  "test-workspace/",
  "test-sample-hover/",
  ".github/",
];
const IRRELEVANT_FILES = ["TODO.md", "CLAUDE.md", "AGENTS.md", "README.md", "LICENSE", "vercel.json"];

const options = parseArgs(process.argv.slice(2));

function parseArgs(argv) {
  const parsed = {
    skipBuild: false,
    launch: null, // null = relaunch only when it was running
    fromHook: false,
    force: false,
    target: DEFAULT_TARGET,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--skip-build") parsed.skipBuild = true;
    else if (arg === "--launch") parsed.launch = true;
    else if (arg === "--no-launch") parsed.launch = false;
    else if (arg === "--from-hook") parsed.fromHook = true;
    else if (arg === "--force") parsed.force = true;
    else if (arg === "--target") parsed.target = path.resolve(argv[++i] || DEFAULT_TARGET);
    else if (arg.startsWith("--target=")) parsed.target = path.resolve(arg.slice("--target=".length));
    else {
      console.error(`ERROR: unknown argument: ${arg}`);
      process.exit(1);
    }
  }
  return parsed;
}

function log(message) {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  console.log(`[local-deploy ${stamp}] ${message}`);
}

function run(command, args, extra = {}) {
  return execFileSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "pipe",
    ...extra,
  });
}

function runInherit(command, args, extra = {}) {
  execFileSync(command, args, { cwd: repoRoot, stdio: "inherit", ...extra });
}

function tryRun(command, args, extra = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "pipe",
    ...extra,
  });
  return { ok: result.status === 0, stdout: result.stdout || "", stderr: result.stderr || "" };
}

function requireMacOs() {
  if (process.platform !== "darwin") {
    console.error("ERROR: this installer only works on macOS.");
    process.exit(1);
  }
}

// ---------------------------------------------------------------- lock

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === "EPERM";
  }
}

function acquireLock() {
  fs.mkdirSync(path.dirname(LOCK_DIR), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.mkdirSync(LOCK_DIR);
      fs.writeFileSync(path.join(LOCK_DIR, "pid"), String(process.pid), "utf8");
      return true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const holder = Number.parseInt(readIfExists(path.join(LOCK_DIR, "pid")) || "", 10);
      if (Number.isInteger(holder) && pidAlive(holder)) return false;
      // Stale lock (crashed run, or the Mac slept through one) — take it over.
      fs.rmSync(LOCK_DIR, { recursive: true, force: true });
    }
  }
  return false;
}

function releaseLock() {
  fs.rmSync(LOCK_DIR, { recursive: true, force: true });
}

function readIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8").trim();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- hook filter

function commitTouchesApp() {
  if (options.force) return true;
  const revs = tryRun("git", ["rev-list", "--max-count=2", "HEAD"]);
  if (!revs.ok) return true;
  const list = revs.stdout.split("\n").filter(Boolean);
  if (list.length < 2) return true; // root commit: build it
  const diff = tryRun("git", ["diff", "--name-only", "HEAD~1", "HEAD"]);
  if (!diff.ok) return true;
  const files = diff.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  if (files.length === 0) return false;
  return files.some((file) => {
    if (IRRELEVANT_FILES.includes(file)) return false;
    if (file.endsWith(".md") && !file.includes("/")) return false;
    return !IRRELEVANT_PREFIXES.some((prefix) => file.startsWith(prefix));
  });
}

// ---------------------------------------------------------------- build

function packagedAppPath() {
  const dirName = process.arch === "arm64" ? "mac-arm64" : "mac";
  return path.join(repoRoot, "dist", dirName, APP_BASENAME);
}

function build() {
  log("packaging production bundle (npm run electron:pack)…");
  runInherit("npm", ["run", "-s", "electron:pack"]);
}

// ---------------------------------------------------------------- signing

const MACHO_MAGICS = new Set([0xfeedfacf, 0xcffaedfe, 0xfeedface, 0xcefaedfe, 0xcafebabe, 0xbebafeca]);

function isMachO(filePath) {
  let handle;
  try {
    handle = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(4);
    if (fs.readSync(handle, buffer, 0, 4, 0) < 4) return false;
    return MACHO_MAGICS.has(buffer.readUInt32BE(0)) || MACHO_MAGICS.has(buffer.readUInt32LE(0));
  } catch {
    return false;
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

function collectMachOFiles(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) collectMachOFiles(full, out);
    else if (entry.isFile() && isMachO(full)) out.push(full);
  }
  return out;
}

function hasDeveloperIdIdentity() {
  const result = tryRun("security", ["find-identity", "-v", "-p", "codesigning"]);
  return result.ok && result.stdout.includes("Developer ID Application");
}

function findLocalSigningIdentity() {
  if (!fs.existsSync(LOCAL_SIGNING_KEYCHAIN)) return null;
  const result = tryRun("security", ["find-identity", "-v", "-p", "codesigning", LOCAL_SIGNING_KEYCHAIN]);
  return result.ok && result.stdout.includes(LOCAL_SIGNING_NAME)
    ? { name: LOCAL_SIGNING_NAME, keychain: LOCAL_SIGNING_KEYCHAIN }
    : null;
}

function signingArgs(identity) {
  return identity
    ? ["--sign", identity.name, "--keychain", identity.keychain]
    : ["--sign", "-"];
}

function codesign(target, identity, { entitlements, deep } = {}) {
  const args = ["--force", ...signingArgs(identity), "--timestamp=none", "--options", "runtime"];
  if (deep) args.push("--deep");
  if (entitlements) args.push("--entitlements", entitlements);
  args.push(target);
  const result = tryRun("codesign", args);
  if (!result.ok) {
    throw new Error(`codesign failed for ${target}\n${result.stderr.trim()}`);
  }
}

function signBundle(appPath, identity) {
  const entitlements = path.join(repoRoot, "build", "entitlements.mac.plist");
  const inherit = path.join(repoRoot, "build", "entitlements.mac.inherit.plist");
  if (!fs.existsSync(entitlements) || !fs.existsSync(inherit)) {
    throw new Error("entitlements plists are missing — run `npm run dist:prep` first.");
  }

  log(identity
    ? `signing the bundle with ${identity.name}…`
    : "ad-hoc signing the bundle (no Developer ID on this Mac)…");

  // Deepest first: loose binaries, then frameworks, then helpers, then the app.
  const resources = path.join(appPath, "Contents", "Resources");
  for (const file of collectMachOFiles(resources)) {
    const result = tryRun("codesign", ["--force", ...signingArgs(identity), "--timestamp=none", file]);
    if (!result.ok) log(`WARN: could not sign ${path.relative(appPath, file)}: ${result.stderr.trim()}`);
  }

  const frameworksDir = path.join(appPath, "Contents", "Frameworks");
  const frameworkEntries = fs.existsSync(frameworksDir) ? fs.readdirSync(frameworksDir) : [];
  for (const name of frameworkEntries.filter((entry) => entry.endsWith(".framework"))) {
    codesign(path.join(frameworksDir, name), identity, { deep: true });
  }
  for (const name of frameworkEntries.filter((entry) => entry.endsWith(".app"))) {
    codesign(path.join(frameworksDir, name), identity, { deep: true, entitlements: inherit });
  }
  codesign(appPath, identity, { entitlements });

  const verify = tryRun("codesign", ["--verify", "--strict", "--verbose=2", appPath]);
  if (!verify.ok) {
    throw new Error(`signature verification failed:\n${verify.stderr.trim()}`);
  }
  const requirement = tryRun("codesign", ["-d", "-r-", appPath]);
  const requirementText = `${requirement.stdout}${requirement.stderr}`.trim();
  if (identity && !requirementText.includes("certificate leaf")) {
    throw new Error(`stable designated requirement was not created:\n${requirementText}`);
  }
  if (requirementText) log(`designated requirement: ${requirementText.replace(/\s+/g, " ")}`);
  log("signature verified.");
}

// ---------------------------------------------------------------- install

function runningAppPids(appPath) {
  const executable = path.join(appPath, "Contents", "MacOS", "TeX64");
  const result = tryRun("pgrep", ["-f", executable]);
  if (!result.ok) return [];
  return result.stdout
    .split("\n")
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isInteger(pid) && pid !== process.pid);
}

function sleepMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.round(ms));
}

function quitRunningApp(appPath) {
  if (runningAppPids(appPath).length === 0) return false;
  log("quitting the running TeX64…");
  tryRun("osascript", ["-e", `tell application id "${BUNDLE_ID}" to quit`]);
  for (let waited = 0; waited < 15000; waited += 500) {
    if (runningAppPids(appPath).length === 0) return true;
    sleepMs(500);
  }
  for (const pid of runningAppPids(appPath)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  sleepMs(2000);
  for (const pid of runningAppPids(appPath)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  sleepMs(500);
  return true;
}

function assertWritableParent(target) {
  const parent = path.dirname(target);
  try {
    fs.accessSync(parent, fs.constants.W_OK);
  } catch {
    console.error(
      `ERROR: ${parent} is not writable by this user. Move the target with --target, or fix the permissions.`,
    );
    process.exit(1);
  }
}

function install(sourceApp, target) {
  assertWritableParent(target);
  const parent = path.dirname(target);
  const staging = path.join(parent, `.${path.basename(target)}.new-${process.pid}`);
  const backup = path.join(parent, `.${path.basename(target)}.old-${process.pid}`);

  fs.rmSync(staging, { recursive: true, force: true });
  log(`copying bundle into ${parent}…`);
  runInherit("ditto", [sourceApp, staging]);

  const hadPrevious = fs.existsSync(target);
  if (hadPrevious) fs.renameSync(target, backup);
  try {
    fs.renameSync(staging, target);
  } catch (error) {
    if (hadPrevious) fs.renameSync(backup, target);
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  if (hadPrevious) fs.rmSync(backup, { recursive: true, force: true });

  tryRun("xattr", ["-dr", "com.apple.quarantine", target]);
  tryRun("/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister", [
    "-f",
    target,
  ]);
  log(`installed: ${target}`);
}

// ---------------------------------------------------------------- main

function deployOnce() {
  const sourceApp = packagedAppPath();
  if (!options.skipBuild) {
    build();
  }
  if (!fs.existsSync(sourceApp)) {
    console.error(`ERROR: packaged app not found at ${sourceApp}. Run without --skip-build.`);
    process.exit(1);
  }
  if (hasDeveloperIdIdentity()) {
    log("Developer ID identity found — keeping electron-builder's signature.");
  } else {
    const localIdentity = findLocalSigningIdentity();
    signBundle(sourceApp, localIdentity);
    if (!localIdentity) {
      log("ad-hoc 署名のため、再ビルドのたびに macOS のファイルアクセス許可がリセットされます。`npm run sign:local-identity` で安定署名にできます。");
    }
  }

  const target = options.target;
  const wasRunning = quitRunningApp(target);
  install(sourceApp, target);

  const shouldLaunch = options.launch === null ? wasRunning : options.launch;
  if (shouldLaunch) {
    log("relaunching…");
    tryRun("open", ["-a", target]);
  }
}

function main() {
  requireMacOs();

  if (options.fromHook && !commitTouchesApp()) {
    log("commit touches no packaged files — skipping the local deploy.");
    return;
  }

  if (!acquireLock()) {
    if (options.fromHook) {
      fs.mkdirSync(path.dirname(RERUN_FLAG), { recursive: true });
      fs.writeFileSync(RERUN_FLAG, new Date().toISOString(), "utf8");
      log("another local deploy is running — queued a re-run after it finishes.");
      return;
    }
    console.error("ERROR: another local deploy is already running.");
    process.exit(1);
  }

  try {
    deployOnce();
    // A commit that landed while we were building queued a re-run.
    if (fs.existsSync(RERUN_FLAG)) {
      fs.rmSync(RERUN_FLAG, { force: true });
      log("a newer commit arrived during the build — deploying again.");
      options.skipBuild = false;
      deployOnce();
    }
    log("done.");
  } finally {
    releaseLock();
  }
}

main();
