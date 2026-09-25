"use strict";

/**
 * A cached Build generation (preview-cache.cjs) as the engine's canonical
 * Build candidate (tdom-engine canonical-build-import.js).
 *
 * The cache hashes project inputs only. TeX-system inputs (the format,
 * classes, packages, fonts) are outside the project, and the engine assumes
 * them stable only within one app lifetime. To carry a Build across a
 * restart, the Build records a toolchain fingerprint: the path, size and
 * mtime of every system input its recorder listed. A TeX Live update or a
 * package installed into TEXMFHOME changes one of them, and the paper then
 * stays last-good instead of becoming canonical.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { loadPreviewCacheCandidate } = require("./preview-cache.cjs");

const CANONICAL_SEED_SUFFIXES = [".aux", ".toc", ".lof", ".lot", ".out"];
const TOOLCHAIN_FINGERPRINT_VERSION = 1;
// Rewritten by every LuaTeX run (luaotfload's name lookup memo), so it says
// nothing about the toolchain. Font and name-database caches stay in: they
// change only when fonts do.
const VOLATILE_SYSTEM_INPUT = /[\\/]luaotfload-lookup-cache\.lu[ac]$/;
const MAX_RECORDER_BYTES = 8 * 1024 * 1024;

const signatureFor = (value) =>
  crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

const previewCacheProfile = ({ mainFileName, requestedEngine, effectiveEngine, extraArgs }) => ({
  runner: "latexmk",
  requestedEngine,
  effectiveEngine,
  synctex: true,
  interaction: "nonstopmode",
  haltOnError: true,
  fileLineError: true,
  extraArgs: [...extraArgs],
  mainFile: mainFileName.split(path.sep).join("/"),
});

const previewCacheSignatures = ({ profile, outDir }) => ({
  profileSignature: signatureFor({ version: 2, profile, outDir: outDir ?? null }),
  engineSignature: signatureFor({
    version: 2,
    requestedEngine: profile.requestedEngine,
    effectiveEngine: profile.effectiveEngine,
  }),
});

const isWithin = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
};

/** @returns {Promise<string|null>} null when the recorder cannot be read. */
const toolchainFingerprint = async (recorderPath, rootPath) => {
  let text;
  try {
    const stats = await fs.promises.stat(recorderPath);
    if (!stats.isFile() || stats.size < 1 || stats.size > MAX_RECORDER_BYTES) return null;
    text = await fs.promises.readFile(recorderPath, "utf8");
  } catch {
    return null;
  }
  const rootRealPath = await fs.promises.realpath(rootPath).catch(() => null);
  if (!rootRealPath) return null;
  const lines = text.split(/\r?\n/);
  const pwd = lines.find((line) => line.startsWith("PWD "))?.slice(4).trim();
  const compileDirectory = pwd && path.isAbsolute(pwd) ? pwd : rootRealPath;
  const inputs = new Set();
  for (const line of lines) {
    if (!line.startsWith("INPUT ")) continue;
    const value = line.slice(6).trim();
    if (!value || value.startsWith("|")) return null;
    inputs.add(path.resolve(compileDirectory, value));
  }
  const entries = [];
  for (const input of inputs) {
    const realPath = await fs.promises.realpath(input).catch(() => null);
    if (realPath && isWithin(rootRealPath, realPath)) continue;
    if (VOLATILE_SYSTEM_INPUT.test(realPath ?? input)) continue;
    if (!realPath) {
      if (isWithin(compileDirectory, input)) continue;
      entries.push(`${input}\0missing`);
      continue;
    }
    const stats = await fs.promises.stat(realPath).catch(() => null);
    entries.push(stats ? `${realPath}\0${stats.size}\0${stats.mtimeMs}` : `${realPath}\0missing`);
  }
  if (!entries.length) return null;
  entries.sort();
  return signatureFor({ version: TOOLCHAIN_FINGERPRINT_VERSION, entries });
};

