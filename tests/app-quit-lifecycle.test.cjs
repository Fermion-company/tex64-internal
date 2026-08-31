"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const mainSource = fs.readFileSync(
  path.join(__dirname, "..", "electron", "main.cjs"),
  "utf8",
);
const lifecycleStart = mainSource.indexOf("let quitPreparationSequence = 0;");
const lifecycleEnd = mainSource.indexOf("// Desktop capture IPC handler", lifecycleStart);
const quitLifecycle = mainSource.slice(lifecycleStart, lifecycleEnd);

test("native Quit waits for the exact renderer save acknowledgement", () => {
  assert.ok(lifecycleStart >= 0 && lifecycleEnd > lifecycleStart);
  assert.match(
    quitLifecycle,
    /webContents\.send\("tex64:message", \{\s*type: "prepareQuit",\s*payload: \{ requestId \}/,
  );
  assert.match(
    quitLifecycle,
    /event\.sender !== pending\.webContents[\s\S]*?message\.requestId !== pending\.requestId/,
  );
  assert.match(
    mainSource,
    /if \(type === "prepareQuit:result"\) \{\s*acceptRendererQuitPreparation\(event, message\);\s*return;/,
  );
  assert.match(
    quitLifecycle,
    /prepareRenderer: prepareRendererForQuit,[\s\S]*?prepareTimeoutMs: null/,
  );
});

test("one menu Quit uses the re-entrant coordinator and clears terminal hooks", () => {
  assert.match(
    quitLifecycle,
    /app\.on\("before-quit", \(event\) => \{\s*quitCoordinator\.handleBeforeQuit\(event\);/,
  );
  assert.match(
    quitLifecycle,
    /app\.on\("will-quit", \(\) => \{\s*quitCoordinator\.handleWillQuit\(\);/,
  );
  assert.match(
    quitLifecycle,
    /app\.on\("quit", \(\) => \{\s*quitCoordinator\.handleQuit\(\);/,
  );
  assert.doesNotMatch(quitLifecycle, /quitSessionFlushState/);
});

test("final teardown covers native writers and child processes", () => {
  for (const step of [
    "agentService.abort()",
    "buildHandlers.cancelAllBuilds()",
    "terminalService?.killAll()",
    "pdfWindowManager.close?.()",
    "aiWebService?.shutdown?.()",
    "texlabService?.shutdown?.()",
    "texizeService?.shutdown?.()",
    "tdomEngineService?.shutdown?.()",
  ]) {
    assert.ok(quitLifecycle.includes(step), `missing quit teardown: ${step}`);
  }
  assert.match(quitLifecycle, /forceExit: \(code\) => app\.exit\(code\)/);
});
