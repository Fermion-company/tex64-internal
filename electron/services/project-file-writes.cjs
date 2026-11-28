"use strict";

const fs = require("node:fs/promises");
const { constants, lstatSync } = require("node:fs");
const path = require("node:path");
const { tmpdir } = require("node:os");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { createHash, randomUUID } = require("node:crypto");
const { AsyncLocalStorage } = require("node:async_hooks");
const { setTimeout: delay } = require("node:timers/promises");
const { performance } = require("node:perf_hooks");
const {
  temporaryLockDirectory, ensureTemporaryLockDirectory, validateTemporaryLockDirectory, logStorageFailure, LINK_UNSUPPORTED,
} = require("./app-storage.cjs");
const { canonicalPath } = require("./file-identity.cjs");
const { pidAlive, processStartTimeAsync } = require("./workspace-window-lock.cjs");

const WAIT_MS = 750;
const START_TOLERANCE_MS = 5_000;
// A holder touches its lock while it keeps it. An owner whose pid still runs
// but whose lock has been quiet this long is checked against the OS.
const HEARTBEAT_MS = 10_000;
const QUIET_MS = 90_000;
// When the OS cannot say whether a quiet owner is the process that took the
// lock (lookup slow, refused or failed), the lock passes once this process has
// watched it stay quiet this long: a running owner touches it every
// HEARTBEAT_MS, so only a suspended owner can lose it this way.
const UNKNOWN_OWNER_MS = 30_000;
// A recovery file this old belongs to no save still in progress.
const RECOVERY_STALE_MS = 10 * 60_000;
const startedAt = Date.now() - process.uptime() * 1000;
const processToken = randomUUID();
const held = new AsyncLocalStorage();
const tails = new Map();
const quietLocks = new Map();
const activeRecoveries = new Set();
const retainedRecoveries = new Map();
let defaultDirectory = temporaryLockDirectory;

const configureProjectFileLocks = (directory) => { defaultDirectory = directory; };
const fileBusy = (cause) => Object.assign(new Error("Finish the current project operation first.", { cause }), {
  code: "FILE_WRITE_BUSY",
});
const keyOf = (filename) => process.platform === "win32" ? filename.toLowerCase() : filename;
const runFile = promisify(execFile);
const ifMissing = (error) => {
  if (error.code !== "ENOENT") throw error;
  return null;
};

