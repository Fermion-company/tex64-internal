"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const fail = (code, message) => Object.assign(new Error(message), { code });
const validId = (id) => typeof id === "string" && /^[a-f0-9-]{16,80}$/.test(id);
const validPath = (name) => {
  if (typeof name !== "string" || !name || name.includes("\\") || /[\x00-\x1f:]/.test(name) ||
      name.startsWith("/") || name.split("/").some((s) => !s || s === "." || s === ".." ||
        /[. ]$/.test(s) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(s))) {
    throw fail("INVALID_PATH", "This file name cannot be safely stored in project history.");
  }
  return name;
};

// These paths are never read, including for comparison or safety snapshots.
const protectedReason = (name) => {
  const parts = name.split("/");
  if (parts.some((s) => /^\.git(?:$|ignore$|attributes$|modules$|config$)/i.test(s))) return "git";
  if (parts.some((s) => /^(\.env(?:\..*)?|\.ssh|\.aws|\.azure|\.gnupg|\.npmrc|\.netrc|credentials(?:\.json)?|secrets?(?:\..*)?|id_(rsa|ed25519|ecdsa)(?:\.pub)?)$/i.test(s)) || /\.(pem|key|p12|pfx)$/i.test(name)) return "private";
  if (parts.some((s) => [".tex64", "node_modules", ".venv", "venv", "__pycache__", ".DS_Store"].includes(s))) return "internal";
  if (/\.(aux|log|toc|out|lof|lot|fls|fdb_latexmk|synctex(?:\.gz)?|blg|nav|snm|vrb)$/i.test(name) || /\.tmp-\d+-\d+$/.test(name)) return "generated";
  return null;
};

async function safePath(root, relative, { allowMissing = true } = {}) {
  validPath(relative);
  let current = root;
  for (const [index, part] of relative.split("/").entries()) {
    current = path.join(current, part);
    const stat = await fsp.lstat(current).catch((error) => {
      if (allowMissing && error.code === "ENOENT") return null;
      throw error;
    });
    if (!stat) continue;
    if (stat.isSymbolicLink() || (index < relative.split("/").length - 1 && !stat.isDirectory())) {
      throw fail("UNSAFE_PATH", "A symbolic link or non-folder blocks a history path.");
    }
  }
  return current;
}

async function readRegular(root, relative, limit = 128 * 1024 * 1024) {
  const absolute = await safePath(root, relative);
  const namedBefore = await fsp.lstat(absolute).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
  if (!namedBefore) return null;
  if (!namedBefore.isFile() || namedBefore.isSymbolicLink()) throw fail("UNSAFE_PATH", "History can only read regular files.");
  let handle;
  try { handle = await fsp.open(absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0)); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw fail("UNSAFE_PATH", "History can only capture regular files.");
    if (before.ino !== namedBefore.ino || before.dev !== namedBefore.dev) throw fail("EXTERNAL_CHANGE", "A file was replaced while history was opening it.");
    if (before.size > limit) throw fail("FILE_TOO_LARGE", `File exceeds the history file limit: ${relative}`);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const named = await fsp.lstat(absolute).catch(() => null);
    if (!named || named.isSymbolicLink() || before.ino !== named.ino || before.dev !== named.dev ||
        before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw fail("EXTERNAL_CHANGE", "A file changed while project history was reading it.");
    }
    return { bytes, hash: hash(bytes), size: bytes.length, mode: before.mode & 0o777, identity: `${before.dev}:${before.ino}` };
  } finally { await handle.close(); }
}

async function syncDirectory(directory) {
  let handle;
  try { handle = await fsp.open(directory, "r"); await handle.sync(); }
  catch (error) { if (!["EINVAL", "EPERM", "EISDIR", "ENOTSUP", "EBADF"].includes(error.code)) throw error; }
  finally { await handle?.close(); }
}

async function atomicWrite(file, bytes, { exclusive = false } = {}) {
  const temporary = `${file}.tmp-${crypto.randomUUID()}`;
  const handle = await fsp.open(temporary, "wx", 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
  try {
    if (exclusive) await fsp.link(temporary, file);
    else await fsp.rename(temporary, file);
    await syncDirectory(path.dirname(file));
  } finally { await fsp.unlink(temporary).catch((e) => { if (e.code !== "ENOENT") throw e; }); }
}

module.exports = { hash, fail, validId, validPath, protectedReason, safePath, readRegular, atomicWrite, syncDirectory };
