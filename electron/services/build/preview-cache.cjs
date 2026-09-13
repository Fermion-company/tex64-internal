"use strict";

/**
 * Persistent live-preview artifact cache: storage and validation only.
 *
 * A successful Build leaves more than a PDF behind: SyncTeX, the converged
 * auxiliaries, and the list of files the run read. This module stores those
 * bytes, plus the provenance the caller recorded for them, inside the project
 * at `.tex64/cache/live-preview/<main-key>/` so a later session can look at
 * them again instead of starting from nothing.
 *
 * ## What a cache hit is, and what it is not
 *
 * A hit is a *candidate*. It never establishes that the canonical paper is
 * current, and it never establishes that a resident engine is warm at the
 * caret. The presence of a PDF, its modification time, and the caller's own
 * "I snapshotted the inputs" record are all stored here as plain data; none of
 * them is treated as authority. Before importing a candidate the caller must
 * still prove, on its own:
 *
 *   - that the Build read an immutable input snapshot (or an atomic-inputs
 *     contract with no observation gaps) — this module only replays the hashes
 *     the caller recorded, it cannot witness the compiler's reads;
 *   - that the engine and profile in use are compatible with the recorded ones;
 *   - that no unsaved editor overlay or newer document epoch contradicts the
 *     recorded inputs. Buffers are invisible from here.
 *
 * `candidateClass` reports how far the cache itself got:
 *
 *   - `"reuse-candidate"` — every live check passed and the record carries a
 *     caller-supplied input proof. Nothing in the cache contradicts reuse. It
 *     is still the caller's job to prove reuse is correct.
 *   - `"static-last-good"` — the artifact bytes verified, but something
 *     (changed input, unverified profile, moved project, declared dynamic
 *     input, missing input proof, missing SyncTeX) means these bytes must not
 *     seed canonical authority or SyncTeX anchoring. They may still be shown as
 *     the last-good paper, without any "live ready" claim.
 *
 * `validation.blockers` lists why, using the same code vocabulary as the miss
 * `reason`. This module never decides to skip a Build.
 *
 * Storing SyncTeX is optional; reusing a generation without it is not. A paper
 * with no SyncTeX cannot tie a source position to a page, so it stays
 * `"static-last-good"` behind a `"synctex-missing"` blocker no matter how well
 * the caller's inputs, proof and signatures line up.
 *
 * ## Interface
 *
 *   const cache = require("./preview-cache.cjs");
 *
 *   await cache.savePreviewCacheGeneration({
 *     rootPath, mainFileName: "main.tex",
 *     descriptor: {
 *       profileSignature, engineSignature,
 *       provenance: {
 *         inputProof: "build-fls", // or immutable/atomic contract / none
 *         snapshotId, dynamicInputs: false, unknownInputs: [],
 *         systemInputsStable: true, engine: { ... },
 *       },
 *       inputs: [{ role: "project", path: "chapters/ch1.tex", sha256, bytes },
 *                { role: "external", path: "/usr/.../article.cls", realPath, sha256, bytes }],
 *       artifacts: { pdf: "/staging/main.pdf",
 *                    synctex: "/staging/main.synctex.gz",
 *                    fls: "/staging/main.fls",
 *                    aux: [{ path: "/staging/main.aux", logicalName: "main.aux" }] },
 *       metrics: { pageCount, geometry, syncTexInputMap },
 *     },
 *   });
 *   // -> { saved: true, generationId, directory, candidateClass, bytes, retainedGenerations }
 *   // -> { saved: false, reason, detail }
 *
 *   await cache.loadPreviewCacheCandidate({
 *     rootPath, mainFileName: "main.tex",
 *     expected: { profileSignature, engineSignature },
 *   });
 *   // -> { hit: true, candidateClass, artifacts, metrics, provenance, validation, blockers }
 *   // -> { hit: false, reason, detail, skipped }
 *
 *   await cache.clearPreviewCache({ rootPath, mainFileName });
 *   // -> { cleared: true, removed } | { cleared: false, reason }
 *
 * Nothing here throws for a damaged, hostile or absent cache; every failure is
 * a reason code, so the caller can always fall back to a normal Build.
 *
 * ## Storage rules
 *
 * Artifacts are stored under fixed or hashed `.bin` names so a stray
 * `TEXINPUTS=.//:` can never pick a cached file up as a source, and only a
 * whitelisted auxiliary family is accepted — no `.tex`, `.sty`, `.cls`, `.lua`
 * or anything else TeX would execute or search for. The paper is checked for
 * being a PDF on the way in and on the way out, since a digest only proves the
 * bytes are the stored ones. A generation is written
 * into a temporary directory, fsynced, renamed into place, and only then
 * published by renaming the pointer file; a failure at any point leaves the
 * previous generation and its pointer untouched. One or two generations are
 * retained, under a byte budget. Cleanup only ever removes entries this module
 * named itself, after proving they are real directories inside the project.
 */

const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const path = require("node:path");

const { isPathWithinRoot } = require("./utils.cjs");

const PREVIEW_CACHE_SCHEMA_VERSION = 1;
const PREVIEW_CACHE_RELATIVE_DIR = ".tex64/cache/live-preview";
const CACHE_DIR_SEGMENTS = [".tex64", "cache", "live-preview"];
const MANIFEST_SCHEMA = "tex64.live-preview-cache.manifest";
const POINTER_SCHEMA = "tex64.live-preview-cache.pointer";
const MANIFEST_FILE = "manifest.json";
const POINTER_FILE = "current.json";
const AUX_SUBDIR = "aux";

const MAX_RETAINED_GENERATIONS = 2;
const MAX_ARTIFACTS_PER_GENERATION = 64;
const MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;
const MAX_GENERATION_BYTES = 320 * 1024 * 1024;
const MAX_CACHE_BYTES = 640 * 1024 * 1024;
const MAX_RECORDED_INPUTS = 8192;
const MAX_INPUT_BYTES = 256 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_POINTER_BYTES = 64 * 1024;
const MAX_METRICS_BYTES = 256 * 1024;
const MAX_SIGNATURE_LENGTH = 512;
const MAX_LOGICAL_NAME_LENGTH = 512;
const MAX_UNKNOWN_INPUTS = 64;
const MAX_REPORTED_MISMATCHES = 8;
const READ_CHUNK_BYTES = 1024 * 1024;
const STALE_TEMPORARY_MS = 60 * 60 * 1000;