// Every name this writer stages under, the v0.1.32 workspace writer's
// ".<name>.tmp-<pid>-<ms>", and the "._" companion macOS adds to them on
// volumes without native extended attributes.
const STAGE_NAME = /^(?:\._)?(?:\.tex64-(?:write|recovery)\.tmp-\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\..+\.tmp-\d+-\d+)$/;
const RECOVERY_NAME = /^\.tex64-recovery\.tmp-(\d+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isStagingName = (name) => STAGE_NAME.test(String(name ?? "").split(/[\\/]/).pop());

function sharedInodeKey(filename) {
  try {
    const stat = lstatSync(filename, { bigint: true });
    return stat.isFile() && stat.nlink > 1n ? `inode:${stat.dev}:${stat.ino}` : null;
  } catch (error) {
    return ifMissing(error);
  }
}

// Whether the process that wrote a lock (or recovery) record has ended. Never
// waits for the OS longer than `wait`; an unanswered lookup keeps running and
// the next check reuses it.
async function ownerGone(owner, { file, mtimeMs = 0 } = {}, ownership = {}, wait = 0) {
  if (!Number.isInteger(owner?.pid) || owner.pid <= 0 || !Number.isFinite(owner.startedAt) ||
      typeof owner.token !== "string") return false;
  const { isAlive = pidAlive, startTimeOf = processStartTimeAsync, now = Date.now,
    clock = () => performance.now() } = ownership;
  // This pid is ours: the record is this process's own or an earlier one's.
  if (owner.pid === process.pid) return Math.abs(owner.startedAt - startedAt) > START_TOLERANCE_MS;
  if (!isAlive(owner.pid)) return true;
  const touched = Math.max(mtimeMs, Number.isFinite(owner.acquiredAt) ? owner.acquiredAt : 0);
  if (Math.abs(now() - touched) < QUIET_MS) {
    quietLocks.delete(file);
    return false;
  }
  const lookup = Promise.resolve().then(() => startTimeOf(owner.pid)).catch(() => null);
  const start = await Promise.race([lookup, delay(Math.max(0, wait))]);
  if (Number.isFinite(start)) {
    quietLocks.delete(file);
    return Math.abs(start - owner.startedAt) > START_TOLERANCE_MS;
  }
  const seen = quietLocks.get(file);
  if (seen?.token !== owner.token || seen.mtimeMs !== mtimeMs) {
    quietLocks.set(file, { token: owner.token, mtimeMs, since: clock() });
    return false;
  }
  return clock() - seen.since >= UNKNOWN_OWNER_MS;
}

const lockHash = (key) => createHash("sha256").update(key).digest("hex");

async function readRecord(file) {
  const [text, stat] = await Promise.all([fs.readFile(file, "utf8"), fs.stat(file)]);
  return { owner: JSON.parse(text), mtimeMs: stat.mtimeMs };
}

async function hasLiveRecord(hash, directory, validate, ownership, deadline) {
  for (let generation = 0; ; generation += 1) {
    try {
      validate?.(directory);
      const file = path.join(directory, `${hash}.${generation}.lock`);
      const { owner, mtimeMs } = await readRecord(file);
      if (!await ownerGone(owner, { file, mtimeMs }, ownership, deadline - performance.now())) return true;
    } catch (error) {
      // An unreadable namespace cannot protect the write. A readable,
      // malformed record is potential contention.
      return error instanceof SyntaxError;
    }
  }
}

async function acquire(hash, directory, deadline, validate, ownership) {
  const token = randomUUID();
  const candidate = path.join(directory, `${hash}.${token}.tmp`);
  const owner = { pid: process.pid, startedAt, token, acquiredAt: Date.now() };
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  validate?.(directory);
  let backoff = 2;
  let generation = 0;
  try {
    // Prepare the O_EXCL record before publishing it with an exclusive link.
    // A process killed during prepare cannot leave an unreadable held lock.
    await fs.writeFile(candidate, JSON.stringify(owner), { flag: "wx", mode: 0o600 });
    do {
      const lock = path.join(directory, `${hash}.${generation}.lock`);
      try {
        await fs.link(candidate, lock);
        const heartbeat = setInterval(() => {
          const time = new Date();
          fs.utimes(lock, time, time).catch(() => {});
        }, HEARTBEAT_MS);
        heartbeat.unref?.();
        return async () => {
          clearInterval(heartbeat);
          try {
            // The directory may have been removed and recreated meanwhile.
            validate?.(directory);
            if (JSON.parse(await fs.readFile(lock, "utf8")).token === token) await fs.unlink(lock);
          } catch {
            // Already gone, or no longer accessible.
          }
        };
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      let record;
      try {
        validate?.(directory);
        record = await readRecord(lock);
      } catch (error) {
        if (error.code === "ENOENT") {
          await fs.stat(candidate); // directory removal calls for a new storage probe
          continue;
        }
        if (error instanceof SyntaxError) throw fileBusy(error);
        throw error;
      }
      // Leave a dead generation in place. An older contender cannot unlink
      // a successor's lock after another waiter has already taken it over.
      if (await ownerGone(record.owner, { file: lock, mtimeMs: record.mtimeMs }, ownership, deadline - performance.now())) {
        generation += 1;
        continue;
      }
      await delay(Math.min(backoff, Math.max(1, deadline - performance.now())));
      backoff = Math.min(backoff * 2, 30);
    } while (performance.now() < deadline);
    throw fileBusy();
  } finally {
    await fs.unlink(candidate).catch(() => {});
  }
}

async function enqueue(key, operation) {
  const run = (tails.get(key) ?? Promise.resolve()).then(operation);
  const tail = run.then(() => {}, () => {});
  tails.set(key, tail);
  try {
    return await run;
  } finally {
    if (tails.get(key) === tail) tails.delete(key);
  }
}

const ownsKey = (scope, key) => Boolean(scope) && (scope.acquired.has(key) || ownsKey(scope.parent, key));

async function withProjectFileWrites(filenames, operation, {
  directory = defaultDirectory, allowDanglingLinks = false, entryPaths = false, ownership = {},
} = {}) {
  const resolve = (filename) => canonicalPath(filename, { allowDanglingLinks });
  const resolveEntry = (filename) => path.join(resolve(path.dirname(filename)), path.basename(filename));
  const paths = filenames.map(resolve);
  const parent = held.getStore();
  const assertIdentity = (filename, expected) => {
    const name = keyOf(path.resolve(filename));
    for (let scope = parent; scope; scope = scope.parent) {
      const anchored = scope.byName.get(name);
      if (anchored && scope.acquired.has(anchored) && anchored !== keyOf(expected)) {
        throw Object.assign(new Error("Invalid path."), { code: "FILE_WRITE_IDENTITY_CHANGED" });
      }
    }
  };
  paths.forEach((file, i) => assertIdentity(filenames[i], file));
  const entries = entryPaths ? filenames.map(resolveEntry) : [];
  const inodeKeys = paths.map(sharedInodeKey);
  const keys = [...new Set([...paths.map(keyOf), ...entries.map(keyOf), ...inodeKeys.filter(Boolean)])].sort();
  const acquired = new Set();
  const byName = new Map(filenames.map((file, i) => [keyOf(path.resolve(file)), keyOf(paths[i])]));
  const context = { acquired, byName, parent, directory: parent?.directory };
  const pending = keys.filter((key) => !ownsKey(parent, key));
  const lockPending = async () => {
    const fallback = temporaryLockDirectory();
    const validator = (dir) => dir === fallback ? validateTemporaryLockDirectory : null;
    const directories = [...new Set([context.directory, directory(), fallback])].filter(Boolean);
    const hashes = pending.map(lockHash);
    const deadline = performance.now() + WAIT_MS;
    const heldInOtherDirectory = async (selected) => {
      for (const dir of directories) {
        if (dir === selected) continue;
        for (const hash of hashes) {
          if (await hasLiveRecord(hash, dir, validator(dir), ownership, deadline)) return true;
        }
      }
      return false;
    };
    let failure;
    while (performance.now() < deadline) {
      let blocked = false;
      // Acquiring the set probes actual writes and publication on the same
      // volume. A partial acquisition is released before trying the next one.
      for (const candidate of directories) {
        const releases = [];
        let keep = false;
        try {
          if (candidate === fallback) ensureTemporaryLockDirectory(fallback);
          for (const hash of hashes) releases.push(await acquire(hash, candidate, deadline, validator(candidate), ownership));
          // A writer in the alternate namespace can outlast a permissions
          // change. Check after acquiring, so at most one writer can proceed.
          blocked = await heldInOtherDirectory(candidate);
          if (blocked) break;
          context.directory = candidate;
          keep = true;
          return releases;
        } catch (error) {
          if (error.code === "FILE_WRITE_BUSY") throw error;
          failure = error;
        } finally {
          if (!keep) for (const release of releases.reverse()) await release();
        }
      }
      if (!blocked && !await heldInOtherDirectory(null)) {
        logStorageFailure("project write locks", failure);
        return [];
      }
      await delay(15);
    }
    throw fileBusy();
  };
  const run = async (index) => {
    if (index === pending.length) {
      const releases = pending.length ? await lockPending() : [];
      try {
        if (filenames.some((file, i) => keyOf(resolve(file)) !== keyOf(paths[i]) ||
            (entryPaths && keyOf(resolveEntry(file)) !== keyOf(entries[i])) ||
            sharedInodeKey(paths[i]) !== inodeKeys[i])) {
          throw Object.assign(new Error("Invalid path."), { code: "FILE_WRITE_IDENTITY_CHANGED" });
        }
        return await operation(paths);
      } finally {
        for (const release of releases.reverse()) await release();
      }
    }
    const key = pending[index];
    return enqueue(key, async () => {
      acquired.add(key);
      try {
        return await run(index + 1);
      } finally {
        acquired.delete(key);
      }
    });
  };
  return held.run(context, () => run(0));
}

// macOS: one "ls" call lists each file's type, mode, owner, file flags, ACL
// entries and extended attributes with their sizes. com.apple.provenance is
// written by the OS to every new file and cannot be removed by any writer, so
// a replacement cannot keep it either way; everything else must match.
const OS_ATTRIBUTES = new Set(["com.apple.provenance"]);
// File flags that a copy keeps and that do not refuse writing into it.
const COPYABLE_FLAGS = new Set(["hidden", "nodump"]);
const MAX_COPIED_ATTRIBUTE_BYTES = 1024 * 1024;

async function macListings(files) {
  const { stdout } = await runFile("/bin/ls", ["-qldne@O", ...files], {
    env: { ...process.env, LC_ALL: "C" },
    maxBuffer: 1024 * 1024,
  });
  const listed = [];
  for (const line of stdout.split("\n")) {
    const head = /^([-bcdlps])([rwxsStT-]{9})[@+]? +\d+ +(\d+) +(\d+) +(\S+) +\d+ /.exec(line);
    const entry = listed.at(-1);
    const attribute = /^\t(.*)\t *(\d+) *$/.exec(line);
    if (head) {
      listed.push({ line, kind: head[1], mode: head[2], owner: `${head[3]}:${head[4]}`, flags: head[5],
        attributes: [], acl: [], bytes: 0 });
    } else if (entry && attribute) {
      if (OS_ATTRIBUTES.has(attribute[1])) continue;
      entry.attributes.push(`${attribute[1]}\t${attribute[2]}`);
      entry.bytes += Number(attribute[2]);
    } else if (entry && /^ *\d+: /.test(line)) {
      entry.acl.push(line.trim());
    } else if (line) {
      return null;
    }
  }
  return listed;
}

// [destination, stage] listings, or null when the probe is unavailable.
async function macPair(destination, temporary) {
  const listed = await macListings([destination, temporary]).catch(() => null);
  const stage = listed?.find((entry) => entry.line.endsWith(path.basename(temporary)));
  const target = listed?.find((entry) => entry !== stage);
  return listed?.length === 2 && stage && target ? [target, stage] : null;
}

const describe = (entry) =>
  JSON.stringify([entry.kind, entry.mode, entry.owner, entry.flags, [...entry.attributes].sort(), entry.acl]);

// Attribute values, as "xattr -lx" prints them, without the OS's own.
async function attributeValues(file) {
  const { stdout } = await runFile("/usr/bin/xattr", ["-lx", file], { maxBuffer: 16 * 1024 * 1024 });
  const values = [];
  let current = null;
  for (const line of stdout.split("\n")) {
    if (/^[0-9A-F]{8}(?: {2}|$)/.test(line)) {
      current?.push(line);
    } else if (line.endsWith(":")) {
      current = OS_ATTRIBUTES.has(line.slice(0, -1)) ? null : [line];
      if (current) values.push(current);
    } else if (line) {
      return null;
    }
  }
  return JSON.stringify(values.map((value) => value.join("\n")).sort());
}

// Whether renaming the fresh stage over the destination keeps everything a
// person can see about it: true, "clone" when only extended attributes or
// copyable flags are missing from the stage, or false (write in place).
async function macReplacement(destination, temporary) {
  const pair = await macPair(destination, temporary);
  if (!pair) return false;
  const [target, stage] = pair;
  if (describe(target) === describe(stage)) return true;
  const flags = target.flags === "-" ? [] : target.flags.split(",");
  return target.kind === "-" && stage.kind === "-" && target.mode === stage.mode &&
    target.owner === stage.owner && JSON.stringify(target.acl) === JSON.stringify(stage.acl) &&
    flags.every((flag) => COPYABLE_FLAGS.has(flag)) && target.bytes <= MAX_COPIED_ATTRIBUTE_BYTES ? "clone" : false;
}

// Stages the new bytes in a copy of the destination made by cp -c
// (clonefile(2), or copyfile(3) where the volume cannot clone), which carries
// its extended attributes and flags. The copy is used only if its listing and
// every attribute value then match the destination's.
async function cloneMacStage(destination, temporary, original, bytes, permissions, durable) {
  try {
    await runFile("/bin/cp", ["-c", destination, temporary], { maxBuffer: 64 * 1024 });
  } catch {
    return false;
  }
  let staged;
  try {
    staged = await fs.open(temporary, constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return false;
  }
  try {
    const stat = await staged.stat({ bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || stat.dev !== original.dev) return false;
    await staged.truncate(0);
    await staged.writeFile(bytes);
    await staged.chmod(permissions);
    if (durable) await staged.sync();
  } finally {
    await staged.close();
  }
  const [pair, left, right] = await Promise.all([
    macPair(destination, temporary),
    attributeValues(destination).catch(() => null),
    attributeValues(temporary).catch(() => null),
  ]);
  return Boolean(pair) && describe(pair[0]) === describe(pair[1]) && left !== null && left === right;
}

const stagingName = (directory, kind = "write") =>
  path.join(directory, `.tex64-${kind}.tmp-${process.pid}-${randomUUID()}`);
const removeStage = (file) => fs.unlink(file).catch(() => {});
const inaccessibleDirectory = (error) => ["EACCES", "EPERM", "EROFS"].includes(error.code);
const sameInode = (left, right) => left.dev === right.dev && left.ino === right.ino;
const changedFile = () => Object.assign(new Error("Invalid path."), { code: "FILE_WRITE_IDENTITY_CHANGED" });
// The save handler's own wording for this case; the editor waits for the
// outside version instead of reporting a failure.
const changedOnDisk = () => Object.assign(
  new Error("The file changed on disk before this save completed. Your editor buffer was kept."),
  { code: "FILE_SAVE_CONFLICT" },
);
const noFollow = (access) => access | constants.O_NOFOLLOW | constants.O_NONBLOCK;

// Where an in-place write keeps its recovery file: the destination's folder,
// else (a writable file in a read-only folder) the OS temporary folder or a
// writable ancestor on the same volume.
async function* stagingDirectories(directory, device) {
  yield directory;
  const temp = tmpdir();
  if ((await fs.stat(temp, { bigint: true }).catch(() => null))?.dev === device) yield temp;
  for (let child = directory, parent = path.dirname(child); child !== parent;
    child = parent, parent = path.dirname(child)) {
    if ((await fs.stat(parent, { bigint: true }).catch(() => null))?.dev !== device) break;
    yield parent;
  }
}

async function openInPlaceStage(directory, device, kind) {
  let failure;
  for await (const dir of stagingDirectories(directory, device)) {
    const temporary = stagingName(dir, kind);
    try {
      return { temporary, staged: await fs.open(temporary, "wx", 0o600) };
    } catch (error) {
      if (!inaccessibleDirectory(error)) throw error;
      failure ??= error;
    }
  }
  throw failure;
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch {
    // Not supported for folders on every platform (Windows).
  } finally {
    await handle?.close().catch(() => {});
  }
}

const RECOVERY_MAGIC = Buffer.from("TEX64-RECOVERY 1\n");
const digest = (bytes) => ({ size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
const matches = (bytes, expected) =>
  bytes.length === expected?.size && createHash("sha256").update(bytes).digest("hex") === expected.sha256;

// One self-describing file per in-place write: which inode it rewrites, then
// the complete old bytes and the complete new bytes. It is synced before the
// destination is touched, so an interrupted write can always be recognised
// and undone the next time this file is opened or saved.
async function writeRecovery(destination, original, previous, bytes) {
  const header = {
    pid: process.pid, startedAt, owner: processToken, name: path.basename(destination),
    ino: String(original.ino), birthtimeNs: String(original.birthtimeNs ?? 0n),
    old: digest(previous), new: digest(bytes),
  };
  const contents = Buffer.concat([RECOVERY_MAGIC, Buffer.from(`${JSON.stringify(header)}\n`), previous, bytes]);
  const { temporary, staged } = await openInPlaceStage(path.dirname(destination), original.dev, "recovery");
  activeRecoveries.add(temporary);
  try {
    try {
      if ((await staged.stat({ bigint: true })).dev !== original.dev) {
        throw Object.assign(new Error("Could not stage the write on the destination volume."), { code: "EXDEV" });
      }
      await staged.writeFile(contents);
      await staged.sync();
    } finally {
      await staged.close();
    }
    await syncDirectory(path.dirname(temporary));
    return temporary;
  } catch (error) {
    activeRecoveries.delete(temporary);
    await removeStage(temporary);
    throw error;
  }
}

async function openOriginal(destination, original, access) {
  const file = await fs.open(destination, noFollow(access));
  try {
    const stat = await file.stat({ bigint: true });
    if (!stat.isFile() || !sameInode(stat, original)) throw changedFile();
    return file;
  } catch (error) {
    await file.close().catch(() => {});
    throw error;
  }
}

// Whether the destination's name still refers to the open file.
async function namesHandle(destination, file) {
  const [named, opened] = await Promise.all([
    fs.lstat(destination, { bigint: true }).catch(ifMissing),
    file.stat({ bigint: true }),
  ]);
  return Boolean(named) && sameInode(named, opened);
}

async function putInPlace(file, bytes, mode) {
  for (let offset = 0; offset < bytes.length;) {
    const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset, offset);
    if (bytesWritten === 0) throw Object.assign(new Error("Incomplete file write."), { code: "EIO" });
    offset += bytesWritten;
  }
  // Keep the old allocation until the new prefix is complete. Only a
  // shortening write needs to release any of the original blocks.
  let stat = await file.stat();
  if (stat.size !== bytes.length) {
    await file.truncate(bytes.length);
    stat = await file.stat();
  }
  // Writing can clear set-user-ID / set-group-ID bits.
  if ((stat.mode & 0o7777) !== mode) await file.chmod(mode);
  await file.sync();
}

function retainRecovery(destination, recovery) {
  const key = keyOf(destination);
  if (!retainedRecoveries.has(key)) retainedRecoveries.set(key, new Set());
  retainedRecoveries.get(key).add(recovery);
  console.warn("[project write] Recovery copy retained:", recovery);
}

// A later save of the same file by this process supersedes what it kept.
async function dropRetainedRecoveries(destination) {
  const files = retainedRecoveries.get(keyOf(destination));
  if (!files) return;
  retainedRecoveries.delete(keyOf(destination));
  for (const file of files) await removeStage(file);
}

async function overwriteInPlace(destination, bytes, original) {
  if (!original.isFile()) throw changedFile();
  let file = await openOriginal(destination, original, constants.O_WRONLY);
  let recovery;
  let keep = false;
  try {
    const reader = await openOriginal(destination, original, constants.O_RDONLY);
    const previous = await reader.readFile().finally(() => reader.close());
    recovery = await writeRecovery(destination, original, previous, bytes);
    const current = await file.stat({ bigint: true });
    if (current.ctimeNs !== original.ctimeNs) throw changedFile();
    if (!await namesHandle(destination, file)) throw changedOnDisk();
    const mode = Number(original.mode & 0o7777n);
    try {
      await putInPlace(file, bytes, mode);
      if (!await namesHandle(destination, file)) {
        // Another program replaced the file during this write: the bytes
        // reached the inode it moved away. Undo them there and keep them in
        // the recovery file rather than report a save that did not happen.
        keep = true;
        await putInPlace(file, previous, mode).catch(() => {});
        retainRecovery(destination, recovery);
        throw changedOnDisk();
      }
      const closing = file;
      file = null;
      await closing.close();
    } catch (error) {
      if (keep) throw error;
      // Keep the recovery copy until the restoration itself is synced.
      // Close errors may already have released the writable descriptor.
      keep = true;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          file ??= await openOriginal(destination, original, constants.O_WRONLY);
          await putInPlace(file, previous, mode);
          keep = false;
          break;
        } catch {
          // Retry transient failures while still holding the project lock.
        }
      }
      if (keep) retainRecovery(destination, recovery);
      throw error;
    }
  } finally {
    await file?.close().catch(() => {});
    if (recovery) activeRecoveries.delete(recovery);
    if (recovery && !keep) await removeStage(recovery);
  }
}

// Recovery files that may belong to `destination`: those in its folder, and
// in the fallback folders when its folder does not accept new files.
async function recoveryCandidates(destination, device) {
  const directory = path.dirname(destination);
  const directories = [directory];
  if (!await fs.access(directory, constants.W_OK).then(() => true, () => false)) {
    for await (const dir of stagingDirectories(directory, device)) if (!directories.includes(dir)) directories.push(dir);
  }
  const found = [];
  for (const dir of directories) {
    const names = await fs.readdir(dir).catch(() => []);
    for (const name of names) if (RECOVERY_NAME.test(name)) found.push(path.join(dir, name));
  }
  return found.filter((file) => !activeRecoveries.has(file));
}

// The header alone, so that a kept file for another inode costs one small read.
async function readRecoveryHeader(file) {
  let handle;
  try {
    handle = await fs.open(file, noFollow(constants.O_RDONLY));
  } catch (error) {
    return ifMissing(error);
  }
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile()) return null;
    const recovery = { file, dev: stat.dev, size: Number(stat.size), mtimeMs: Number(stat.mtimeMs) };
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(64 * 1024), 0, 64 * 1024, 0);
    const start = buffer.subarray(0, bytesRead);
    const end = start.indexOf(0x0a, RECOVERY_MAGIC.length);
    if (!start.subarray(0, RECOVERY_MAGIC.length).equals(RECOVERY_MAGIC) || end < 0) return recovery;
    let header;
    try {
      header = JSON.parse(start.subarray(RECOVERY_MAGIC.length, end).toString("utf8"));
    } catch {
      return recovery;
    }
    const sizes = [header?.old?.size, header?.new?.size];
    if (!Number.isInteger(header?.pid) || !Number.isFinite(header.startedAt) || typeof header.owner !== "string" ||
        typeof header.ino !== "string" || typeof header.birthtimeNs !== "string" ||
        !sizes.every((size) => Number.isSafeInteger(size) && size >= 0) ||
        end + 1 + sizes[0] + sizes[1] !== recovery.size) return recovery;
    return Object.assign(recovery, { header, offset: end + 1 });
  } finally {
    await handle.close();
  }
}

