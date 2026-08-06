"use strict";

const { globSync, statSync } = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const requiredInput = (name) => {
  const key = `INPUT_${name.replaceAll("-", "_").toUpperCase()}`;
  const value = String(process.env[key] || "").trim();
  if (!value) {
    throw new Error(`Missing required action input: ${name}`);
  }
  return value;
};

const main = () => {
  const name = requiredInput("name");
  const patterns = requiredInput("path")
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter(Boolean);
  const files = [
    ...new Set(
      patterns.flatMap((pattern) =>
        globSync(pattern, { cwd: process.cwd() })
          .map((file) => path.resolve(file))
          .filter((file) => statSync(file).isFile())
      )
    ),
  ].sort();
  if (files.length === 0) {
    throw new Error(`No artifact files matched: ${patterns.join(", ")}`);
  }

  const uploader = path.resolve(__dirname, "../../../scripts/upload-actions-artifact.cjs");
  const result = spawnSync(
    process.execPath,
    [
      uploader,
      "--name",
      name,
      "--retention-days",
      process.env["INPUT_RETENTION-DAYS"] || "30",
      "--compression-level",
      process.env["INPUT_COMPRESSION-LEVEL"] || "0",
      "--",
      ...files,
    ],
    { env: process.env, stdio: "inherit" }
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Artifact uploader exited with status ${result.status}`);
  }
};

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
}