const GENERATION_DIR_PATTERN = /^gen-[0-9a-f]{32}$/;
const TEMPORARY_DIR_PATTERN = /^\.tmp-[0-9a-f]{32}$/;
const POINTER_TEMPORARY_PATTERN = /^current\.json\.[0-9a-f]{16}\.tmp$/;
const STORED_ARTIFACT_PATTERN = /^(?:pdf\.bin|synctex\.bin|fls\.bin|aux\/[0-9a-f]{32}\.bin)$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const INPUT_PROOFS = new Set(["immutable-snapshot", "atomic-inputs-contract", "build-fls", "none"]);

// Auxiliaries TeX writes and reads back to converge. Deliberately excluded:
// anything TeX would compile or resolve through a search path (.tex, .sty,
// .cls, .def, .cfg, .lua, .bib), index/glossary *style* inputs (.ist, .xdy),
// and logs, which seed nothing.
const AUX_ARTIFACT_SUFFIXES = [
  ".aux", ".toc", ".lof", ".lot", ".loa", ".lol", ".out", ".bbl", ".bcf",
  ".run.xml", ".idx", ".ind", ".glo", ".gls", ".acn", ".acr", ".nav", ".snm",
  ".vrb", ".thm",
];
const SYNCTEX_ARTIFACT_SUFFIXES = [".synctex.gz", ".synctex"];

const PDF_HEADER = Buffer.from("%PDF-");
const PDF_HEADER_WINDOW_BYTES = 1024;

/**
 * The same check the engine applies to a canonical snapshot
 * (`tdom-engine.cjs`): a non-empty file carrying the header somewhere in a
 * conservative leading window. A digest only proves the bytes are the ones
 * that were stored, so an empty or non-PDF blob has to be caught separately —
 * including when a hand-edited manifest agrees with it.
 */
const looksLikePdf = (head, bytes) =>
  bytes > 0
  && Buffer.isBuffer(head)
  && head.subarray(0, PDF_HEADER_WINDOW_BYTES).includes(PDF_HEADER);

const sha256Hex = (value) => crypto.createHash("sha256").update(value).digest("hex");

const randomHex = (bytes) => crypto.randomBytes(bytes).toString("hex");

const lstatOrNull = async (target) => {
  try {
    return await fsp.lstat(target);
  } catch {
    return null;
  }
};

const realPathOrNull = async (target) => {
  try {
    return await fsp.realpath(target);
  } catch {
    return null;
  }
};

const sameFileIdentity = (left, right) => {
  const leftInode = Number(left?.ino);
  const rightInode = Number(right?.ino);
  // Some Windows and network filesystems report no usable inode. The size and
  // digest checks still apply there; only skip the replacement signal.
  if (!(leftInode > 0) || !(rightInode > 0)) return true;
  return Number(left?.dev) === Number(right?.dev) && leftInode === rightInode;
};

/** Directory fsync is what makes a rename durable. Windows has no equivalent. */
const syncDirectory = async (dirPath) => {
  if (process.platform === "win32") return;
  let handle = null;
  try {
    handle = await fsp.open(dirPath, "r");
    await handle.sync();
  } catch {
    // A cache that cannot be fsynced is still usable; it is only a cache.
  } finally {
    await handle?.close().catch(() => {});
  }
};

const writeFileDurably = async (filePath, contents) => {
  const handle = await fsp.open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
};

/**
 * Reads a regular file once, digesting it and optionally copying it. Symlinks,
 * directories and oversized files are refused rather than followed, and a file
 * that changes under the read is reported instead of half-trusted.
 */
const readRegularFile = async (filePath, maxBytes, destinationPath = null) => {
  const stats = await lstatOrNull(filePath);
  if (!stats) return { ok: false, reason: "missing" };
  if (stats.isSymbolicLink() || !stats.isFile()) return { ok: false, reason: "not-regular-file" };
  if (stats.size > maxBytes) return { ok: false, reason: "too-large" };
  let source = null;
  let destination = null;
  try {
    source = await fsp.open(filePath, "r");
    const opened = await source.stat();
    if (!opened.isFile() || opened.size !== stats.size || !sameFileIdentity(opened, stats)) {
      return { ok: false, reason: "changed-while-reading" };
    }
    if (destinationPath) destination = await fsp.open(destinationPath, "wx", 0o600);
    const hash = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    const headChunks = [];
    let headBytes = 0;
    let total = 0;
    let destinationOffset = 0;
    while (true) {
      const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > stats.size) return { ok: false, reason: "changed-while-reading" };
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      if (destination) {
        let chunkOffset = 0;
        while (chunkOffset < chunk.length) {
          const { bytesWritten } = await destination.write(
            chunk,
            chunkOffset,
            chunk.length - chunkOffset,
            destinationOffset
          );
          if (!Number.isInteger(bytesWritten) || bytesWritten <= 0) {
            throw new Error("Cache artifact write made no progress.");
          }
          chunkOffset += bytesWritten;
          destinationOffset += bytesWritten;
        }
      }
      if (headBytes < PDF_HEADER_WINDOW_BYTES) {
        // The read buffer is reused, so the leading window has to be copied.
        const slice = chunk.subarray(0, PDF_HEADER_WINDOW_BYTES - headBytes);
        headChunks.push(Buffer.from(slice));
        headBytes += slice.length;
      }
    }
    if (total !== stats.size) return { ok: false, reason: "changed-while-reading" };
    if (destination) await destination.sync();
    const after = await lstatOrNull(filePath);
    if (!after || after.size !== stats.size || !sameFileIdentity(after, stats)) {
      return { ok: false, reason: "changed-while-reading" };
    }
    return {
      ok: true,
      sha256: hash.digest("hex"),
      bytes: total,
      head: Buffer.concat(headChunks),
      // Recorded for diagnosis only. Identity is decided by content digests.
      mtimeMs: Number(stats.mtimeMs) || 0,
    };
  } catch {
    return { ok: false, reason: "unreadable" };
  } finally {
    await source?.close().catch(() => {});
    await destination?.close().catch(() => {});
  }
};

