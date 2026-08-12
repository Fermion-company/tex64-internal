"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const http = require("node:http");
const { FermionEngineService } = require("../electron/services/fermion-engine.cjs");

const fixture = path.join(__dirname, "fixtures", "fermion-fake-engine.cjs");
const createService = () => new FermionEngineService({
  engineDir: __dirname,
  nodePath: process.execPath,
  serverScript: path.relative(__dirname, fixture),
  port: 4633,
  startTimeoutMs: 2_000,
  pollIntervalMs: 20,
});

const waitForStopped = (service) => new Promise((resolve, reject) => {
  const deadline = Date.now() + 1_000;
  const poll = () => {
    if (!service.isRunning()) return resolve();
    if (Date.now() > deadline) return reject(new Error("fake fermion did not stop"));
    setTimeout(poll, 10);
  };
  poll();
});

test("FermionEngineService starts, returns its URL, and restarts after death", async (t) => {
  const service = createService();
  t.after(() => service.shutdown());

  let first;
  try { first = await service.start(); }
  catch (error) {
    if (error?.code === "EPERM" || /listen EPERM/.test(error?.message || "")) return t.skip("loopback listeners are blocked by this sandbox");
    throw error;
  }
  assert.equal(first.ok, true);
  assert.match(first.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(first.backend, "fake");
  const firstPid = service.proc.pid;

  service.proc.kill("SIGTERM");
  await waitForStopped(service);

  const second = await service.start();
  assert.equal(second.ok, true);
  assert.notEqual(service.proc.pid, firstPid);
  assert.equal(service.getStatus().state, "ready");
});

test("FermionEngineService pushes a full source replacement", async (t) => {
  const service = createService();
  t.after(() => service.shutdown());
  let result;
  try { result = await service.push({ source: "\\documentclass{article}\nhello" }); }
  catch (error) {
    if (error?.code === "EPERM" || /listen EPERM/.test(error?.message || "")) return t.skip("loopback listeners are blocked by this sandbox");
    throw error;
  }
  assert.equal(result.ok, true);
  assert.equal(result.report.source, "\\documentclass{article}\nhello");
});

test("FermionEngineService renderPdf returns the edit report and base64 PDF", async (t) => {
  let source = "old";
  const pdf = Buffer.from("%PDF-1.7\ncanvas fixture");
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/doc") return res.end(JSON.stringify({ source }));
    if (req.method === "POST" && req.url === "/edit") {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      return req.on("end", () => {
        const edit = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
        res.end(JSON.stringify({ source, errors: [] }));
      });
    }
    if (req.method === "GET" && req.url === "/pdf") { res.setHeader("Content-Type", "application/pdf"); return res.end(pdf); }
    res.statusCode = 404; res.end("not found");
  });
  try { await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }); }
  catch (error) { if (error?.code === "EPERM") return t.skip("loopback listeners are blocked by this sandbox"); throw error; }
  t.after(() => server.close());
  const address = server.address();
  const service = new FermionEngineService({ engineDir: __dirname });
  service.port = address.port;
  service.start = async () => ({ ok: true, url: service.url });
  const result = await service.renderPdf({ source: "new canvas source" });
  assert.deepEqual(result, { ok: true, report: { source: "new canvas source", errors: [] }, pdfBase64: pdf.toString("base64") });
});
