"use strict";

// Mirror ownership lives under .tex64, outside both the shared manifest and
// the project tree. A live PID is always treated as occupied, even if reused;
// uncertainty costs a sibling folder, never another process's edits.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const LOCK_NAME = "collab-mirror.lock";
const PROCESS_START = Math.floor(Date.now() - process.uptime() * 1000);

const removeOwner = (directory, ownerName) => {
  try {
    fs.unlinkSync(path.join(directory, ownerName));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  try {
    // Never recursively remove a lock: another contender may already have
    // published its own, nonempty directory at this path.
    fs.rmdirSync(directory);
  } catch (error) {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error;
  }
};

const reclaimStale = (directory) => {
  try {
    if (!fs.lstatSync(directory).isDirectory()) return false;
    const names = fs.readdirSync(directory);
    if (!names.length) {
      fs.rmdirSync(directory);
      return true;
    }
    if (names.length !== 1) return false;
    const owner = JSON.parse(fs.readFileSync(path.join(directory, names[0]), "utf8"));
    if (!Number.isInteger(owner.pid) || owner.pid <= 0) return false;
    try {
      process.kill(owner.pid, 0);
      return false;
    } catch (error) {
      if (error.code !== "ESRCH") return false;
    }
    removeOwner(directory, names[0]);
    return true;
  } catch (error) {
    // A concurrent reclaim may have removed the stale owner already. An
    // unreadable or malformed owner is kept, rather than risking a live one.
    return error.code === "ENOENT";
  }
};

const ensureDirectory = (directory) => {
  fs.mkdirSync(directory, { recursive: true });
  if (!fs.lstatSync(directory).isDirectory()) {
    throw Object.assign(new Error("Unsafe mirror directory."), { code: "COLLAB_REFUSED" });
  }
};

const acquireMirror = (preferredRoot) => {
  for (let index = 0; ; index++) {
    const rootPath = index ? `${preferredRoot}-${index + 1}` : preferredRoot;
    ensureDirectory(rootPath);
    const internal = path.join(rootPath, ".tex64");
    ensureDirectory(internal);
    const directory = path.join(internal, LOCK_NAME);
    const token = crypto.randomUUID();
    const ownerName = `${token}.json`;
    const staging = path.join(internal, `${LOCK_NAME}-${token}.tmp`);
    fs.mkdirSync(staging);
    try {
      fs.writeFileSync(path.join(staging, ownerName), JSON.stringify({ pid: process.pid, startedAt: PROCESS_START, token }), { flag: "wx" });
      for (;;) {
        try {
          // Publish the owner atomically. A nonempty lock directory cannot
          // be replaced by rename, even by two simultaneous stale claimants.
          fs.renameSync(staging, directory);
          break;
        } catch (error) {
          if (!["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(error.code)) throw error;
          if (["EPERM", "EACCES"].includes(error.code) && !fs.existsSync(directory)) throw error;
          if (!reclaimStale(directory)) break;
        }
      }
      if (fs.existsSync(staging)) continue;
      let released = false;
      const release = () => {
        if (released) return;
        removeOwner(directory, ownerName);
        released = true;
        process.removeListener("exit", release);
      };
      process.once("exit", release);
      return { rootPath, release };
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }
};

module.exports = { acquireMirror, LOCK_NAME };
