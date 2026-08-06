#!/usr/bin/env node
"use strict";

const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { resolveStoreVersion } = require("./windows-store-version.cjs");

const packageJson = require(path.resolve(__dirname, "..", "package.json"));
const storeVersion = resolveStoreVersion({
  sourceVersion: packageJson.version,
  explicitVersion: process.env.TEX64_WINDOWS_STORE_VERSION,
});
const electronBuilderCli = require.resolve("electron-builder/out/cli/cli.js");
const forwardedArgs = process.argv.slice(2);

console.log(`Microsoft Store package version: ${storeVersion}.0 (source ${packageJson.version})`);

const result = spawnSync(
  process.execPath,
  [
    electronBuilderCli,
    "--win",
    "appx",
    "--x64",
    "--publish",
    "never",
    `--config.extraMetadata.version=${storeVersion}`,
    ...forwardedArgs,
  ],
  { stdio: "inherit" },
);

if (result.error) {
  throw result.error;
}
if (result.signal) {
  console.error(`electron-builder terminated by ${result.signal}`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
