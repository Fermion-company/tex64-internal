"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { MacFileAccessService } = require("../electron/services/mac-file-access.cjs");

const homeDir = "/Users/tester";

test("classify recognizes protected roots with path boundaries", () => {
  const service = new MacFileAccessService({ platform: "darwin", homeDir });
  assert.deepEqual(service.classify(`${homeDir}/Desktop/a`), { key: "desktop", root: `${homeDir}/Desktop` });
  assert.equal(service.classify(`${homeDir}/DesktopFoo`), null);
  assert.deepEqual(service.classify("/Volumes/X/y"), { key: "removable", root: "/Volumes" });
  assert.equal(service.classify("Desktop/a"), null);
  assert.equal(new MacFileAccessService({ platform: "win32", homeDir }).classify(`${homeDir}/Desktop/a`), null);
});

test("ensureAccess coalesces concurrent requests for a root", async () => {
  let calls = 0;
  const service = new MacFileAccessService({ platform: "darwin", homeDir, readdir: async () => {
    calls += 1;
    await new Promise((resolve) => setImmediate(resolve));
    return [];
  } });
  assert.deepEqual(await Promise.all(Array.from({ length: 5 }, () => service.ensureAccess("desktop"))),
    [true, true, true, true, true]);
  assert.equal(calls, 1);
});

test("ensureAccess remembers denial and notifies once", async () => {
  let reads = 0;
  let notices = 0;
  const service = new MacFileAccessService({
    platform: "darwin", homeDir,
    readdir: async () => { reads += 1; const error = new Error("denied"); error.code = "EPERM"; throw error; },
    dialog: { showMessageBox: async () => { notices += 1; return { response: 1 }; } },
  });
  assert.equal(await service.ensureAccess(`${homeDir}/Desktop/project`), false);
  assert.equal(await service.ensureAccess(`${homeDir}/Desktop/other`), false);
  assert.equal(reads, 1);
  assert.equal(notices, 1);
});

test("ensureAccess treats a missing protected root as granted", async () => {
  const service = new MacFileAccessService({ platform: "darwin", homeDir, readdir: async () => {
    const error = new Error("missing"); error.code = "ENOENT"; throw error;
  } });
  assert.equal(await service.ensureAccess("documents"), true);
  assert.equal(service.getState("documents"), "granted");
});

test("probeIfAllowed avoids unknown protected paths and runs after grant", async () => {
  let probes = 0;
  const service = new MacFileAccessService({ platform: "darwin", homeDir, readdir: async () => [] });
  const probe = () => { probes += 1; return "found"; };
  assert.equal(service.probeIfAllowed(`${homeDir}/Desktop/tool`, probe), null);
  assert.equal(probes, 0);
  await service.ensureAccess("desktop");
  assert.equal(service.probeIfAllowed(`${homeDir}/Desktop/tool`, probe), "found");
  assert.equal(probes, 1);
});