// Whether nobody can still be writing with this recovery file.
async function recoverySettled(recovery, ownership) {
  if (Date.now() - recovery.mtimeMs > RECOVERY_STALE_MS) return true;
  const { header } = recovery;
  if (!header) {
    // Never completed: the owner's pid is in the name.
    const pid = Number(RECOVERY_NAME.exec(path.basename(recovery.file))?.[1]);
    return pid === process.pid || !(ownership.isAlive ?? pidAlive)(pid);
  }
  if (header.owner === processToken) return true;
  return ownerGone({ pid: header.pid, startedAt: header.startedAt, token: header.owner },
    { file: recovery.file, mtimeMs: recovery.mtimeMs }, ownership, WAIT_MS);
}

// Every byte from the old or the new version at its own offset, with a length
// between the two (blocks past the old end may still read as zeros): what an
// interrupted in-place write can leave, and nothing another program writes.
function interruptedMix(current, previous, proposed) {
  if (current.length < Math.min(previous.length, proposed.length) ||
      current.length > Math.max(previous.length, proposed.length)) return false;
  for (let i = 0; i < current.length; i++) {
    const byte = current[i];
    if (byte !== proposed[i] && byte !== previous[i] && !(i >= previous.length && byte === 0)) return false;
  }
  return true;
}

