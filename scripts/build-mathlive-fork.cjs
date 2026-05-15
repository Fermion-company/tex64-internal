#!/usr/bin/env node
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const forkRoot = path.join(projectRoot, "web-src", "math", "fork");
const legacyForkRoot = path.join(projectRoot, "web-src", "vendor", "mathlive-fork");
const forkDistRoot = path.join(forkRoot, "dist");
const appMathliveRoot = path.join(projectRoot, "Resources", "web", "mathlive");

const requiredDistFiles = ["mathlive.min.js", "mathlive-static.css"];
const requiredDistDirs = ["fonts"];
const staleOutputDirs = ["sounds"];

const resolveCommand = (command) => {
  if (process.platform !== "win32") {
    return command;
  }
  if (command === "npm" || command === "npx") {
    return `${command}.cmd`;
  }
  return command;
};

const run = (command, args, cwd) => {
  execFileSync(resolveCommand(command), args, {
    cwd,
    stdio: "inherit",
    env: {
      ...process.env,
      CI: process.env.CI || "1",
    },
  });
};

const ensureForkExists = () => {
  if (fs.existsSync(legacyForkRoot)) {
    throw new Error(
      `Legacy MathLive location is still present (${legacyForkRoot}). Keep only web-src/math/fork to avoid split sources.`
    );
  }
  const pkgPath = path.join(forkRoot, "package.json");
  if (!fs.existsSync(pkgPath)) {
    throw new Error(
      `Embedded MathLive source is missing. Expected ${pkgPath}.`
    );
  }
};

const ensureNodeModules = () => {
  const nodeModulesDir = path.join(forkRoot, "node_modules");
  if (fs.existsSync(nodeModulesDir)) {
    return;
  }
  console.log("[mathlive:build] Installing fork dependencies (npm ci)...");
  run("npm", ["ci", "--silent", "--ignore-scripts"], forkRoot);
};

const buildForkRuntime = async () => {
  console.log("[mathlive:build] Preparing fork dist/...");
  await fsp.rm(forkDistRoot, { recursive: true, force: true });
  await fsp.mkdir(forkDistRoot, { recursive: true });

  console.log("[mathlive:build] Building MathLive runtime bundle...");
  run("node", ["--experimental-json-modules", "./scripts/build.mjs"], forkRoot);

  console.log("[mathlive:build] Building static CSS...");
  run("npx", ["lessc", "css/mathlive-static.less", "dist/mathlive-static.css"], forkRoot);

  console.log("[mathlive:build] Copying font assets...");
  await fsp.cp(path.join(forkRoot, "css", "fonts"), path.join(forkDistRoot, "fonts"), {
    recursive: true,
  });
};

const ensureDistOutputs = () => {
  for (const fileName of requiredDistFiles) {
    const target = path.join(forkDistRoot, fileName);
    if (!fs.existsSync(target)) {
      throw new Error(`Missing build output: ${target}`);
    }
  }
  for (const dirName of requiredDistDirs) {
    const target = path.join(forkDistRoot, dirName);
    if (!fs.existsSync(target)) {
      throw new Error(`Missing build output directory: ${target}`);
    }
  }
};

const syncOutput = async () => {
  await fsp.mkdir(appMathliveRoot, { recursive: true });

  for (const dirName of [...requiredDistDirs, ...staleOutputDirs]) {
    await fsp.rm(path.join(appMathliveRoot, dirName), { recursive: true, force: true });
  }

  for (const fileName of requiredDistFiles) {
    await fsp.copyFile(
      path.join(forkDistRoot, fileName),
      path.join(appMathliveRoot, fileName)
    );
  }

  for (const dirName of requiredDistDirs) {
    await fsp.cp(path.join(forkDistRoot, dirName), path.join(appMathliveRoot, dirName), {
      recursive: true,
    });
  }
};

const main = async () => {
  ensureForkExists();
  ensureNodeModules();

  await buildForkRuntime();
  ensureDistOutputs();

  console.log("[mathlive:build] Syncing assets to Resources/web/mathlive...");
  await syncOutput();
  console.log("[mathlive:build] Done.");
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
