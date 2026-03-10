import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  buildSystemPrompt,
  extractTextFromParts,
} = require("../../electron/services/agent.cjs");

test("extractTextFromParts joins only text parts", () => {
  assert.equal(
    extractTextFromParts([
      { text: "a" },
      { inlineData: { mimeType: "image/png", data: "abc" } },
      { text: "b" },
    ]),
    "a\nb"
  );
});

test("buildSystemPrompt does not include referenced file sections (lazy loading)", () => {
  const prompt = buildSystemPrompt(
    {
      activeFilePath: "",
      openFiles: [],
      contextControls: { includeSelection: false, includeOpenFiles: true, includeIssues: true },
    },
    "/workspace",
    {
      maxFileBytes: Number.POSITIVE_INFINITY,
      maxReadFiles: 16,
      blockedTopLevel: new Set(),
      allowedTopLevel: new Set(),
      textExtensions: null,
    },
    { allowRunCommand: false },
    {
      rootFileInfo: { path: "main.tex", source: "auto" },
    }
  );

  assert.match(prompt, /Root main tex: main\.tex/);
  assert.ok(!prompt.includes("## Referenced files"), "should not include referenced files section");
  assert.ok(!prompt.includes("## Referenced file snapshots"), "should not include referenced file snapshots");
});

test("buildSystemPrompt includes empty active file snapshot when provided", () => {
  const prompt = buildSystemPrompt(
    {
      activeFilePath: "empty.tex",
      activeFileContent: "",
      activeFileIsDirty: false,
      activeFileContentTruncated: false,
      openFiles: [],
      contextControls: { includeSelection: false, includeOpenFiles: true, includeIssues: true },
    },
    "/workspace",
    {
      maxFileBytes: Number.POSITIVE_INFINITY,
      maxReadFiles: 16,
      blockedTopLevel: new Set(),
      allowedTopLevel: new Set(),
      textExtensions: null,
    },
    { allowRunCommand: false },
    {}
  );

  assert.match(prompt, /## Active file snapshot/);
  assert.match(prompt, /- Active file: empty\.tex/);
});

test("buildSystemPrompt encourages read_file tool usage", () => {
  const prompt = buildSystemPrompt(
    {
      activeFilePath: "",
      openFiles: [],
      contextControls: { includeSelection: false, includeOpenFiles: true, includeIssues: true },
    },
    "/workspace",
    {
      maxFileBytes: Number.POSITIVE_INFINITY,
      maxReadFiles: 16,
      blockedTopLevel: new Set(),
      allowedTopLevel: new Set(),
      textExtensions: null,
    },
    { allowRunCommand: false },
    {}
  );

  assert.match(prompt, /read_file/);
  assert.match(prompt, /read_files/);
});
