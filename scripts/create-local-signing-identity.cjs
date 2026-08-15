#!/usr/bin/env node
"use strict";

const { execFileSync, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const IDENTITY_NAME = "TeX64 Local Signing";
const KEYCHAIN = path.join(os.homedir(), "Library", "Keychains", "tex64-local-signing.keychain-db");
const PASSWORD_FILE = path.join(os.homedir(), "Library", "Application Support", "TeX64", "local-signing", "keychain-password");

const run = (command, args, options = {}) => execFileSync(command, args, { encoding: "utf8", stdio: "pipe", ...options });
const tryRun = (command, args) => spawnSync(command, args, { encoding: "utf8", stdio: "pipe" });

function listedKeychains() {
  const result = tryRun("security", ["list-keychains", "-d", "user"]);
  if (result.status !== 0) return [];
  return result.stdout.split("\n").map((line) => line.trim().replace(/^"|"$/g, "")).filter(Boolean);
}

function hasIdentity() {
  if (!fs.existsSync(KEYCHAIN)) return false;
  const result = tryRun("security", ["find-identity", "-v", "-p", "codesigning", KEYCHAIN]);
  return result.status === 0 && result.stdout.includes(IDENTITY_NAME);
}

// Present in the keychain, but not yet trusted — "-v" only lists trusted identities,
// so this is what tells an import failure apart from a missing trust setting.
function importedIdentity() {
  const result = tryRun("security", ["find-identity", "-p", "codesigning", KEYCHAIN]);
  return result.status === 0 && result.stdout.includes(IDENTITY_NAME);
}

function exportPkcs12({ key, cert, identity, pass }) {
  const args = ["pkcs12", "-export", "-inkey", key, "-in", cert, "-name", IDENTITY_NAME,
    "-out", identity, "-passout", `pass:${pass}`];
  // OpenSSL 3 (Homebrew's, which usually wins the PATH) writes AES-256/PBKDF2 bundles
  // that Security cannot read: "MAC verification failed during PKCS12 import". -legacy
  // asks for the format macOS accepts. LibreSSL in /usr/bin has no such flag and
  // already writes that format, so fall back to a plain export there.
  if (tryRun("openssl", ["pkcs12", "-export", "-legacy", ...args.slice(2)]).status === 0) return;
  run("openssl", args);
}

function status() {
  console.log(hasIdentity() ? `${IDENTITY_NAME}: available` : `${IDENTITY_NAME}: not installed`);
}

function uninstall({ quiet = false } = {}) {
  const remaining = listedKeychains().filter((item) => path.resolve(item) !== path.resolve(KEYCHAIN));
  if (remaining.length) run("security", ["list-keychains", "-d", "user", "-s", ...remaining]);
  if (fs.existsSync(KEYCHAIN)) run("security", ["delete-keychain", KEYCHAIN]);
  fs.rmSync(PASSWORD_FILE, { force: true });
  if (!quiet) console.log(`${IDENTITY_NAME} を削除しました。`);
}

function password() {
  fs.mkdirSync(path.dirname(PASSWORD_FILE), { recursive: true });
  if (!fs.existsSync(PASSWORD_FILE)) {
    fs.writeFileSync(PASSWORD_FILE, crypto.randomBytes(24).toString("hex"), { mode: 0o600 });
  }
  fs.chmodSync(PASSWORD_FILE, 0o600);
  return fs.readFileSync(PASSWORD_FILE, "utf8").trim();
}

function create() {
  if (hasIdentity()) return console.log(`${IDENTITY_NAME} はすでに利用できます。`);
  console.log("信頼設定を追加するときに、macOS がログインパスワードを 1 回だけ求めます。");
  // A keychain left behind by an interrupted run has no usable identity (hasIdentity()
  // is false above), and create-keychain would fail on it. Start from a clean one.
  if (fs.existsSync(KEYCHAIN)) uninstall({ quiet: true });
  const pass = password();
  fs.mkdirSync(path.dirname(KEYCHAIN), { recursive: true });
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-local-signing-"));
  try {
    run("security", ["create-keychain", "-p", pass, KEYCHAIN]);
    run("security", ["set-keychain-settings", KEYCHAIN]);
    run("security", ["unlock-keychain", "-p", pass, KEYCHAIN]);
    const key = path.join(tempDir, "key.pem");
    const cert = path.join(tempDir, "cert.pem");
    const identity = path.join(tempDir, "id.p12");
    run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-keyout", key, "-out", cert,
      "-days", "3650", "-nodes", "-subj", `/CN=${IDENTITY_NAME}`,
      "-addext", "basicConstraints=critical,CA:false", "-addext", "keyUsage=critical,digitalSignature",
      "-addext", "extendedKeyUsage=critical,codeSigning"]);
    exportPkcs12({ key, cert, identity, pass });
    run("security", ["import", identity, "-k", KEYCHAIN, "-P", pass, "-T", "/usr/bin/codesign", "-A"]);
    run("security", ["set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-s", "-k", pass, KEYCHAIN]);
    if (!importedIdentity()) throw new Error("証明書をキーチェーンに取り込めませんでした。");
    const keychains = listedKeychains();
    if (!keychains.some((item) => path.resolve(item) === path.resolve(KEYCHAIN))) keychains.push(KEYCHAIN);
    run("security", ["list-keychains", "-d", "user", "-s", ...keychains]);
    console.log("この 1 回だけ macOS のログインパスワードを求められます。");
    run("security", ["add-trusted-cert", "-r", "trustRoot", "-p", "codeSign", "-k", KEYCHAIN, cert], { stdio: "inherit" });
  } catch (error) {
    console.error(`署名 ID を作成できませんでした: ${error.message}`);
    const output = `${error.stdout || ""}${error.stderr || ""}`.trim();
    if (output) console.error(output);
    // An imported-but-untrusted certificate is still worth keeping: the trust setting
    // can be added by hand. Anything earlier leaves nothing usable behind.
    if (!importedIdentity()) uninstall({ quiet: true });
    process.exit(1);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  if (!hasIdentity()) {
    console.error("署名 ID を有効にできませんでした。Keychain Access で『TeX64 Local Signing』を常に信頼に設定してください。");
    process.exit(1);
  }
  console.log(`${IDENTITY_NAME} を作成しました。`);
}

if (process.argv.includes("--status")) status();
else if (process.argv.includes("--uninstall")) uninstall();
else create();

module.exports = { IDENTITY_NAME, KEYCHAIN, PASSWORD_FILE };
