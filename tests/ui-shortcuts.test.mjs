import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import { initUiEvents } from "../Resources/web/app/ui-events.js";

test("Cmd/Ctrl+Enter never builds; build remains a button-only action", () => {
  const previousWindow = globalThis.window;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousHTMLButtonElement = globalThis.HTMLButtonElement;
  const listeners = new Map();
  globalThis.window = {
    addEventListener: (type, listener) => listeners.set(type, listener),
  };
  globalThis.HTMLElement = class HTMLElement {};
  globalThis.HTMLButtonElement = class HTMLButtonElement extends globalThis.HTMLElement {};

  let saves = 0;
  try {
    const ui = initUiEvents(
      {
        dom: {
          tabs: [],
          editorHost: null,
          editorHostSecondary: null,
          diffModalSubmit: null,
          diffModalCancel: null,
          saveButton: null,
        },
      },
      {
        setActiveTab: () => {},
        normalizeTabKey: () => "files",
        getCurrentIssues: () => [],
        fileTree: { setTreeFocus: () => {} },
        diffModal: { getDiffContext: () => null, closeDiffModal: () => {} },
        buildOps: {
          setupActionButtons: () => {},
        },
        rootSelectorUi: { setupActions: () => {} },
        saveCurrentFile: () => {
          saves += 1;
        },
      },
    );
    ui.setup();
    const keydown = listeners.get("keydown");
    assert.equal(typeof keydown, "function");

    let prevented = false;
    keydown({
      altKey: false,
      ctrlKey: false,
      defaultPrevented: false,
      key: "Enter",
      metaKey: true,
      shiftKey: false,
      target: null,
      preventDefault: () => {
        prevented = true;
      },
    });
    assert.equal(prevented, false);

    keydown({
      ctrlKey: true,
      key: "s",
      metaKey: false,
      preventDefault: () => {},
    });
    assert.equal(saves, 1);
  } finally {
    globalThis.window = previousWindow;
    globalThis.HTMLElement = previousHTMLElement;
    globalThis.HTMLButtonElement = previousHTMLButtonElement;
  }
});

test("native menu and renderer command routing expose no build shortcut", async () => {
  const [menuSource, rendererSource, initSource] = await Promise.all([
    fs.readFile(new URL("../electron/app-menu.cjs", import.meta.url), "utf8"),
    fs.readFile(new URL("../web-src/app/ui-events.ts", import.meta.url), "utf8"),
    fs.readFile(new URL("../web-src/main-init.ts", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(menuSource, /CmdOrCtrl\+Enter|document:build/);
  assert.doesNotMatch(rendererSource, /isBuildShortcutEvent|startBuild/);
  assert.doesNotMatch(initSource, /document:build/);
});
