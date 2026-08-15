"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const NO_FILE_ACCESS = {
  classify: () => null,
  getState: () => "granted",
  probeIfAllowed: (_candidate, probeFn) => probeFn(),
  ensureAccess: async () => true,
};

function resolveEngineDir({
  name,
  marker,
  envDir,
  explicitDir,
  homeDir = os.homedir(),
  existsSync = fs.existsSync,
  fileAccess = NO_FILE_ACCESS,
}) {
  const selected = typeof envDir === "string" && envDir.trim() ? envDir.trim() : explicitDir;
  if (selected) return { dir: selected, needsAccess: null };

  const candidates = [
    path.join(homeDir, "Library", "Application Support", "TeX64", "engines", name),
    path.join(homeDir, "Developer", name),
    path.join(homeDir, name),
    path.join(homeDir, "Desktop", name),
  ];
  let needsAccess = null;
  for (const candidate of candidates) {
    const result = fileAccess.probeIfAllowed(candidate, () => existsSync(path.join(candidate, marker)));
    if (result === true) return { dir: candidate, needsAccess: null };
    if (result === null) needsAccess ||= fileAccess.classify(candidate)?.key || null;
  }
  return { dir: candidates.at(-1), needsAccess };
}

module.exports = { resolveEngineDir, NO_FILE_ACCESS };
