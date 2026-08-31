"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "evidence", "public-workflows");
const manifestPath = path.join(root, "results", "manifest.json");
const hashFile = async (target) => crypto.createHash("sha256").update(await fsp.readFile(target)).digest("hex");

async function main() {
  const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
  assert.equal(manifest.schemaVersion, 1);
  assert.ok(manifest.files.length > 10);
  for (const entry of manifest.files) {
    assert.equal(entry.path.includes(".."), false, entry.path);
    const target = path.join(root, entry.path);
    const stat = await fsp.stat(target);
    assert.equal(stat.size, entry.bytes, entry.path);
    assert.equal(await hashFile(target), entry.sha256, entry.path);
  }

  const readResult = async (name) => JSON.parse(await fsp.readFile(path.join(root, "results", name), "utf8"));
  const review = await readResult("axiom-review.json");
  const repair = await readResult("axiom-repair.json");
  const citation = await readResult("arxiv-citation.json");
  const portability = await readResult("editor-exit-test.json");
  const benchmark = await readResult("math-suggest-regression.json");
  assert.equal(review.write.status, "applied");
  assert.equal(review.done.build.status, "success");
  assert.equal(review.undo.equalsOriginal, true);
  assert.equal(review.undo.build.status, "success");
  assert.equal(repair.firstCompilerResult.status, "failure");
  assert.equal(repair.retry.status, "success");
  assert.equal(citation.bibtex.writeStatus, "applied");
  assert.equal(citation.build.status, "success");
  assert.equal(portability.firstEditor.build.status, "success");
  assert.equal(portability.secondEditor.exitCode, 0);
  assert.equal(benchmark.currentRegressionTest.status, "pass");
  assert.equal(benchmark.historicalAggregate.releaseStatus, "blocked");
  process.stdout.write(`verified ${manifest.files.length} evidence files\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
