import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveSynctexForwardPdfPath,
  resolveSynctexForwardTarget,
} from "../Resources/web/app/build-ops-ui.js";

test("SyncTeX jump keeps the active TeX file as its first automatic target", () => {
  assert.equal(
    resolveSynctexForwardTarget(null, "chapters/result.tex", "main.tex", "main.tex"),
    "chapters/result.tex"
  );
});

test("SyncTeX jump falls back from a PDF tab to the last built TeX file", () => {
  assert.equal(
    resolveSynctexForwardTarget(null, "main.pdf", "book.tex", "main.tex"),
    "book.tex"
  );
});

test("SyncTeX jump falls back to the root TeX file without a built target", () => {
  assert.equal(
    resolveSynctexForwardTarget(null, "references.bib", null, "main.TEX"),
    "main.TEX"
  );
  assert.equal(resolveSynctexForwardTarget(null, "main.pdf", null, null), null);
});

test("an explicit TeX target takes priority over the active editor", () => {
  assert.equal(
    resolveSynctexForwardTarget("appendix.tex", "main.tex", "book.tex", "root.tex"),
    "appendix.tex"
  );
});

test("SyncTeX derives a usable PDF path before this app session has built", () => {
  assert.equal(resolveSynctexForwardPdfPath(null, "main.tex"), "main.pdf");
  assert.equal(resolveSynctexForwardPdfPath("book.TEX", "main.tex"), "book.pdf");
  assert.equal(resolveSynctexForwardPdfPath(null, null), null);
});

test("clicking Jump from a PDF tab sends the last built TeX cursor to native SyncTeX", async () => {
  const PreviousElement = globalThis.HTMLElement;
  const PreviousButton = globalThis.HTMLButtonElement;
  const PreviousWindow = globalThis.window;
  class FakeElement extends EventTarget {}
  class FakeButton extends FakeElement {
    disabled = false;
    style = {};
    querySelector() {
      return null;
    }
    click() {
      this.dispatchEvent(new Event("click"));
    }
  }
  globalThis.HTMLElement = FakeElement;
  globalThis.HTMLButtonElement = FakeButton;
  globalThis.window = { setTimeout };

  try {
    const sent = [];
    const synced = [];
    const jumpButton = new FakeButton();
    const activeGroup = {
      key: "secondary",
      root: null,
      tabs: null,
      tabsList: null,
      editorHost: null,
      currentFilePath: "main.pdf",
      currentFileSavedContent: null,
      editor: null,
      openTabs: ["main.pdf"],
      viewer: { getViewerMode: () => "pdf", syncPdf: (payload) => synced.push(payload) },
      isDirty: false,
      viewStates: new Map(),
      isApplyingFile: false,
      isComposing: false,
      compositionText: "",
      composingFilePath: null,
      pendingCompositionAction: null,
    };
    const { initBuildOpsUi } = await import("../Resources/web/app/build-ops-ui.js");
    const api = initBuildOpsUi(
      { dom: { buildButton: null, formatButton: null, synctexButton: jumpButton, issuesLog: null, issuesLogContent: null } },
      {
        getActiveGroup: () => activeGroup,
        getActiveEditorGroupKey: () => "secondary",
        getActiveFilePath: () => "main.pdf",
        getRootFilePath: () => "main.tex",
        getLastBuildMainFile: () => "book.tex",
        setLastBuildMainFile: () => {},
        getStoredCursorPosition: (path) => path === "book.tex" ? { line: 42, column: 7 } : null,
        cacheCurrentBuffer: () => {},
        saveCurrentFile: async () => true,
        postToNative: (payload) => { sent.push(payload); return true; },
        updateIssues: () => {},
        setPendingBuildIssuesFocus: () => {},
        applyFormattedContent: () => {},
        getEditorGroups: () => [activeGroup],
        renderEditorTabs: () => {},
        requestOpenFile: () => true,
        getSplitViewEnabled: () => true,
        setSplitViewEnabled: () => {},
        settings: {
          getPdfViewerMode: () => "tab",
          getAutoSynctexOnBuildEnabled: () => false,
          buildFormatSettingsPayload: () => ({}),
          getRuntimeStatusSummary: () => null,
          checkEnvironmentStatus: () => {},
        },
      }
    );
    api.setupActionButtons();
    jumpButton.click();

    assert.equal(sent.length, 1);
    assert.deepEqual(
      { type: sent[0].type, path: sent[0].path, pdfPath: sent[0].pdfPath, line: sent[0].line, column: sent[0].column },
      { type: "synctex:forward", path: "book.tex", pdfPath: "book.pdf", line: 42, column: 7 }
    );
    api.handleSynctexForwardResult({
      ok: true,
      requestId: sent[0].requestId,
      pdfPath: "book.pdf",
      page: 3,
      x: 120,
      y: 240,
    });
    assert.deepEqual(synced, [{
      page: 3,
      x: 120,
      y: 240,
      sourceFile: "book.tex",
      sourceLine: 42,
      sourceColumn: 7,
    }]);
  } finally {
    globalThis.HTMLElement = PreviousElement;
    globalThis.HTMLButtonElement = PreviousButton;
    globalThis.window = PreviousWindow;
  }
});
