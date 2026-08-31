#!/usr/bin/env node
"use strict";

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const serviceDir = path.join(projectRoot, "services", "tex64-ai");
const standaloneDir = path.join(serviceDir, ".next", "standalone");
const outputDir = path.join(projectRoot, "build", "tex64-ai-native");

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const environmentFileNames = [
  ".env.production.local",
  ".env.local",
  ".env.production",
  ".env",
];

const run = (command, args, cwd, env = process.env) => {
  execFileSync(command, args, { cwd, env, stdio: "inherit" });
};

const ensureServiceDependencies = () => {
  const nextPackage = path.join(serviceDir, "node_modules", "next", "package.json");
  if (fs.existsSync(nextPackage)) return;
  console.log("[ai-native] Installing tex64-ai dependencies...");
  run(npmCommand, ["ci"], serviceDir);
};

const sanitizedBuildEnvironment = () => {
  const environment = { ...process.env };
  // Next reads local dotenv files during production builds. Mark every key as
  // already present (but empty) so a developer's credentials cannot become
  // part of a locally packaged application.
  for (const name of environmentFileNames) {
    const filePath = path.join(serviceDir, name);
    if (!fs.existsSync(filePath)) continue;
    const contents = fs.readFileSync(filePath, "utf8");
    for (const match of contents.matchAll(/^\s*(?:export\s+)?([\w.-]+)\s*(?:=|:)/gmu)) {
      environment[match[1]] = "";
    }
  }
  for (const secret of [
    "AI_GATEWAY_API_KEY",
    "BLOB_READ_WRITE_TOKEN",
    "DATABASE_URL",
    "OPENAI_API_KEY",
    "TEX64_SESSION_SECRET",
    "VERCEL_OIDC_TOKEN",
    "VERCEL_TOKEN",
  ]) {
    environment[secret] = "";
  }
  for (const key of Object.keys(environment)) {
    if (
      /^(?:AI_GATEWAY_|BLOB_|NEXT_PUBLIC_|OPENAI_|TEX64_|VERCEL_)/u.test(key) ||
      key === "WORKFLOW_TARGET_WORLD"
    ) {
      environment[key] = "";
    }
  }
  environment.NEXT_TELEMETRY_DISABLED = process.env.NEXT_TELEMETRY_DISABLED || "1";
  environment.NODE_ENV = "production";
  environment.TEX64_LOCAL_DEVELOPMENT = "false";
  return environment;
};

const buildStandalone = () => {
  const serviceRequire = createRequire(path.join(serviceDir, "package.json"));
  const nextCli = serviceRequire.resolve("next/dist/bin/next");
  const nextEnvironmentTypes = path.join(serviceDir, "next-env.d.ts");
  const originalEnvironmentTypes = fs.readFileSync(nextEnvironmentTypes, "utf8");
  console.log("[ai-native] Building Next.js standalone server...");
  try {
    run(
      process.execPath,
      [nextCli, "build", "--webpack"],
      serviceDir,
      sanitizedBuildEnvironment(),
    );
  } finally {
    // Next rewrites this tracked generated file between dev/build type roots.
    // Packaging must not leave a source-tree change behind.
    fs.writeFileSync(nextEnvironmentTypes, originalEnvironmentTypes);
  }
};

const copyIfDirectory = (source, destination) => {
  if (!fs.statSync(source, { throwIfNoEntry: false })?.isDirectory()) return;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, { recursive: true, dereference: true });
};

const cleanStagedState = (directory) => {
  for (const name of environmentFileNames) {
    fs.rmSync(path.join(directory, name), { force: true });
  }
  for (const localState of [".artifacts", ".data"]) {
    fs.rmSync(path.join(directory, localState), { recursive: true, force: true });
  }
};

const stageStandalone = () => {
  const serverFile = path.join(standaloneDir, "server.js");
  if (!fs.statSync(serverFile, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Next standalone entry was not generated: ${serverFile}`);
  }

  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(outputDir), { recursive: true });
  fs.cpSync(standaloneDir, outputDir, { recursive: true, dereference: true });
  cleanStagedState(outputDir);
  copyIfDirectory(path.join(serviceDir, ".next", "static"), path.join(outputDir, ".next", "static"));
  copyIfDirectory(path.join(serviceDir, "public"), path.join(outputDir, "public"));

  const stagedServerFile = path.join(outputDir, "server.js");
  if (!fs.statSync(stagedServerFile, { throwIfNoEntry: false })?.isFile()) {
    throw new Error("Staged AI server is missing server.js");
  }
  // Next's generated launcher normally changes cwd to the read-only app
  // resource directory. Keep its application `dir` there, but put cwd (local
  // persistence and artifacts) under Electron's writable userData directory.
  const generatedLauncher = fs.readFileSync(stagedServerFile, "utf8");
  const chdirStatement = "process.chdir(__dirname)";
  if (generatedLauncher.split(chdirStatement).length !== 2) {
    throw new Error("Next standalone launcher changed its cwd contract");
  }
  fs.writeFileSync(
    stagedServerFile,
    generatedLauncher.replace(
      chdirStatement,
      "process.chdir(process.env.TEX64_AI_NATIVE_RUNTIME_DIR || __dirname)",
    ),
  );
  console.log(`[ai-native] Staged desktop server at ${path.relative(projectRoot, outputDir)}`);
};

const prepareNativeBundle = () => {
  ensureServiceDependencies();
  buildStandalone();
  stageStandalone();
};

if (require.main === module) {
  try {
    prepareNativeBundle();
  } catch (error) {
    console.error(`[ai-native] ${error?.message || error}`);
    process.exitCode = 1;
  }
}

module.exports = {
  buildStandalone,
  cleanStagedState,
  ensureServiceDependencies,
  outputDir,
  prepareNativeBundle,
  sanitizedBuildEnvironment,
  serviceDir,
  stageStandalone,
  standaloneDir,
};
