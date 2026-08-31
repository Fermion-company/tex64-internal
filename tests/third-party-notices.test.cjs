"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const projectRoot = path.join(__dirname, "..");
const rootLockPath = path.join(projectRoot, "package-lock.json");
const aiLockPath = path.join(projectRoot, "services", "tex64-ai", "package-lock.json");

const packageRows = (lockPath) => {
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  const rows = new Map();
  for (const [packagePath, metadata] of Object.entries(lock.packages ?? {})) {
    const normalized = packagePath.replaceAll("\\", "/");
    const marker = "/node_modules/";
    const markerIndex = normalized.lastIndexOf(marker);
    const name = markerIndex >= 0
      ? normalized.slice(markerIndex + marker.length)
      : normalized.startsWith("node_modules/")
        ? normalized.slice("node_modules/".length)
        : "";
    const version = typeof metadata?.version === "string" ? metadata.version : "";
    if (name && version) rows.set(`${name}@${version}`, { name, version });
  }
  return rows;
};

const tableNeedle = ({ name, version }) => `| ${name} | ${version} |`;

test("NOTICE merges root and standalone AI lockfiles without duplicate packages", () => {
  const rootRows = packageRows(rootLockPath);
  const aiRows = packageRows(aiLockPath);
  const rootOnly = [...rootRows].find(([key]) => !aiRows.has(key))?.[1];
  const aiOnly = [...aiRows].find(([key]) => !rootRows.has(key))?.[1];
  const shared = [...rootRows].find(([key]) => aiRows.has(key))?.[1];
  assert.ok(rootOnly, "fixture needs a root-only dependency");
  assert.ok(aiOnly, "fixture needs an AI-only dependency");
  assert.ok(shared, "fixture needs a dependency shared by both lockfiles");

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-notice-test-"));
  const output = path.join(temporary, "NOTICE.md");
  try {
    execFileSync(
      process.execPath,
      [
        path.join(projectRoot, "scripts", "generate-third-party-notices.cjs"),
        "--lock",
        rootLockPath,
        "--lock",
        aiLockPath,
        "--out",
        output,
        "--project",
        "tex64-test",
      ],
      { cwd: projectRoot, stdio: "pipe" },
    );
    const notice = fs.readFileSync(output, "utf8");
    assert.match(notice, /- `package-lock\.json`/);
    assert.match(notice, /- `services\/tex64-ai\/package-lock\.json`/);
    assert.ok(notice.includes(tableNeedle(rootOnly)), "root dependency was lost");
    assert.ok(notice.includes(tableNeedle(aiOnly)), "standalone AI dependency was lost");
    assert.equal(
      notice.split(tableNeedle(shared)).length - 1,
      1,
      "a shared name@version must appear once",
    );
    assert.match(
      notice,
      new RegExp(`Package count: ${new Set([...rootRows.keys(), ...aiRows.keys()]).size}`),
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("distribution notice command always includes the standalone AI lockfile", () => {
  const command = require("../package.json").scripts["legal:notice"];
  assert.match(command, /--lock package-lock\.json/);
  assert.match(command, /--lock services\/tex64-ai\/package-lock\.json/);
});
