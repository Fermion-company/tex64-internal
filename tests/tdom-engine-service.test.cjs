"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { TdomEngineService, diffEdit } = require("../electron/services/tdom-engine.cjs");

const fixtureDir = path.join(__dirname, "fixtures", "tdom-fake-engine");
const createService = () => new TdomEngineService({
  engineDir: fixtureDir,
  startTimeoutMs: 3_000,
  pollIntervalMs: 20,
});

const skippable = (t, error) => {
  if (error?.code === "EPERM" || /listen EPERM/.test(error?.message || "")) {
    t.skip("loopback listeners are blocked by this sandbox");
    return true;
  }
  return false;
};

test("diffEdit computes minimal prefix/suffix ranges", () => {
  assert.deepEqual(diffEdit("abc", "abXc"), { start: 2, end: 2, text: "X" });
  assert.deepEqual(diffEdit("abXc", "abc"), { start: 2, end: 3, text: "" });
  assert.deepEqual(diffEdit("hello world", "hello brave world"), { start: 6, end: 6, text: "brave " });
  assert.deepEqual(diffEdit("same", "same"), { start: 4, end: 4, text: "" });
  assert.deepEqual(diffEdit("", "new"), { start: 0, end: 0, text: "new" });
  const applied = (prev, next) => {
    const e = diffEdit(prev, next);
    return prev.slice(0, e.start) + e.text + prev.slice(e.end);
  };
  assert.equal(applied("\\section{A}\ntext", "\\section{B}\nmore text"), "\\section{B}\nmore text");
});

test("TdomEngineService resolves a vendored copy when no checkout exists", () => {
  const vendored = "/fake/resources/tdom-engine";
  const service = new TdomEngineService({
    homeDir: "/fake/home",
    vendoredDir: vendored,
    existsSync: (candidate) => candidate === path.join(vendored, "server.js"),
  });
  assert.equal(service.engineDir, vendored);
  assert.equal(service.isAvailable(), true);
});

test("TdomEngineService prefers a developer checkout over the vendored copy", () => {
  const vendored = "/fake/resources/tdom-engine";
  const checkout = path.join("/fake/home", "tdom-core");
  const service = new TdomEngineService({
    homeDir: "/fake/home",
    vendoredDir: vendored,
    existsSync: (candidate) =>
      candidate === path.join(vendored, "server.js") || candidate === path.join(checkout, "server.js"),
  });
  assert.equal(service.engineDir, checkout);
});

test("TdomEngineService spawn env pins the engine knobs", () => {
  const service = new TdomEngineService({ engineDir: fixtureDir, workDir: "/tmp/tdom-work" });
  service.port = 4646;
  const env = service.buildSpawnEnv();
  assert.equal(env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(env.PORT, "4646");
  assert.equal(env.TDOM_WORKDIR, "/tmp/tdom-work");
  assert.equal(env.TDOM_SAMPLE, process.env.TDOM_SAMPLE || "demo-lua.tex");
  assert.ok(Number(env.TDOM_MAX_CHECKPOINTS) >= 1);
  assert.ok(env.PATH.split(path.delimiter).includes("/opt/homebrew/bin"));
});

test("TdomEngineService boots on a sample that actually exists", () => {
  const engineDir = "/fake/engine";
  const service = new TdomEngineService({
    engineDir,
    existsSync: (candidate) =>
      candidate === path.join(engineDir, "server.js") ||
      candidate === path.join(engineDir, "samples", "minimal.tex"),
  });
  assert.equal(service.pickBootSample(), "minimal.tex");
  // No samples at all: fall back to the engine's own default and let it report.
  const bare = new TdomEngineService({ engineDir, existsSync: () => false });
  assert.equal(bare.pickBootSample(), "demo-lua.tex");
});

test("TdomEngineService starts the engine and streams minimal edits", async (t) => {
  const service = createService();
  t.after(() => service.shutdown());

  let started;
  try { started = await service.start(); }
  catch (error) { if (skippable(t, error)) return; throw error; }
  assert.equal(started.ok, true);
  assert.match(started.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(service.getStatus().state, "ready");

  // First push opens the document; the next push becomes a range edit.
  await service.push({ source: "\\documentclass{article}\nhello", fresh: true });
  await service.push({ source: "\\documentclass{article}\nhello world" });

  const http = require("node:http");
  const doc = await new Promise((resolve, reject) => {
    http.get(`${service.url}/doc`, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch (e) { reject(e); } });
    }).on("error", reject);
  });
  assert.equal(doc.source, "\\documentclass{article}\nhello world");
  assert.deepEqual(doc.edits[0], { kind: "open", text: "\\documentclass{article}\nhello" });
  assert.equal(doc.edits[1].kind, "edit");
  assert.equal(doc.edits[1].text, " world");
  assert.equal(doc.edits[1].end - doc.edits[1].start, 0);
});
