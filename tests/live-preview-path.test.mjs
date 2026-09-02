import assert from "node:assert/strict";
import test from "node:test";

import { resolveLivePreviewWorkspacePath } from "../Resources/web/app/live-preview-path.js";

test("live preview source paths stay inside the active workspace", () => {
  assert.equal(
    resolveLivePreviewWorkspacePath("/work/paper/sections/intro.tex", "/work/paper"),
    "sections/intro.tex"
  );
  assert.equal(
    resolveLivePreviewWorkspacePath("./sections/intro.tex", "/work/paper"),
    "sections/intro.tex"
  );
  assert.equal(
    resolveLivePreviewWorkspacePath("C:\\Work\\Paper\\main.tex", "c:\\work\\paper"),
    "main.tex"
  );
  assert.equal(resolveLivePreviewWorkspacePath("/main.tex", "/"), "main.tex");
});

test("live preview source paths reject traversal and prefix lookalikes", () => {
  assert.equal(resolveLivePreviewWorkspacePath("../other/main.tex", "/work/paper"), null);
  assert.equal(resolveLivePreviewWorkspacePath("/work/paper-old/main.tex", "/work/paper"), null);
  assert.equal(resolveLivePreviewWorkspacePath("D:\\other\\main.tex", "C:\\work\\paper"), null);
  assert.equal(resolveLivePreviewWorkspacePath("C:..\\other\\main.tex", "C:\\work\\paper"), null);
  assert.equal(resolveLivePreviewWorkspacePath("main.tex\0ignored", "/work/paper"), null);
});
