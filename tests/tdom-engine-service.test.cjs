"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
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

test("TdomEngineService serves packaged MathLive assets from app.asar.unpacked", () => {
  const resourcesPath = "/fake/TeX64.app/Contents/Resources";
  const unpackedWeb = path.join(resourcesPath, "app.asar.unpacked", "Resources", "web");
  const service = new TdomEngineService({
    engineDir: fixtureDir,
    resourcesPath,
    existsSync: (candidate) => candidate === unpackedWeb || candidate === path.join(fixtureDir, "server.js"),
  });
  service.port = 4646;
  assert.equal(service.hostWebRoot, unpackedWeb);
  assert.equal(service.buildSpawnEnv().TDOM_HOST_WEB_ROOT, unpackedWeb);
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

  // The active file path is part of document identity. Switching projects
  // with identical text must still reopen so relative images/includes/.bib
  // resolve against the new project instead of the previous one.
  const projectFile = path.join(__dirname, "fixtures", "paper", "main.tex");
  await service.push({ source: "\\documentclass{article}\nhello world", path: projectFile });
  const afterSwitch = await new Promise((resolve, reject) => {
    http.get(`${service.url}/doc`, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch (e) { reject(e); } });
    }).on("error", reject);
  });
  assert.equal(afterSwitch.edits.at(-1).kind, "open");
  assert.equal(afterSwitch.edits.at(-1).filePath, path.resolve(projectFile));
});

test("TdomEngineService keeps the root document open and sends only changed unsaved overlays", async (t) => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-tdom-project-"));
  fs.mkdirSync(path.join(projectRoot, "sections"));
  fs.writeFileSync(path.join(projectRoot, "main.tex"), "ROOT\\n\\input{sections/intro}\\n", "utf8");
  fs.writeFileSync(path.join(projectRoot, "sections", "intro.tex"), "saved child", "utf8");
  const service = createService();
  t.after(() => {
    service.shutdown();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });
  try { await service.start(); }
  catch (error) { if (skippable(t, error)) return; throw error; }

  await service.push({
    workspaceRoot: projectRoot,
    rootFile: "main.tex",
    buffers: [{ path: "sections/intro.tex", text: "unsaved child A" }],
  });
  await service.push({
    workspaceRoot: projectRoot,
    rootFile: "main.tex",
    buffers: [
      { path: "sections/intro.tex", text: "unsaved child B" },
      { path: "refs.bib", text: "@book{draft,title={Draft}}" },
    ],
  });
  await service.push({
    workspaceRoot: projectRoot,
    rootFile: "main.tex",
    buffers: [{ path: "refs.bib", text: "@book{draft,title={Draft}}" }],
  });

  const http = require("node:http");
  const doc = await new Promise((resolve, reject) => {
    http.get(`${service.url}/doc`, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch (e) { reject(e); } });
    }).on("error", reject);
  });
  assert.equal(doc.source, "ROOT\\n\\input{sections/intro}\\n", "active child edits never replace the root source");
  const opened = doc.edits.at(-3);
  assert.equal(opened.kind, "open");
  assert.equal(opened.filePath, path.join(projectRoot, "main.tex"));
  assert.equal(opened.projectRoot, projectRoot);
  assert.deepEqual(opened.overlays, [
    { filePath: path.join(projectRoot, "sections", "intro.tex"), text: "unsaved child A" },
  ]);
  const changed = doc.edits.at(-2);
  assert.equal(changed.kind, "edit");
  assert.deepEqual(changed.overlays, [
    { filePath: path.join(projectRoot, "sections", "intro.tex"), text: "unsaved child B" },
    { filePath: path.join(projectRoot, "refs.bib"), text: "@book{draft,title={Draft}}" },
  ]);
  assert.equal(changed.text, "", "an overlay-only change does not rewrite the root document");
  assert.deepEqual(doc.edits.at(-1).removeOverlays, [path.join(projectRoot, "sections", "intro.tex")]);
});