const normalizeRelativePosixPath = (value) => {
  if (typeof value !== "string") return null;
  const raw = value.trim().split("\\").join("/");
  if (!raw || raw.startsWith("/") || /^[a-zA-Z]:\//.test(raw)) return null;
  const segments = raw.split("/").filter((segment) => segment && segment !== ".");
  if (!segments.length || segments.some((segment) => segment === "..")) return null;
  const joined = segments.join("/");
  // Control characters never appear in a TeX project path we wrote ourselves.
  return /[\u0000-\u001f]/.test(joined) ? null : joined;
};

const matchesSuffix = (name, suffixes) => {
  const lower = name.toLowerCase();
  return suffixes.some((suffix) => lower.endsWith(suffix) && lower.length > suffix.length);
};

/**
 * Walks one cache directory level, proving it is a plain directory that stays
 * inside the project. A symlink anywhere on the chain fails instead of being
 * followed, so a cache path can never reach outside the workspace.
 */
const resolveCacheChild = async (parentRealPath, projectRealPath, name, create) => {
  const target = path.join(parentRealPath, name);
  const stats = await lstatOrNull(target);
  if (stats && (stats.isSymbolicLink() || !stats.isDirectory())) {
    return { ok: false, reason: "cache-path-unsafe" };
  }
  if (!stats) {
    if (!create) return { ok: false, reason: "cache-missing" };
    try {
      await fsp.mkdir(target, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") return { ok: false, reason: "cache-not-writable" };
    }
  }
  const realPath = await realPathOrNull(target);
  if (!realPath || realPath !== target || !isPathWithinRoot(projectRealPath, realPath)) {
    return { ok: false, reason: "cache-path-escapes-project" };
  }
  return { ok: true, realPath };
};

const resolvePreviewCacheDirectory = async (rootPath, mainFileName, create) => {
  if (typeof rootPath !== "string" || !rootPath.trim()) {
    return { ok: false, reason: "invalid-arguments", detail: "A project root is required." };
  }
  const mainRelativePath = normalizeRelativePosixPath(mainFileName);
  if (!mainRelativePath) {
    return { ok: false, reason: "invalid-arguments", detail: "A project-relative main file is required." };
  }
  const projectRealPath = await realPathOrNull(path.resolve(rootPath));
  if (!projectRealPath) {
    return { ok: false, reason: "project-unavailable", detail: "The project root could not be resolved." };
  }
  const projectStats = await lstatOrNull(projectRealPath);
  if (!projectStats?.isDirectory()) {
    return { ok: false, reason: "project-unavailable", detail: "The project root is not a directory." };
  }
  const mainKey = sha256Hex(mainRelativePath).slice(0, 32);
  let current = projectRealPath;
  for (const segment of [...CACHE_DIR_SEGMENTS, mainKey]) {
    const step = await resolveCacheChild(current, projectRealPath, segment, create);
    if (!step.ok) return step;
    current = step.realPath;
  }
  return { ok: true, projectRealPath, cacheRealPath: current, mainKey, mainRelativePath };
};

const boundedJsonValue = (value, maxBytes) => {
  if (value === undefined || value === null) return { ok: true, value: null };
  let serialized = null;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return { ok: false };
  }
  if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > maxBytes) {
    return { ok: false };
  }
  return { ok: true, value: JSON.parse(serialized) };
};

const normalizeSignature = (value) => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_SIGNATURE_LENGTH) return null;
  return trimmed;
};

const normalizeInputRecords = (inputs) => {
  if (!Array.isArray(inputs)) return { ok: false, detail: "inputs must be an array." };
  if (inputs.length > MAX_RECORDED_INPUTS) return { ok: false, detail: "Too many recorded inputs." };
  const records = [];
  const seen = new Map();
  for (const entry of inputs) {
    const role = entry?.role === "external" ? "external" : entry?.role === "project" ? "project" : null;
    if (!role) return { ok: false, detail: "Each input needs role \"project\" or \"external\"." };
    const sha256 = typeof entry?.sha256 === "string" ? entry.sha256.toLowerCase() : "";
    if (!SHA256_PATTERN.test(sha256)) return { ok: false, detail: "Each input needs a sha256 digest." };
    const bytes = Number(entry?.bytes);
    if (!Number.isInteger(bytes) || bytes < 0) return { ok: false, detail: "Each input needs a byte count." };
    let recordPath = null;
    let realPath = null;
    if (role === "project") {
      recordPath = normalizeRelativePosixPath(entry?.path);
      if (!recordPath) return { ok: false, detail: "Project inputs need a project-relative path." };
    } else {
      recordPath = typeof entry?.path === "string" ? entry.path.trim() : "";
      if (!recordPath || !path.isAbsolute(recordPath)) {
        return { ok: false, detail: "External inputs need an absolute path." };
      }
      recordPath = path.resolve(recordPath);
      realPath = typeof entry?.realPath === "string" && path.isAbsolute(entry.realPath)
        ? path.resolve(entry.realPath)
        : recordPath;
    }
    const key = `${role}:${recordPath}`;
    const previous = seen.get(key);
    if (previous) {
      if (previous.sha256 !== sha256) {
        return { ok: false, detail: "The same input was recorded with two different digests." };
      }
      continue;
    }
    const record = { role, path: recordPath, sha256, bytes };
    if (realPath) record.realPath = realPath;
    const mtimeMs = Number(entry?.mtimeMs);
    if (Number.isFinite(mtimeMs) && mtimeMs > 0) record.mtimeMs = mtimeMs;
    seen.set(key, record);
    records.push(record);
  }
  return { ok: true, records };
};

