const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const indexHtml = readFileSync(join(__dirname, "..", "Resources", "web", "index.html"), "utf8");

test("build workflow copy explains the button-only build and Cmd+B bold input", () => {
  assert.match(
    indexHtml,
    /Builds are manual in this version: click the toolbar Build button to compile and refresh the PDF\./
  );
  assert.match(indexHtml, /Live auto-build is not available; Cmd\+B inserts \\textbf\{\}\./);
  assert.match(indexHtml, /id="build-button"[\s\S]*?title="Build"/);
  assert.doesNotMatch(indexHtml, /title="Build \(Cmd\+Enter\)/);
});

test("settings do not expose an auto-build compile toggle", () => {
  assert.doesNotMatch(indexHtml, /id="settings-auto-build"/);
  assert.doesNotMatch(indexHtml, />Auto-build</);
});
