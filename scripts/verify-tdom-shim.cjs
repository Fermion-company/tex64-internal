"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

function verifyPackagedShim({ appOutDir, electronPlatformName, arch }) {
  if (electronPlatformName !== "darwin") return;
  // electron-builder uses builder-util's numeric Arch enum (x64=1, arm64=3).
  const target = ({ 1: "x64", 3: "arm64" })[arch];
  if (!target) throw new Error(`Unsupported TDOM package architecture: ${arch}`);
  const dir = path.join(appOutDir, "TeX64.app/Contents/Resources/app.asar.unpacked/Resources/tdom-engine/engine/checkpoint");
  const so = path.join(dir, `prebuilt/tdomfork-darwin-${target}.so`);
  const hash = createHash("sha256").update(fs.readFileSync(path.join(dir, "tdomfork.c"))).digest("hex");
  if (fs.readFileSync(`${so}.sha256`, "utf8").trim() !== hash) {
    throw new Error(`Stale packaged TDOM shim: ${so}`);
  }
  const bytes = fs.readFileSync(so);
  const cpu = target === "arm64" ? 0x0100000c : 0x01000007;
  if (bytes.length < 8 || bytes.readUInt32LE(0) !== 0xfeedfacf || bytes.readUInt32LE(4) !== cpu) {
    throw new Error(`Wrong architecture or invalid TDOM shim: ${so}`);
  }
  fs.accessSync(path.join(dir, "forkshim-probe.lua"));
}

module.exports = verifyPackagedShim;