const normalizeArtifactRequest = (entry, kind) => {
  const source = typeof entry === "string" ? { path: entry } : entry;
  const filePath = typeof source?.path === "string" ? source.path.trim() : "";
  if (!filePath || !path.isAbsolute(filePath)) {
    return { ok: false, detail: `The ${kind} artifact needs an absolute path.` };
  }
  const logicalRaw = typeof source?.logicalName === "string" && source.logicalName.trim()
    ? source.logicalName
    : path.basename(filePath);
  const logicalName = normalizeRelativePosixPath(logicalRaw);
  if (!logicalName || logicalName.length > MAX_LOGICAL_NAME_LENGTH) {
    return { ok: false, detail: `The ${kind} artifact has an unusable name.` };
  }
  const baseName = logicalName.split("/").pop();
  if (kind === "pdf" && !matchesSuffix(baseName, [".pdf"])) {
    return { ok: false, detail: "The PDF artifact must be a .pdf file." };
  }
  if (kind === "synctex" && !matchesSuffix(baseName, SYNCTEX_ARTIFACT_SUFFIXES)) {
    return { ok: false, detail: "The SyncTeX artifact must be .synctex or .synctex.gz." };
  }
  if (kind === "fls" && !matchesSuffix(baseName, [".fls"])) {
    return { ok: false, detail: "The recorder artifact must be a .fls file." };
  }
  if (kind === "aux" && !matchesSuffix(baseName, AUX_ARTIFACT_SUFFIXES)) {
    return { ok: false, detail: `"${logicalName}" is not a cacheable auxiliary artifact.` };
  }
  const storedName = kind === "aux"
    ? `${AUX_SUBDIR}/${sha256Hex(logicalName).slice(0, 32)}.bin`
    : `${kind}.bin`;
  return { ok: true, value: { kind, logicalName, storedName, sourcePath: path.resolve(filePath) } };
};

const normalizeArtifactRequests = (artifacts) => {
  if (!artifacts || typeof artifacts !== "object") {
    return { ok: false, detail: "An artifact set is required." };
  }
  const requests = [];
  const pdf = normalizeArtifactRequest(artifacts.pdf, "pdf");
  if (!pdf.ok) return pdf;
  requests.push(pdf.value);
  if (artifacts.synctex !== undefined && artifacts.synctex !== null) {
    const synctex = normalizeArtifactRequest(artifacts.synctex, "synctex");
    if (!synctex.ok) return synctex;
    requests.push(synctex.value);
  }
  if (artifacts.fls !== undefined && artifacts.fls !== null) {
    const fls = normalizeArtifactRequest(artifacts.fls, "fls");
    if (!fls.ok) return fls;
    requests.push(fls.value);
  }
  const auxEntries = Array.isArray(artifacts.aux) ? artifacts.aux : [];
  const storedNames = new Set(requests.map((request) => request.storedName));
  for (const entry of auxEntries) {
    const aux = normalizeArtifactRequest(entry, "aux");
    if (!aux.ok) return aux;
    if (storedNames.has(aux.value.storedName)) continue;
    storedNames.add(aux.value.storedName);
    requests.push(aux.value);
  }
  if (requests.length > MAX_ARTIFACTS_PER_GENERATION) {
    return { ok: false, detail: "Too many artifacts for one cached generation." };
  }
  return { ok: true, requests };
};

const normalizeDescriptor = (descriptor) => {
  if (!descriptor || typeof descriptor !== "object") {
    return { ok: false, reason: "invalid-arguments", detail: "A descriptor is required." };
  }
  const profileSignature = normalizeSignature(descriptor.profileSignature);
  const engineSignature = normalizeSignature(descriptor.engineSignature);
  if (!profileSignature || !engineSignature) {
    return {
      ok: false,
      reason: "invalid-arguments",
      detail: "A profile signature and an engine signature are required.",
    };
  }
  const rawProvenance = descriptor.provenance ?? {};
  const inputProof = INPUT_PROOFS.has(rawProvenance.inputProof) ? rawProvenance.inputProof : "none";
  const snapshotId = typeof rawProvenance.snapshotId === "string" && rawProvenance.snapshotId.trim()
    ? rawProvenance.snapshotId.trim().slice(0, MAX_SIGNATURE_LENGTH)
    : null;
  const unknownInputs = Array.isArray(rawProvenance.unknownInputs)
    ? rawProvenance.unknownInputs
      .filter((value) => typeof value === "string" && value.trim())
      .slice(0, MAX_UNKNOWN_INPUTS)
      .map((value) => value.trim().slice(0, 1024))
    : [];
  const engineDetails = boundedJsonValue(rawProvenance.engine, MAX_METRICS_BYTES);
  if (!engineDetails.ok) {
    return { ok: false, reason: "invalid-arguments", detail: "The engine record is not storable." };
  }
  const metrics = boundedJsonValue(descriptor.metrics, MAX_METRICS_BYTES);
  if (!metrics.ok) {
    return { ok: false, reason: "invalid-arguments", detail: "The metrics record is not storable." };
  }
  const inputs = normalizeInputRecords(descriptor.inputs ?? []);
  if (!inputs.ok) return { ok: false, reason: "invalid-arguments", detail: inputs.detail };
  const artifacts = normalizeArtifactRequests(descriptor.artifacts);
  if (!artifacts.ok) return { ok: false, reason: "invalid-arguments", detail: artifacts.detail };

  // The proof string is recorded caller data, not a trust flag: it can only
  // hold a record back to static last-good, never vouch for anything.
  // SyncTeX is optional to store but not optional to reuse: without it there
  // is no source-to-page correspondence, so the paper stays last-good only.
  const candidateClass =
    inputProof !== "none"
    && rawProvenance.dynamicInputs !== true
    && rawProvenance.systemInputsStable === true
    && unknownInputs.length === 0
    && inputs.records.length > 0
    && artifacts.requests.some((request) => request.kind === "synctex")
    && artifacts.requests.some((request) => request.kind === "fls")
      ? "reuse-candidate"
      : "static-last-good";

  return {
    ok: true,
    value: {
      profileSignature,
      engineSignature,
      candidateClass,
      provenance: {
        inputProof,
        snapshotId,
        dynamicInputs: rawProvenance.dynamicInputs === true,
        unknownInputs,
        systemInputsStable: rawProvenance.systemInputsStable === true,
        engine: engineDetails.value,
      },
      metrics: metrics.value,
      inputs: inputs.records,
      artifactRequests: artifacts.requests,
    },
  };
};

const isOwnedCacheEntryName = (name) =>
  GENERATION_DIR_PATTERN.test(name) || TEMPORARY_DIR_PATTERN.test(name);

