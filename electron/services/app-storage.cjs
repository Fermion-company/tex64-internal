"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");

function temporaryLockDirectory() {
  const user = process.getuid?.() ??
    createHash("sha256").update(os.homedir()).digest("hex").slice(0, 16);
  return path.join(os.tmpdir(), `tex64-locks-${user}`);
}

function validateTemporaryLockDirectory(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o7777) !== 0o700))) {
    throw Object.assign(new Error("Temporary lock directory is not private."), { code: "EACCES" });
  }
}

function ensureTemporaryLockDirectory(directory = temporaryLockDirectory()) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  validateTemporaryLockDirectory(directory);
}

// Node's codes for a volume without hard links (Windows reports
// ERROR_INVALID_FUNCTION from CreateHardLinkW as EISDIR).
const LINK_UNSUPPORTED = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "ENOSYS", "EISDIR"]);

const logged = new Set();
function logStorageFailure(area, error) {
  if (logged.has(area)) return;
  logged.add(area);
  console.warn(`[storage] ${area} unavailable`, error);
}

module.exports = {
  temporaryLockDirectory, ensureTemporaryLockDirectory, validateTemporaryLockDirectory, logStorageFailure, LINK_UNSUPPORTED,
};