// Settles one leftover recovery file of `destination` (whose lock is held):
// - never finished (its inode was not touched yet): removed;
// - for another inode, or the file was since changed by someone else: kept;
// - the file holds the complete old or new version: removed;
// - the file holds an interrupted mix: the old version is written back first.
async function settleRecovery(recoveryFile, destination, ownership) {
  const recovery = await readRecoveryHeader(recoveryFile);
  if (!recovery) return;
  if (!recovery.header) {
    if (await recoverySettled(recovery, ownership)) await removeStage(recoveryFile);
    return;
  }
  const { header } = recovery;
  const named = await fs.lstat(destination, { bigint: true }).catch(ifMissing);
  const birth = String(named?.birthtimeNs ?? 0n);
  if (!named?.isFile() || named.dev !== recovery.dev || String(named.ino) !== header.ino ||
      (birth !== "0" && header.birthtimeNs !== "0" && birth !== header.birthtimeNs)) return;
  if (!await recoverySettled(recovery, ownership)) return;
  const contents = await fs.readFile(recoveryFile);
  const previous = contents.subarray(recovery.offset, recovery.offset + header.old.size);
  const proposed = contents.subarray(recovery.offset + header.old.size);
  if (!matches(previous, header.old) || !matches(proposed, header.new)) {
    // Synced before any write: an incomplete copy means nothing was written.
    await removeStage(recoveryFile);
    return;
  }
  const reader = await openOriginal(destination, named, constants.O_RDONLY);
  const current = await reader.readFile().finally(() => reader.close());
  if (!matches(current, header.old) && !matches(current, header.new)) {
    if (!interruptedMix(current, previous, proposed)) return;
    const writer = await openOriginal(destination, named, constants.O_WRONLY);
    try {
      await putInPlace(writer, previous, Number(named.mode & 0o7777n));
    } finally {
      await writer.close().catch(() => {});
    }
  }
  await removeStage(recoveryFile);
}

