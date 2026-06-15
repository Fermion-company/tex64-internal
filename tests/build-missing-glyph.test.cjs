const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { BuildService } = require("../electron/services/build.cjs");
const { WorkspaceManager } = require("../electron/services/workspace.cjs");

const missingGlyphLog = String.raw`(./main.tex
[1
Missing character: There is no 日 (U+65E5) in font [lmroman10-regular]:+tlig;!
Missing character: There is no 한 (U+D55C) in font file:HaranoAjiMincho-Regular.otf:-kern;jfm=ujis!
] (./main.aux)
Output written on main.pdf (1 page, 1234 bytes).
Latexmk: All targets (main.pdf) are up-to-date
`;

test("parseIssues reports missing glyphs as blocking errors", () => {
  const service = new BuildService();
  const issues = service.parseIssues(missingGlyphLog, "/tmp/workspace");

  assert.equal(issues.length, 2);
  assert.equal(issues[0].severity, "error");
  assert.equal(issues[0].code, "missing-glyph");
  assert.equal(issues[0].character, "日");
  assert.equal(issues[0].codePoint, "U+65E5");
  assert.match(issues[0].message, /PDFで表示できない文字/);
  assert.equal(issues[1].character, "한");
  assert.equal(issues[1].codePoint, "U+D55C");
});

test("runBuild fails instead of showing a PDF with missing glyphs", async () => {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-missing-glyph-"));
  fs.writeFileSync(path.join(rootPath, "main.tex"), "\\documentclass{article}\\begin{document}日本語\\end{document}");
  const pdfPath = path.join(rootPath, "main.pdf");
  fs.writeFileSync(pdfPath, "%PDF-1.7\n");

  const service = new BuildService();
  service.resolveLatexmkProfile = () => ({
    outDir: null,
    extraArgs: [],
    hasExplicitOutDirArg: false,
    outDirRequested: false,
  });
  service.runLatexmk = async () => ({ status: 0, output: missingGlyphLog });
  service.resolvePdfPathAfterBuild = () => pdfPath;

  const result = await service.runBuild(rootPath, "main.tex", "lualatex", null);

  assert.equal(result.kind, "failure");
  assert.match(result.summary, /PDFで表示できない文字/);
  assert.equal(result.issues.length, 2);
  assert.equal(result.issues[0].code, "missing-glyph");
});

test("Chinese project template pins the TeX Live Fandol fontset", () => {
  const manager = new WorkspaceManager();
  const template = manager.templateContent("zh");

  assert.match(template, /fontset=fandol/);
  assert.match(template, /\\documentclass\[UTF8,a4paper,11pt,fontset=fandol\]\{ctexart\}/);
});