/** The engine's schemaVersion 1 candidate for a verified cache generation. */
const canonicalBuildFromCache = (loaded, { rootPath, mainFileName, profile, provenance, durationMs }) => {
  const mainStem = path.basename(mainFileName).replace(/\.tex$/i, "");
  const allowedAux = loaded.artifacts.aux.flatMap((artifact) => {
    const lower = artifact.logicalName.toLowerCase();
    const extension = CANONICAL_SEED_SUFFIXES.find((suffix) => lower.endsWith(suffix));
    if (!extension || lower !== `${mainStem.toLowerCase()}${extension}`) return [];
    return [{
      ext: extension.slice(1),
      logicalName: artifact.logicalName,
      path: artifact.filePath,
      sha256: artifact.sha256,
    }];
  });
  return {
    schemaVersion: 1,
    profile,
    provenance,
    artifacts: {
      pdf: { path: loaded.artifacts.pdf.filePath, sha256: loaded.artifacts.pdf.sha256 },
      synctex: {
        path: loaded.artifacts.synctex.filePath,
        sha256: loaded.artifacts.synctex.sha256,
        compression: "gzip",
      },
      fls: { path: loaded.artifacts.fls.filePath, sha256: loaded.artifacts.fls.sha256 },
      aux: allowedAux,
    },
    inputs: loaded.inputs.map((record) => ({
      path: path.resolve(rootPath, ...record.path.split("/")),
      sha256: record.sha256,
    })),
    metrics: { durationMs },
  };
};

const compatibleProfile = (profile, mainFileName) =>
  !!profile && profile.runner === "latexmk" &&
  profile.requestedEngine === "lualatex" && profile.effectiveEngine === "lualatex" &&
  profile.synctex === true && profile.interaction === "nonstopmode" &&
  profile.haltOnError === true && profile.fileLineError === true &&
  Array.isArray(profile.extraArgs) && profile.extraArgs.length === 0 &&
  typeof profile.mainFile === "string" &&
  path.posix.normalize(profile.mainFile) === path.posix.normalize(mainFileName.split(path.sep).join("/"));

/**
 * The newest cached Build of `mainFileName` as a canonical candidate for a
 * new app lifetime, or null with the reason. The engine still validates the
 * candidate against the document it opens (unsaved buffers included).
 */
const loadPersistedCanonicalBuild = async ({ rootPath, mainFileName }) => {
  const { engineSignature } = previewCacheSignatures({
    profile: previewCacheProfile({
      mainFileName, requestedEngine: "lualatex", effectiveEngine: "lualatex", extraArgs: [],
    }),
    outDir: null,
  });
  // The output directory is part of the profile signature but does not change
  // the paper; the recorded profile is checked field by field instead.
  const loaded = await loadPreviewCacheCandidate({ rootPath, mainFileName, expected: { engineSignature } });
  if (!loaded.hit) return { candidate: null, reason: loaded.reason ?? "cache-miss" };
  const blockers = (loaded.blockers ?? []).filter((blocker) => blocker !== "profile-unverified");
  if (blockers.length) return { candidate: null, reason: blockers[0] };
  const profile = loaded.provenance?.engine?.profile;
  if (!compatibleProfile(profile, mainFileName)) return { candidate: null, reason: "profile-incompatible" };
  if (!loaded.artifacts?.pdf || !loaded.artifacts?.fls || !loaded.artifacts?.synctex) {
    return { candidate: null, reason: "artifacts-incomplete" };
  }
  // Recorded only for a Build that also qualified as a candidate in its own
  // lifetime (gzip SyncTeX, lualatex, no extra arguments).
  const recorded = loaded.metrics?.toolchain;
  if (recorded?.version !== TOOLCHAIN_FINGERPRINT_VERSION || typeof recorded.signature !== "string") {
    return { candidate: null, reason: "toolchain-unrecorded" };
  }
  const current = await toolchainFingerprint(loaded.artifacts.fls.filePath, rootPath);
  if (current !== recorded.signature) return { candidate: null, reason: "toolchain-changed" };
  const durationMs = Number(loaded.metrics?.durationMs);
  if (!Number.isFinite(durationMs) || durationMs <= 0) return { candidate: null, reason: "build-metrics-invalid" };
  const provenance = {
    inputProof: loaded.provenance.inputProof,
    dynamicInputs: false,
    unknownInputs: [],
    systemInputsStable: true,
  };
  return {
    candidate: canonicalBuildFromCache(loaded, { rootPath, mainFileName, profile, provenance, durationMs }),
    reason: null,
  };
};

module.exports = {
  TOOLCHAIN_FINGERPRINT_VERSION,
  signatureFor,
  previewCacheProfile,
  previewCacheSignatures,
  toolchainFingerprint,
  canonicalBuildFromCache,
  loadPersistedCanonicalBuild,
};
