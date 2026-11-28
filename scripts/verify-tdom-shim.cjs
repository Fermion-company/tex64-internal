"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

function verifyPackagedShim({ appOutDir, electronPlatformName, arch, packager }) {
  if (electronPlatformName !== "darwin") return;
  // electron-builder uses builder-util's numeric Arch enum (x64=1, arm64=3).
  const target = ({ 1: "x64", 3: "arm64" })[arch];
  if (!target) throw new Error(`Unsupported TDOM package architecture: ${arch}`);
  // The bundle is named after productName, which a local beta build overrides.
  const appName = `${packager?.appInfo?.productFilename || "TeX64"}.app`;
  const dir = path.join(appOutDir, appName, "Contents/Resources/app.asar.unpacked/Resources/tdom-engine/engine/checkpoint");
  const so = path.join(dir, `prebuilt/tdomfork-darwin-${target}.so`);
  const hash = createHash("sha256").update(fs.readFileSync(path.join(dir, "tdomfork.c"))).digest("hex");
  if (fs.readFileSync(`${so}.sha256`, "utf8").trim() !== hash) {
    throw new Error(`Stale packaged TDOM shim: ${so}`);
  }
  const helper = path.join(dir, `prebuilt/tdom-synctex-batch-darwin-${target}`);
  const { syncTeXBatchSourceHash } = require(path.join(dir, "synctex-batch.js"));
  if (fs.readFileSync(helper + ".sha256", "utf8").trim() !== syncTeXBatchSourceHash()) {
    throw new Error(`Stale packaged SyncTeX helper: ${helper}`);
  }
  fs.accessSync(helper, fs.constants.X_OK);
  const cpu = target === "arm64" ? 0x0100000c : 0x01000007;
  for (const executable of [so, helper]) {
    const bytes = fs.readFileSync(executable);
    if (bytes.length < 8 || bytes.readUInt32LE(0) !== 0xfeedfacf || bytes.readUInt32LE(4) !== cpu) {
      throw new Error(`Wrong architecture or invalid TDOM native binary: ${executable}`);
    }
  }
  fs.accessSync(path.join(dir, "forkshim-probe.lua"));
}

module.exports = verifyPackagedShim;
