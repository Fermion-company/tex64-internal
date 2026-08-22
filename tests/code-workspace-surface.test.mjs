import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("Code uses the ordinary viewer without redundant pane controls", () => {
  const html = read("../Resources/web/index.html");
  for (const obsolete of [
    "data-pro-capture",
    "data-pro-open",
    "data-pro-collapse",
    "pro-structure-button",
    "pro-structure-drawer",
    "pro-pane-header",
    "data-tab=\"stash\"",
    "data-panel=\"stash\"",
  ]) {
    assert.doesNotMatch(html, new RegExp(obsolete));
  }
  assert.match(html, /id="pro-preview-pdf"/);
});

test("the retired Pro stash is not initialized", () => {
  const source = read("../web-src/main-init.ts");
  const config = read("../web-src/app/config.ts");
  assert.doesNotMatch(source, /pro-stash-ui|initProStashUi/);
  assert.doesNotMatch(config, /["']stash["']/);
});

test("PDF theming never inverts document pixels", () => {
  const html = read("../Resources/web/pdf-viewer.html");
  const css = read("../Resources/web/pdf-viewer.css");
  const script = read("../Resources/web/pdf-viewer.js");
  assert.doesNotMatch(html, /pdf-invert/);
  assert.doesNotMatch(css, /is-inverted|invert\(/);
  assert.doesNotMatch(script, /is-inverted|tex64\.pdf\.invert/);
  assert.match(css, /:root\[data-theme="light"\]/);
});

test("the integrated terminal uses theme colors instead of a dark frame", () => {
  const css = read("../Resources/web/theme.css");
  assert.match(css, /\.terminal-host\s*\{[^}]*background:\s*var\(--terminal-bg\)/s);
  assert.match(css, /:root\[data-theme="light"\][\s\S]*--terminal-bg:\s*#f8fafc/i);
});