async function settleRecoveries(destination, ownership = {}) {
  try {
    const named = await fs.lstat(destination, { bigint: true }).catch(ifMissing);
    if (!named?.isFile()) return;
    for (const file of await recoveryCandidates(destination, named.dev)) {
      await settleRecovery(file, destination, ownership);
    }
  } catch (error) {
    console.warn("[project write] Could not check an interrupted save:", error?.message ?? error);
  }
}

// Called before a project file is read. Takes the file's lock only when a
// recovery file is present, and never while holding another file's lock.
async function recoverProjectFile(filename, options = {}) {
  try {
    const destination = canonicalPath(filename);
    const named = await fs.lstat(destination, { bigint: true }).catch(ifMissing);
    if (!named?.isFile() || !(await recoveryCandidates(destination, named.dev)).length) return;
    const parent = held.getStore();
    if (parent && !ownsKey(parent, keyOf(destination))) return;
    await withProjectFileWrites([filename], ([target]) => settleRecoveries(target, options.ownership), options);
  } catch (error) {
    if (error?.code !== "FILE_WRITE_BUSY") {
      console.warn("[project write] Could not check an interrupted save:", error?.message ?? error);
    }
  }
}

// For volumes without hard links: an exclusive create never replaces another
// creator's file, and removes only its own entry if the write fails.
async function createExclusively(destination, bytes, mode) {
  const file = await fs.open(destination, "wx", mode);
  let created;
  try {
    created = await file.stat({ bigint: true });
    await file.writeFile(bytes);
    if (mode !== undefined) await file.chmod(mode);
    await file.sync();
    await file.close();
  } catch (error) {
    await file.close().catch(() => {});
    const named = created && await fs.lstat(destination, { bigint: true }).catch(() => null);
    if (named && sameInode(named, created)) await fs.unlink(destination).catch(() => {});
    throw error;
  }
}

