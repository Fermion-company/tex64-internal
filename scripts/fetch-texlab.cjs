#!/usr/bin/env node
"use strict";

// Fetches the texlab language-server binary (GPL-3.0, latex-lsp/texlab) from
// GitHub Releases into Resources/texlab/<platform>-<arch>/texlab[.exe],
// verifying the downloaded archive against a pinned sha256. Bundled into the
// distributable; see NOTICE.md for the GPL-3.0 attribution.
//
// Usage:
//   node scripts/fetch-texlab.cjs            # current platform/arch
//   node scripts/fetch-texlab.cjs --mac      # both macOS arches (for dist)
//   node scripts/fetch-texlab.cjs --all      # every supported target

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const TEXLAB_VERSION = "v5.25.1";
const REPO = "latex-lsp/texlab";
const RESOURCES_DIR = path.join(__dirname, "..", "Resources", "texlab");

// Pin the archive and its extracted executable so cached builds use the same release.
const TARGETS = {
  "darwin-arm64": {
    asset: "texlab-aarch64-macos.tar.gz",
    sha256: "3755e9d1d4ad0b25135bdacd2fb453a612e88f48133185f96d660fa550398f66",
    binarySha256: "af09f8bc32570c49ba621c2795c005714e1323f36a5bd9fc76d93b0531cc9a9f",
  },
  "darwin-x64": {
    asset: "texlab-x86_64-macos.tar.gz",
    sha256: "11289a231f0cf382857a6a4a2eda1ba9f4f4e950af343b455797e3922d13b1ea",
    binarySha256: "499eed80dcb2a5099469712ee2a8bc506aa180b74216d5aa9e40ee54cbb1fe07",
  },
  "linux-x64": {
    asset: "texlab-x86_64-linux.tar.gz",
    sha256: "c8260b2fd2849cbad7d1f54c4ffa0389f34664b049392107bc4f7f9c8ec542ba",
    binarySha256: "e27581a3b2ca0014a1da2f09926ef674073b3661a09db01482425d21d96599aa",
  },
  "linux-arm64": {
    asset: "texlab-aarch64-linux.tar.gz",
    sha256: "e0d8e0b27b2e6e3526fa5019323bb3fddb1202a0f0049e527672b5ff323cc15e",
    binarySha256: "bbd5b0b2be35b6d36fc2c0cd280d811bdb328572c9e204e2e22021c1f7e19aff",
  },
  "win32-x64": {
    asset: "texlab-x86_64-windows.zip",
    sha256: "aa5fc1fe6004c17cd83086a57a8c8f28bb3f360914872711bfbb83490dc3c19e",
    binarySha256: "568ca0032f12ac5cf7a4604436554094aa9e6bb5ddd8a408580ddb29c79749be",
    archiveType: "zip",
    binary: "texlab.exe",
  },
};

const keyFor = (platform, arch) => `${platform}-${arch}`;
const downloadUrl = (asset) =>
  `https://github.com/${REPO}/releases/download/${TEXLAB_VERSION}/${asset}`;

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

const binaryNameFor = (target) => target.binary || "texlab";

const archiveSuffixFor = (target) =>
  target.archiveType === "zip" ? ".zip" : ".tar.gz";

const extractionArgsFor = (target, archivePath, outDir) =>
  target.archiveType === "zip"
    ? ["-xf", archivePath, "-C", outDir, binaryNameFor(target)]
    : ["-xzf", archivePath, "-C", outDir, binaryNameFor(target)];

async function fetchTarget(key) {
  const target = TARGETS[key];
  if (!target) {
    throw new Error(
      `Unsupported target "${key}". Supported: ${Object.keys(TARGETS).join(", ")}`
    );
  }
  const outDir = path.join(RESOURCES_DIR, key);
  const binaryName = binaryNameFor(target);
  const binPath = path.join(outDir, binaryName);

  try {
    if (sha256(await fsp.readFile(binPath)) === target.binarySha256) {
      if (process.platform !== "win32") await fsp.chmod(binPath, 0o755);
      console.log(`[fetch-texlab] ${key}: verified existing executable`);
      return;
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const url = downloadUrl(target.asset);
  console.log(`[fetch-texlab] ${key}: downloading ${url}`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`download failed (${res.status} ${res.statusText}): ${url}`);
  }
  const archive = Buffer.from(await res.arrayBuffer());
  const digest = sha256(archive);
  if (digest !== target.sha256) {
    throw new Error(
      `[fetch-texlab] ${key}: archive sha256 mismatch!\n  expected ${target.sha256}\n  got      ${digest}`
    );
  }

  await fsp.mkdir(outDir, { recursive: true });
  // Both packaging targets exclude tmp/**, including work left by an interrupted process.
  const stagingRoot = path.join(RESOURCES_DIR, "tmp");
  await fsp.mkdir(stagingRoot, { recursive: true });
  const staging = await fsp.mkdtemp(path.join(stagingRoot, key + "-"));
  try {
    const tmpArchive = path.join(staging, `archive${archiveSuffixFor(target)}`);
    await fsp.writeFile(tmpArchive, archive);
    const extract = spawnSync("tar", extractionArgsFor(target, tmpArchive, staging), {
      stdio: "inherit",
    });
    if (extract.status !== 0) {
      throw new Error(`[fetch-texlab] ${key}: archive extraction failed`);
    }
    const extracted = path.join(staging, binaryName);
    if (sha256(await fsp.readFile(extracted)) !== target.binarySha256) {
      throw new Error(`[fetch-texlab] ${key}: executable sha256 mismatch`);
    }
    if (process.platform !== "win32") await fsp.chmod(extracted, 0o755);
    await fsp.rename(extracted, binPath);
  } finally {
    await fsp.rm(staging, { recursive: true, force: true });
  }
  console.log(`[fetch-texlab] ${key}: installed verified texlab ${TEXLAB_VERSION}`);
}

async function fetchLicense() {
  const licensePath = path.join(RESOURCES_DIR, "LICENSE-GPL-3.0.txt");
  if (fs.existsSync(licensePath)) {
    return;
  }
  const url = `https://raw.githubusercontent.com/${REPO}/${TEXLAB_VERSION}/LICENSE`;
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    console.warn(`[fetch-texlab] could not fetch LICENSE (${res.status}); ${url}`);
    return;
  }
  await fsp.mkdir(RESOURCES_DIR, { recursive: true });
  await fsp.writeFile(licensePath, Buffer.from(await res.arrayBuffer()));
  console.log(`[fetch-texlab] wrote ${licensePath} (GPL-3.0)`);
}

async function main() {
  const args = process.argv.slice(2);
  let keys;
  if (args.includes("--all")) {
    keys = Object.keys(TARGETS);
  } else if (args.includes("--mac")) {
    keys = ["darwin-arm64", "darwin-x64"];
  } else {
    keys = [keyFor(process.platform, process.arch)];
  }
  for (const key of keys) {
    await fetchTarget(key);
  }
  await fetchLicense();
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = {
  TEXLAB_VERSION,
  TARGETS,
  binaryNameFor,
  archiveSuffixFor,
  extractionArgsFor,
};
