#!/usr/bin/env node
"use strict";

const path = require("node:path");

const MAX_APPX_COMPONENT = 65_535;

function parseStableVersion(value, label = "version") {
  const normalized = String(value || "").trim();
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(normalized);
  if (!match) {
    throw new Error(`${label} must be a stable three-part version (for example 0.1.19): ${normalized || "<empty>"}`);
  }

  const parts = match.slice(1).map(Number);
  if (parts.some((part) => part > MAX_APPX_COMPONENT)) {
    throw new Error(`${label} contains a component greater than ${MAX_APPX_COMPONENT}: ${normalized}`);
  }
  return parts;
}

function validateStoreVersion(value) {
  const [major, minor, patch] = parseStableVersion(value, "Microsoft Store version");
  if (major < 1) {
    throw new Error(`Microsoft Store version major must be at least 1: ${value}`);
  }
  return `${major}.${minor}.${patch}`;
}

function mapSourceVersionToStoreVersion(value) {
  const [major, minor, patch] = parseStableVersion(value, "source version");
  if (major >= MAX_APPX_COMPONENT) {
    throw new Error(`source version major cannot be mapped into an AppX version: ${value}`);
  }

  // AppX rejects a zero major version. Offsetting only the major component is
  // monotonic, so ordinary source releases keep their update order in Store.
  return `${major + 1}.${minor}.${patch}`;
}

function resolveStoreVersion({ sourceVersion, explicitVersion } = {}) {
  if (String(explicitVersion || "").trim()) {
    return validateStoreVersion(explicitVersion);
  }
  return mapSourceVersionToStoreVersion(sourceVersion);
}

function main() {
  const packagePath = path.resolve(__dirname, "..", "package.json");
  const packageJson = require(packagePath);
  const sourceVersion = process.argv[2] || packageJson.version;
  const storeVersion = resolveStoreVersion({
    sourceVersion,
    explicitVersion: process.env.TEX64_WINDOWS_STORE_VERSION,
  });
  process.stdout.write(`${storeVersion}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

module.exports = {
  mapSourceVersionToStoreVersion,
  parseStableVersion,
  resolveStoreVersion,
  validateStoreVersion,
};