async function writeProjectFile(filename, bytes, {
  mode, exclusive = false, durable = false, projectRoot, ...lockOptions
} = {}) {
  bytes = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return withProjectFileWrites([filename], async ([destination]) => {
    await settleRecoveries(destination, lockOptions.ownership);
    await replaceProjectFile(filename, destination, bytes, { mode, exclusive, durable, projectRoot });
    await dropRetainedRecoveries(destination);
  }, lockOptions);
}

async function replaceProjectFile(filename, destination, bytes, { mode, exclusive, durable, projectRoot }) {
  const directory = path.dirname(destination);
  const stat = await fs.lstat(destination, { bigint: true }).catch(ifMissing);
  if (stat && exclusive) {
    throw Object.assign(new Error("File already exists."), { code: "EEXIST" });
  }
  const overwrite = () => overwriteInPlace(destination, bytes, stat);
  const relative = projectRoot ? path.relative(projectRoot, destination) : "";
  const outside = path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`);
  // A rename cannot keep a second link, a symlink entry or a file outside
  // the project the person chose to overwrite; off macOS the save is in place.
  if (stat && (!stat.isFile() || outside || process.platform !== "darwin" ||
      stat.nlink > 1n || (await fs.lstat(filename)).isSymbolicLink())) {
    return overwrite();
  }
  if (!stat) await fs.mkdir(directory, { recursive: true });
  let temporary = stagingName(directory);
  const permissions = stat ? Number(stat.mode) & 0o7777 : mode;
  let staged;
  try {
    staged = await fs.open(temporary, "wx", permissions);
  } catch (error) {
    if (stat && inaccessibleDirectory(error)) return overwrite();
    throw error;
  }
  try {
    let replace = true;
    try {
      if (stat) {
        const stagedStat = await staged.stat({ bigint: true });
        await staged.chmod(permissions);
        replace = stat.uid === stagedStat.uid && stat.gid === stagedStat.gid &&
          await macReplacement(destination, temporary);
      }
      if (replace === true) {
        await staged.writeFile(bytes);
        if (permissions !== undefined) await staged.chmod(permissions);
        if (durable) await staged.sync();
      }
    } finally {
      await staged.close();
    }
    if (replace === "clone") {
      await removeStage(temporary);
      temporary = stagingName(directory);
      replace = await cloneMacStage(destination, temporary, stat, bytes, permissions, durable);
    }
    if (replace === true) {
      if (stat) {
        const current = await fs.lstat(destination, { bigint: true });
        if (!sameInode(current, stat) || current.ctimeNs !== stat.ctimeNs) throw changedFile();
      }
      try {
        if (!exclusive) {
          await fs.rename(temporary, destination);
          return;
        }
        try {
          await fs.link(temporary, destination);
        } catch (error) {
          if (!LINK_UNSUPPORTED.has(error.code)) throw error;
          await createExclusively(destination, bytes, permissions);
        }
        return;
      } catch (error) {
        if (!stat || !inaccessibleDirectory(error)) throw error;
      }
    }
  } finally {
    await removeStage(temporary);
  }
  await overwrite();
}

module.exports = {
  configureProjectFileLocks, withProjectFileWrites, writeProjectFile, recoverProjectFile, isStagingName, ownerGone,
};
