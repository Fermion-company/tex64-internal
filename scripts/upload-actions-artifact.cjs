#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const usage = () => {
  console.error(
    "Usage: node scripts/upload-actions-artifact.cjs --name <name> " +
      "[--retention-days <1-90>] [--compression-level <0-9>] -- <file...>"
  );
};

const parseInteger = (value, label, min, max) => {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} must be an integer from ${min} through ${max}.`);
  }
  return parsed;
};

const parseArguments = (argv) => {
  const separator = argv.indexOf("--");
  const optionArgs = separator >= 0 ? argv.slice(0, separator) : argv;
  const fileArgs = separator >= 0 ? argv.slice(separator + 1) : [];
  let name = "";
  let retentionDays = 30;
  let compressionLevel = 0;

  for (let index = 0; index < optionArgs.length; index += 1) {
    const option = optionArgs[index];
    const value = optionArgs[index + 1];
    if (option === "--name") {
      name = String(value || "").trim();
      index += 1;
    } else if (option === "--retention-days") {
      retentionDays = parseInteger(value, "retention-days", 1, 90);
      index += 1;
    } else if (option === "--compression-level") {
      compressionLevel = parseInteger(value, "compression-level", 0, 9);
      index += 1;
    } else {
      throw new Error(`Unknown option: ${option}`);
    }
  }

  if (!name || name.length > 256 || /[\\/"\r\n:*?<>|]/u.test(name)) {
    throw new Error("Artifact name is missing or contains unsupported characters.");
  }

  const files = [...new Set(fileArgs.map((file) => path.resolve(file)))];
  if (files.length === 0) {
    throw new Error("At least one artifact file is required after --.");
  }
  for (const file of files) {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      throw new Error(`Artifact file does not exist or is not a file: ${file}`);
    }
  }

  return { name, retentionDays, compressionLevel, files };
};

const commonParentDirectory = (files) => {
  let rootDirectory = path.dirname(files[0]);
  for (const file of files.slice(1)) {
    while (true) {
      const relative = path.relative(rootDirectory, file);
      if (relative && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
        break;
      }
      const parent = path.dirname(rootDirectory);
      if (parent === rootDirectory) {
        throw new Error("Artifact files do not share a usable parent directory.");
      }
      rootDirectory = parent;
    }
  }
  return rootDirectory;
};

const main = async () => {
  const { name, retentionDays, compressionLevel, files } = parseArguments(
    process.argv.slice(2)
  );
  if (!process.env.ACTIONS_RUNTIME_TOKEN || !process.env.ACTIONS_RESULTS_URL) {
    throw new Error("GitHub Actions artifact runtime credentials are unavailable.");
  }

  const { DefaultArtifactClient } = await import("@actions/artifact");
  const client = new DefaultArtifactClient();
  const rootDirectory = commonParentDirectory(files);
  const result = await client.uploadArtifact(name, files, rootDirectory, {
    retentionDays,
    compressionLevel,
  });
  console.log(
    `Uploaded artifact ${name}: id=${result.id}, bytes=${result.size}` +
      (result.digest ? `, digest=${result.digest}` : "")
  );
};

main().catch((error) => {
  usage();
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