/** Removes one directory this module named, after proving it owns it. */
const removeOwnedDirectory = async (cacheRealPath, name) => {
  if (!isOwnedCacheEntryName(name)) return false;
  const target = path.join(cacheRealPath, name);
  const stats = await lstatOrNull(target);
  if (!stats || stats.isSymbolicLink() || !stats.isDirectory()) return false;
  if ((await realPathOrNull(target)) !== target) return false;
  try {
    await fsp.rm(target, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
};

const listCacheEntries = async (cacheRealPath) => {
  try {
    return await fsp.readdir(cacheRealPath, { withFileTypes: true });
  } catch {
    return [];
  }
};

/** Sweeps abandoned temporaries from an interrupted publish. */
const removeStaleTemporaries = async (cacheRealPath, keepName) => {
  const now = Date.now();
  for (const entry of await listCacheEntries(cacheRealPath)) {
    const name = entry.name;
    if (name === keepName) continue;
    const isTemporaryDir = TEMPORARY_DIR_PATTERN.test(name);
    const isTemporaryPointer = POINTER_TEMPORARY_PATTERN.test(name);
    if (!isTemporaryDir && !isTemporaryPointer) continue;
    const target = path.join(cacheRealPath, name);
    const stats = await lstatOrNull(target);
    if (!stats || stats.isSymbolicLink()) continue;
    if (now - (Number(stats.mtimeMs) || 0) < STALE_TEMPORARY_MS) continue;
    if (isTemporaryDir) {
      await removeOwnedDirectory(cacheRealPath, name);
      continue;
    }
    if (!stats.isFile()) continue;
    try {
      await fsp.unlink(target);
    } catch {
      // The next save tries again.
    }
  }
};

const readPointer = async (cacheRealPath) => {
  const pointerPath = path.join(cacheRealPath, POINTER_FILE);
  const stats = await lstatOrNull(pointerPath);
  if (!stats) return { ok: false, reason: "cache-empty" };
  if (stats.isSymbolicLink() || !stats.isFile()) return { ok: false, reason: "pointer-unsafe" };
  if (stats.size > MAX_POINTER_BYTES) return { ok: false, reason: "pointer-invalid" };
  let parsed = null;
  try {
    parsed = JSON.parse(await fsp.readFile(pointerPath, "utf8"));
  } catch {
    return { ok: false, reason: "pointer-unreadable" };
  }
  if (parsed?.schema !== POINTER_SCHEMA || parsed?.schemaVersion !== PREVIEW_CACHE_SCHEMA_VERSION) {
    return { ok: false, reason: "schema-unsupported" };
  }
  if (!Array.isArray(parsed.generations)) return { ok: false, reason: "pointer-invalid" };
  const entries = [];
  for (const entry of parsed.generations.slice(0, MAX_RETAINED_GENERATIONS)) {
    if (!GENERATION_DIR_PATTERN.test(entry?.id ?? "")) continue;
    if (!SHA256_PATTERN.test(entry?.manifestSha256 ?? "")) continue;
    entries.push({
      id: entry.id,
      manifestSha256: entry.manifestSha256,
      bytes: Number.isInteger(entry?.bytes) && entry.bytes >= 0 ? entry.bytes : 0,
      createdAt: typeof entry?.createdAt === "string" ? entry.createdAt : null,
    });
  }
  if (!entries.length) return { ok: false, reason: "pointer-invalid" };
  return { ok: true, entries };
};

const publishPointer = async (cacheRealPath, mainKey, entries) => {
  const pointerPath = path.join(cacheRealPath, POINTER_FILE);
  const temporaryPath = path.join(cacheRealPath, `${POINTER_FILE}.${randomHex(8)}.tmp`);
  const value = {
    schema: POINTER_SCHEMA,
    schemaVersion: PREVIEW_CACHE_SCHEMA_VERSION,
    mainKey,
    updatedAt: new Date().toISOString(),
    generations: entries,
  };
  try {
    await writeFileDurably(temporaryPath, JSON.stringify(value));
    await fsp.rename(temporaryPath, pointerPath);
    await syncDirectory(cacheRealPath);
    return true;
  } catch {
    try {
      await fsp.unlink(temporaryPath);
    } catch {
      // Swept by removeStaleTemporaries on a later save.
    }
    return false;
  }
};

const readGenerationManifest = async (cacheRealPath, entry) => {
  const generationDir = path.join(cacheRealPath, entry.id);
  const dirStats = await lstatOrNull(generationDir);
  if (!dirStats) return { ok: false, reason: "generation-missing" };
  if (dirStats.isSymbolicLink() || !dirStats.isDirectory()) {
    return { ok: false, reason: "generation-unsafe" };
  }
  if ((await realPathOrNull(generationDir)) !== generationDir) {
    return { ok: false, reason: "generation-unsafe" };
  }
  const manifestPath = path.join(generationDir, MANIFEST_FILE);
  const manifestStats = await lstatOrNull(manifestPath);
  if (!manifestStats) return { ok: false, reason: "manifest-missing" };
  if (manifestStats.isSymbolicLink() || !manifestStats.isFile()) {
    return { ok: false, reason: "manifest-unsafe" };
  }
  if (manifestStats.size > MAX_MANIFEST_BYTES) return { ok: false, reason: "manifest-invalid" };
  let raw = null;
  try {
    raw = await fsp.readFile(manifestPath);
  } catch {
    return { ok: false, reason: "manifest-unreadable" };
  }
  if (sha256Hex(raw) !== entry.manifestSha256) return { ok: false, reason: "manifest-hash-mismatch" };
  let manifest = null;
  try {
    manifest = JSON.parse(raw.toString("utf8"));
  } catch {
    return { ok: false, reason: "manifest-invalid" };
  }
  if (manifest?.schema !== MANIFEST_SCHEMA || manifest?.schemaVersion !== PREVIEW_CACHE_SCHEMA_VERSION) {
    return { ok: false, reason: "schema-unsupported" };
  }
  if (manifest.generationId !== entry.id) return { ok: false, reason: "manifest-invalid" };
  if (!Array.isArray(manifest.artifacts) || !manifest.artifacts.length) {
    return { ok: false, reason: "manifest-invalid" };
  }
  if (!Array.isArray(manifest.inputs)) return { ok: false, reason: "manifest-invalid" };
  return { ok: true, manifest, generationDir };
};

/** Re-hashes every stored artifact. Tampered or truncated bytes are a miss. */
const verifyStoredArtifacts = async (generationDir, manifest) => {
  if (manifest.artifacts.length > MAX_ARTIFACTS_PER_GENERATION) {
    return { ok: false, reason: "manifest-invalid" };
  }
  const verified = { pdf: null, synctex: null, fls: null, aux: [] };
  for (const record of manifest.artifacts) {
    const storedName = typeof record?.storedName === "string" ? record.storedName : "";
    const logicalName = normalizeRelativePosixPath(record?.logicalName);
    if (!STORED_ARTIFACT_PATTERN.test(storedName) || !logicalName) {
      return { ok: false, reason: "manifest-invalid" };
    }
    if (!SHA256_PATTERN.test(record?.sha256 ?? "")) return { ok: false, reason: "manifest-invalid" };
    const filePath = path.join(generationDir, ...storedName.split("/"));
    const read = await readRegularFile(filePath, MAX_ARTIFACT_BYTES);
    if (!read.ok) {
      return { ok: false, reason: `artifact-${read.reason}`, detail: logicalName };
    }
    if (read.bytes !== record.bytes || read.sha256 !== record.sha256) {
      return { ok: false, reason: "artifact-hash-mismatch", detail: logicalName };
    }
    if (record.kind === "pdf" && !looksLikePdf(read.head, read.bytes)) {
      // A manifest can be rewritten to agree with whatever bytes are present,
      // so the stored paper is checked for itself rather than on the digest's
      // word. Not usable as last-good either.
      return { ok: false, reason: "artifact-not-a-pdf", detail: logicalName };
    }
    const entry = { logicalName, filePath, sha256: read.sha256, bytes: read.bytes };
    if (record.kind === "pdf") verified.pdf = entry;
    else if (record.kind === "synctex") verified.synctex = entry;
    else if (record.kind === "fls") verified.fls = entry;
    else if (record.kind === "aux") verified.aux.push(entry);
    else return { ok: false, reason: "manifest-invalid" };
  }
  if (!verified.pdf) return { ok: false, reason: "artifact-missing", detail: "pdf" };
  return { ok: true, artifacts: verified };
};

/**
 * Compares every recorded input against the bytes on disk now. Sizes are a
 * cheap pre-filter; identity is always decided by the digest, never by mtime.
 */
const verifyRecordedInputs = async (projectRealPath, inputs) => {
  const mismatches = [];
  let checked = 0;
  let truncated = false;
  for (const record of inputs) {
    if (mismatches.length >= MAX_REPORTED_MISMATCHES) {
      // Already disqualified. The remaining inputs are left unread rather than
      // hashed for a longer list nobody acts on.
      truncated = true;
      break;
    }
    checked += 1;
    const role = record?.role === "external" ? "external" : "project";
    const recordedPath = typeof record?.path === "string" ? record.path : "";
    const note = (reason) => mismatches.push({ role, path: recordedPath, reason });
    if (!recordedPath || !SHA256_PATTERN.test(record?.sha256 ?? "")) {
      note("input-record-invalid");
      continue;
    }
    let realPath = null;
    if (role === "project") {
      const relative = normalizeRelativePosixPath(recordedPath);
      if (!relative) {
        note("input-record-invalid");
        continue;
      }
      realPath = await realPathOrNull(path.join(projectRealPath, ...relative.split("/")));
      if (!realPath) {
        note("input-missing");
        continue;
      }
      if (!isPathWithinRoot(projectRealPath, realPath)) {
        note("input-escapes-project");
        continue;
      }
    } else {
      if (!path.isAbsolute(recordedPath)) {
        note("input-record-invalid");
        continue;
      }
      realPath = await realPathOrNull(recordedPath);
      if (!realPath) {
        note("input-missing");
        continue;
      }
      if (typeof record.realPath === "string" && record.realPath && realPath !== record.realPath) {
        note("input-path-changed");
        continue;
      }
    }
    const read = await readRegularFile(realPath, MAX_INPUT_BYTES);
    if (!read.ok) {
      note(read.reason === "missing" ? "input-missing" : `input-${read.reason}`);
      continue;
    }
    if (Number.isInteger(record.bytes) && read.bytes !== record.bytes) {
      note("input-size-changed");
      continue;
    }
    if (read.sha256 !== record.sha256) note("input-content-changed");
  }
  return { matched: mismatches.length === 0, mismatches, checked, truncated };
};

const buildCandidate = ({ entry, manifest, generationDir, artifacts, inputCheck, expected, projectRealPath }) => {
  const provenance = manifest.provenance ?? {};
  const inputProof = INPUT_PROOFS.has(provenance.inputProof) ? provenance.inputProof : "none";
  const unknownInputs = Array.isArray(provenance.unknownInputs) ? provenance.unknownInputs : [];
  const expectedProfile = normalizeSignature(expected?.profileSignature);
  const expectedEngine = normalizeSignature(expected?.engineSignature);
  const profileMatched = expectedProfile ? expectedProfile === manifest.profileSignature : null;
  const engineMatched = expectedEngine ? expectedEngine === manifest.engineSignature : null;
  const rootPathUnchanged = manifest.rootRealPath === projectRealPath;
  const recordedClass = manifest.candidateClass === "reuse-candidate" ? "reuse-candidate" : "static-last-good";

  const blockers = [];
  // A cached paper with no SyncTeX cannot anchor a source position to a page,
  // so it never qualifies as a reuse candidate however well everything else
  // the caller recorded lines up.
  if (!artifacts.synctex) blockers.push("synctex-missing");
  if (!artifacts.fls) blockers.push("fls-missing");
  if (!manifest.inputs.length) blockers.push("no-input-record");
  else if (!inputCheck.matched) blockers.push("input-mismatch");
  if (profileMatched === false) blockers.push("profile-mismatch");
  if (profileMatched === null) blockers.push("profile-unverified");
  if (engineMatched === false) blockers.push("engine-mismatch");
  if (engineMatched === null) blockers.push("engine-unverified");
  if (!rootPathUnchanged) blockers.push("project-path-changed");
  if (inputProof === "none") blockers.push("input-proof-absent");
  if (provenance.dynamicInputs === true) blockers.push("dynamic-inputs-declared");
  if (unknownInputs.length > 0) blockers.push("unknown-inputs-recorded");
  if (recordedClass !== "reuse-candidate" && !blockers.includes("recorded-as-static-last-good")) {
    blockers.push("recorded-as-static-last-good");
  }

  return {
    hit: true,
    generationId: entry.id,
    createdAt: typeof manifest.createdAt === "string" ? manifest.createdAt : null,
    directory: generationDir,
    candidateClass: blockers.length === 0 ? "reuse-candidate" : "static-last-good",
    artifacts,
    inputs: manifest.inputs.map((record) => ({ ...record })),
    metrics: manifest.metrics ?? null,
    provenance: {
      inputProof,
      snapshotId: typeof provenance.snapshotId === "string" ? provenance.snapshotId : null,
      dynamicInputs: provenance.dynamicInputs === true,
      unknownInputs: [...unknownInputs],
      systemInputsStable: provenance.systemInputsStable === true,
      engine: provenance.engine ?? null,
      profileSignature: manifest.profileSignature,
      engineSignature: manifest.engineSignature,
      rootRealPath: typeof manifest.rootRealPath === "string" ? manifest.rootRealPath : null,
      mainFileName: typeof manifest.mainFileName === "string" ? manifest.mainFileName : null,
    },
    validation: {
      schemaVersion: PREVIEW_CACHE_SCHEMA_VERSION,
      manifestVerified: true,
      // Every stored artifact was re-hashed, and the paper also had to look
      // like a PDF rather than merely match its recorded digest.
      artifactsVerified: true,
      artifactCount: 1 + (artifacts.synctex ? 1 : 0) + (artifacts.fls ? 1 : 0) + artifacts.aux.length,
      synctexPresent: Boolean(artifacts.synctex),
      inputsRecorded: manifest.inputs.length,
      inputsChecked: inputCheck.checked,
      inputsMatched: manifest.inputs.length > 0 && inputCheck.matched,
      inputMismatches: inputCheck.mismatches,
      inputMismatchesTruncated: inputCheck.truncated,
      profileMatched,
      engineMatched,
      rootPathUnchanged,
      inputProof,
      // The proof string came from the caller's own record of the Build. This
      // module cannot witness what the compiler read.
      inputProofSuppliedByCaller: inputProof !== "none",
      dynamicInputsDeclared: provenance.dynamicInputs === true,
      unknownInputCount: unknownInputs.length,
      // Constant, and deliberately so: a cache hit is never evidence that the
      // canonical paper is current or that a resident engine is warm.
      establishesCanonicalCurrent: false,
      establishesResidentReadiness: false,
    },
    blockers,
  };
};

/**
 * Stores one Build's artifacts and the provenance the caller recorded for
 * them. The generation is written to a temporary directory, renamed into
 * place, and published by renaming the pointer: any failure leaves the
 * previous generation and its pointer exactly as they were.
 *
 * `descriptor.inputs` must list every file the Build read, including files
 * outside the project, each with the digest of the bytes the Build actually
 * used. Build outputs must not be listed as inputs. A descriptor without an
 * input proof, with declared dynamic inputs, or with unknown inputs is stored
 * as `"static-last-good"` rather than refused.
 *
 * @returns {Promise<{saved: true, generationId: string, directory: string,
 *   candidateClass: string, bytes: number, retainedGenerations: number}
 *   | {saved: false, reason: string, detail?: string}>}
 */
const savePreviewCacheGeneration = async ({ rootPath, mainFileName, descriptor } = {}) => {
  const normalized = normalizeDescriptor(descriptor);
  if (!normalized.ok) return { saved: false, reason: normalized.reason, detail: normalized.detail };
  const located = await resolvePreviewCacheDirectory(rootPath, mainFileName, true);
  if (!located.ok) return { saved: false, reason: located.reason, detail: located.detail };
  const { cacheRealPath, projectRealPath, mainKey, mainRelativePath } = located;
  const value = normalized.value;

  const generationId = `gen-${randomHex(16)}`;
  const temporaryName = `.tmp-${randomHex(16)}`;
  const temporaryDir = path.join(cacheRealPath, temporaryName);
  await removeStaleTemporaries(cacheRealPath, temporaryName);

  let published = false;
  try {
    await fsp.mkdir(temporaryDir, { mode: 0o700 });
    if ((await realPathOrNull(temporaryDir)) !== temporaryDir) {
      return { saved: false, reason: "cache-path-escapes-project" };
    }
    if (value.artifactRequests.some((request) => request.kind === "aux")) {
      await fsp.mkdir(path.join(temporaryDir, AUX_SUBDIR), { mode: 0o700 });
    }

    const artifacts = [];
    let totalBytes = 0;
    for (const request of value.artifactRequests) {
      const destination = path.join(temporaryDir, ...request.storedName.split("/"));
      const read = await readRegularFile(request.sourcePath, MAX_ARTIFACT_BYTES, destination);
      if (!read.ok) {
        return { saved: false, reason: `artifact-${read.reason}`, detail: request.logicalName };
      }
      if (request.kind === "pdf" && !looksLikePdf(read.head, read.bytes)) {
        return { saved: false, reason: "artifact-not-a-pdf", detail: request.logicalName };
      }
      totalBytes += read.bytes;
      if (totalBytes > MAX_GENERATION_BYTES) {
        return { saved: false, reason: "artifact-budget-exceeded", detail: request.logicalName };
      }
      artifacts.push({
        kind: request.kind,
        logicalName: request.logicalName,
        storedName: request.storedName,
        sha256: read.sha256,
        bytes: read.bytes,
      });
    }

    const manifest = {
      schema: MANIFEST_SCHEMA,
      schemaVersion: PREVIEW_CACHE_SCHEMA_VERSION,
      generationId,
      createdAt: new Date().toISOString(),
      mainKey,
      mainFileName: mainRelativePath,
      rootRealPath: projectRealPath,
      candidateClass: value.candidateClass,
      profileSignature: value.profileSignature,
      engineSignature: value.engineSignature,
      provenance: value.provenance,
      inputs: value.inputs,
      artifacts,
      metrics: value.metrics,
      totalArtifactBytes: totalBytes,
    };
    const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
    if (manifestBytes.length > MAX_MANIFEST_BYTES) {
      return { saved: false, reason: "manifest-too-large" };
    }
    await writeFileDurably(path.join(temporaryDir, MANIFEST_FILE), manifestBytes);
    if (artifacts.some((artifact) => artifact.kind === "aux")) {
      await syncDirectory(path.join(temporaryDir, AUX_SUBDIR));
    }
    await syncDirectory(temporaryDir);

    const previous = await readPointer(cacheRealPath);
    const generationDir = path.join(cacheRealPath, generationId);
    await fsp.rename(temporaryDir, generationDir);
    published = true;
    await syncDirectory(cacheRealPath);

    const entries = [{
      id: generationId,
      manifestSha256: sha256Hex(manifestBytes),
      bytes: totalBytes,
      createdAt: manifest.createdAt,
    }];
    let retainedBytes = totalBytes;
    for (const entry of previous.ok ? previous.entries : []) {
      if (entries.length >= MAX_RETAINED_GENERATIONS) break;
      if (retainedBytes + entry.bytes > MAX_CACHE_BYTES) break;
      retainedBytes += entry.bytes;
      entries.push(entry);
    }
    if (!(await publishPointer(cacheRealPath, mainKey, entries))) {
      // The pointer still names the previous generation, so the unreferenced
      // new one is dropped rather than left behind.
      await removeOwnedDirectory(cacheRealPath, generationId);
      return { saved: false, reason: "pointer-not-writable" };
    }

    const retained = new Set(entries.map((entry) => entry.id));
    for (const cacheEntry of await listCacheEntries(cacheRealPath)) {
      if (!GENERATION_DIR_PATTERN.test(cacheEntry.name) || retained.has(cacheEntry.name)) continue;
      await removeOwnedDirectory(cacheRealPath, cacheEntry.name);
    }
    return {
      saved: true,
      generationId,
      directory: generationDir,
      candidateClass: value.candidateClass,
      bytes: totalBytes,
      retainedGenerations: entries.length,
    };
  } catch (error) {
    return { saved: false, reason: "cache-not-writable", detail: error?.message ?? String(error) };
  } finally {
    if (!published) await removeOwnedDirectory(cacheRealPath, temporaryName);
  }
};

/**
 * Returns the newest stored generation whose artifacts still hash correctly,
 * preferring one whose recorded inputs, profile and engine all still match.
 *
 * A hit is a candidate for reuse, never a statement that the canonical paper
 * is current or that live editing is ready; see this module's header. Callers
 * that reuse the bytes should re-hash them against the returned digests while
 * copying, since the files stay on disk after validation.
 *
 * @returns {Promise<{hit: true, generationId: string, candidateClass: string,
 *   artifacts: object, metrics: object|null, provenance: object,
 *   validation: object, blockers: string[], skipped: object[]}
 *   | {hit: false, reason: string, detail?: string, skipped: object[]}>}
 */
const loadPreviewCacheCandidate = async ({ rootPath, mainFileName, expected } = {}) => {
  const located = await resolvePreviewCacheDirectory(rootPath, mainFileName, false);
  if (!located.ok) return { hit: false, reason: located.reason, detail: located.detail, skipped: [] };
  const { cacheRealPath, projectRealPath } = located;
  const pointer = await readPointer(cacheRealPath);
  if (!pointer.ok) return { hit: false, reason: pointer.reason, skipped: [] };

  const skipped = [];
  let fallback = null;
  for (const entry of pointer.entries) {
    const read = await readGenerationManifest(cacheRealPath, entry);
    if (!read.ok) {
      skipped.push({ generationId: entry.id, reason: read.reason });
      continue;
    }
    const stored = await verifyStoredArtifacts(read.generationDir, read.manifest);
    if (!stored.ok) {
      skipped.push({ generationId: entry.id, reason: stored.reason, detail: stored.detail });
      continue;
    }
    const inputCheck = await verifyRecordedInputs(projectRealPath, read.manifest.inputs);
    const candidate = buildCandidate({
      entry,
      manifest: read.manifest,
      generationDir: read.generationDir,
      artifacts: stored.artifacts,
      inputCheck,
      expected,
      projectRealPath,
    });
    if (candidate.candidateClass === "reuse-candidate") return { ...candidate, skipped };
    // An older generation can still match the current source exactly, so keep
    // looking; the newest verified one stays as the static fallback.
    if (!fallback) fallback = candidate;
    skipped.push({ generationId: entry.id, reason: candidate.blockers[0] ?? "static-last-good" });
  }
  if (fallback) return { ...fallback, skipped: skipped.filter((item) => item.generationId !== fallback.generationId) };
  return { hit: false, reason: skipped[0]?.reason ?? "cache-empty", detail: skipped[0]?.detail, skipped };
};

/**
 * Removes this document's cached generations. Only entries this module named
 * are touched; `.tex64` and its other tenants are left alone.
 *
 * @returns {Promise<{cleared: true, removed: number} | {cleared: false, reason: string}>}
 */
const clearPreviewCache = async ({ rootPath, mainFileName } = {}) => {
  const located = await resolvePreviewCacheDirectory(rootPath, mainFileName, false);
  if (!located.ok) {
    return located.reason === "cache-missing" ? { cleared: true, removed: 0 } : { cleared: false, reason: located.reason };
  }
  const { cacheRealPath } = located;
  let removed = 0;
  for (const entry of await listCacheEntries(cacheRealPath)) {
    if (isOwnedCacheEntryName(entry.name)) {
      if (await removeOwnedDirectory(cacheRealPath, entry.name)) removed += 1;
      continue;
    }
    if (entry.name !== POINTER_FILE && !POINTER_TEMPORARY_PATTERN.test(entry.name)) continue;
    const target = path.join(cacheRealPath, entry.name);
    const stats = await lstatOrNull(target);
    if (!stats || stats.isSymbolicLink() || !stats.isFile()) continue;
    try {
      await fsp.unlink(target);
      removed += 1;
    } catch {
      // Leaving a pointer behind is safe: its generations are already gone and
      // every load re-verifies before returning anything.
    }
  }
  await syncDirectory(cacheRealPath);
  try {
    await fsp.rmdir(cacheRealPath);
  } catch {
    // Something else is in there; the cached generations are gone either way.
  }
  return { cleared: true, removed };
};

module.exports = {
  PREVIEW_CACHE_SCHEMA_VERSION,
  PREVIEW_CACHE_RELATIVE_DIR,
  savePreviewCacheGeneration,
  loadPreviewCacheCandidate,
  clearPreviewCache,
};
