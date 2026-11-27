"use strict";

const path = require("node:path");
const { pathToFileURL } = require("node:url");

async function prepareTdomShim({
  engineDir = path.resolve(__dirname, "../Resources/tdom-engine"),
  arch = process.env.TEX64_TARGET_ARCH || process.arch,
  platform = process.platform,
} = {}) {
  // POSIX fork is not available on Windows. Linux keeps its runtime build.
  if (platform !== "darwin") return null;
  if (!["arm64", "x64"].includes(arch)) throw new Error(`Unsupported TDOM build architecture: ${arch}`);
  const sourceDir = path.join(engineDir, "engine/checkpoint");
  const shim = await import(pathToFileURL(path.join(sourceDir, "forkshim.js")).href);
  if (typeof shim.buildPrebuiltShim !== "function") {
    throw new Error("Pinned TDOM engine lacks buildPrebuiltShim; update TDOM_ENGINE_COMMIT before packaging.");
  }
  const output = await shim.buildPrebuiltShim({ sourceDir, platform, arch });
  const batch = await import(pathToFileURL(path.join(sourceDir, "synctex-batch.js")).href);
  const helper = await batch.buildPrebuiltSyncTeXHelper({ arch });
  console.log(`Built TDOM native tools: ${output}, ${helper}`);
  return output;
}

module.exports = { prepareTdomShim };
if (require.main === module) {
  prepareTdomShim().catch(error => { console.error(error); process.exitCode = 1; });
}
