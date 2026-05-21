#!/usr/bin/env node
"use strict";

// Fetches the texlab language-server binary (GPL-3.0, latex-lsp/texlab) from
// GitHub Releases into Resources/texlab/<platform>-<arch>/texlab, verifying the
// downloaded archive against a pinned sha256. Bundled into the distributable;
// see NOTICE.md for the GPL-3.0 attribution.
//
// Usage:
//   node scripts/fetch-texlab.cjs            # current platform/arch
//   node scripts/fetch-texlab.cjs --mac      # both macOS arches (for dist)
//   node scripts/fetch-texlab.cjs --all      # every supported target

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const TEXLAB_VERSION = "v5.25.1";
const REPO = "latex-lsp/texlab";
const RESOURCES_DIR = path.join(__dirname, "..", "Resources", "texlab");

// Pinned sha256 of each release ARCHIVE. Empty string => not yet pinned: the
// script downloads, prints the observed hash, and asks you to paste it here.
const TARGETS = {
  "darwin-arm64": {
    asset: "texlab-aarch64-macos.tar.gz",
    sha256: "3755e9d1d4ad0b25135bdacd2fb453a612e88f48133185f96d660fa550398f66",
  },
  "darwin-x64": {
    asset: "texlab-x86_64-macos.tar.gz",
    sha256: "11289a231f0cf382857a6a4a2eda1ba9f4f4e950af343b455797e3922d13b1ea",
  },
  "linux-x64": {
    asset: "texlab-x86_64-linux.tar.gz",
    sha256: "c8260b2fd2849cbad7d1f54c4ffa0389f34664b049392107bc4f7f9c8ec542ba",
  },
  "linux-arm64": {
    asset: "texlab-aarch64-linux.tar.gz",
    sha256: "e0d8e0b27b2e6e3526fa5019323bb3fddb1202a0f0049e527672b5ff323cc15e",
  },
};

const keyFor = (platform, arch) => `${platform}-${arch}`;
const downloadUrl = (asset) =>
  `https://github.com/${REPO}/releases/download/${TEXLAB_VERSION}/${asset}`;

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

async function fetchTarget(key) {
  const target = TARGETS[key];
  if (!target) {
    throw new Error(
      `Unsupported target "${key}". Supported: ${Object.keys(TARGETS).join(", ")}`
    );
  }
  const outDir = path.join(RESOURCES_DIR, key);
  const binPath = path.join(outDir, "texlab");

  if (fs.existsSync(binPath)) {
    console.log(`[fetch-texlab] ${key}: already present, skipping`);
    return;
  }

  const url = downloadUrl(target.asset);
  console.log(`[fetch-texlab] ${key}: downloading ${url}`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`download failed (${res.status} ${res.statusText}): ${url}`);
  }
  const archive = Buffer.from(await res.arrayBuffer());
  const digest = sha256(archive);
  if (target.sha256 && digest !== target.sha256) {
    throw new Error(
      `[fetch-texlab] ${key}: archive sha256 mismatch!\n  expected ${target.sha256}\n  got      ${digest}`
    );
  }

  await fsp.mkdir(outDir, { recursive: true });
  const tmpArchive = path.join(os.tmpdir(), `texlab-${key}-${process.pid}.tar.gz`);
  await fsp.writeFile(tmpArchive, archive);
  const extract = spawnSync("tar", ["-xzf", tmpArchive, "-C", outDir, "texlab"], {
    stdio: "inherit",
  });
  await fsp.rm(tmpArchive, { force: true });
  if (extract.status !== 0) {
    throw new Error(`[fetch-texlab] ${key}: tar extraction failed`);
  }
  await fsp.chmod(binPath, 0o755);

  console.log(`[fetch-texlab] ${key}: installed texlab ${TEXLAB_VERSION}`);
  if (!target.sha256) {
    console.log(
      `[fetch-texlab] PIN THIS: TARGETS["${key}"].sha256 = "${digest}"`
    );
  } else {
    console.log(`[fetch-texlab] ${key}: archive sha256 verified (${digest})`);
  }
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

main().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});
