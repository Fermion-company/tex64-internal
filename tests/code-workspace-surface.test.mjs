import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("Code uses the ordinary editor-session viewer without a fixed preview pane", () => {
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
  assert.doesNotMatch(html, /id="pro-preview-pdf"|id="pro-preview-pane"/);
  assert.match(html, /id="editor-viewer-pdf"/);
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
  // The terminal is now a tab strip plus one or two panes; both the frame and
  // each pane take their ground from the theme.
  assert.match(css, /\.terminal-area\s*\{[^}]*background:\s*var\(--terminal-bg\)/s);
  assert.match(css, /\.terminal-view\s*\{[^}]*background:\s*var\(--terminal-bg\)/s);
  assert.match(css, /:root\[data-theme="light"\][\s\S]*--terminal-bg:\s*#f8fafc/i);
});

test("the terminal panel offers more than one shell", () => {
  const html = read("../Resources/web/index.html");
  const ui = read("../web-src/app/terminal-ui.ts");
  // Issue #38 asked for tabs, splitting and a detachable window; the markup
  // carries the strip and the pane host, and the UI owns the three actions.
  assert.match(html, /id="terminal-tabs"/);
  assert.match(html, /id="terminal-panes"/);
  assert.match(ui, /const newSession =/);
  assert.match(ui, /const toggleSplit =/);
  assert.match(ui, /const openInNewWindow =/);
  // A shell that exited must accept a keystroke and come back rather than
  // swallowing input, which is what read as "commands stopped working".
  assert.match(ui, /if \(!session\.sessionId\) \{[\s\S]*startPty\(session\)/);
});

test("every topbar control uses an SVG and consistent accessible states", () => {
  const html = read("../Resources/web/index.html");
  const css = read("../Resources/web/theme.css");
  const buildOps = read("../web-src/app/build-ops-ui.ts");
  const topbar = html.match(/<header class="topbar">([\s\S]*?)<\/header>/)?.[1] ?? "";
  const buttons = [...topbar.matchAll(/<button\b[\s\S]*?<\/button>/g)].map((match) => match[0]);

  assert.ok(buttons.length >= 8, "expected the complete Code topbar button set");
  for (const button of buttons) {
    assert.match(button, /<svg\b/, `topbar button is missing an SVG: ${button.slice(0, 120)}`);
  }

  const byId = (id) => buttons.find((button) => button.includes(`id="${id}"`)) ?? "";
  assert.doesNotMatch(byId("pro-canvas-open"), /[✎⊞]/);
  assert.match(byId("format-button"), /<svg\b[\s\S]*<span>Format<\/span>/);
  assert.match(byId("synctex-button"), /<svg\b[\s\S]*class="synctex-button-label"/);
  for (const id of ["toggle-sidebar-button", "toggle-bottom-panel-button", "build-button"]) {
    assert.match(byId(id), /aria-label="[^"]+"/);
    assert.match(byId(id), /title="[^"]+"/);
  }
  assert.match(css, /\.build-button-label\s*\{\s*display:\s*none;/);
  assert.match(css, /\.topbar-layout-toggle:focus-visible[\s\S]*outline:\s*2px solid var\(--focus-ring\)/);
  assert.doesNotMatch(buildOps, /synctexButton\.textContent\s*=/);
});
