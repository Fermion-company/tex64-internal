const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { SynctexService } = require("../electron/services/synctex/service.cjs");

// One typeset line: an hbox at height `v` with `glyphs` characters of (tag, line).
const row = (tag, line, v, glyphs, h0 = 4000000) =>
  [`(${tag},${line}:${h0},${v}:26000000,600000,150000`,
    ...Array.from({ length: glyphs }, (_, i) => `x${tag},${line}:${h0 + i * 400000},${v}`),
    ")"];
const page = (number, rows) =>
  [`{${number}`, "[1,1:4000000,50000000:26000000,46000000,0", ...rows.flat(), "]", `}${number}`];

const project = (pages) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-fwd-page-"));
  const main = path.join(dir, "main.tex");
  const part = path.join(dir, "part.tex");
  fs.writeFileSync(main, "\\input{part}\n");
  fs.writeFileSync(part, "\\part{Two}\n");
  fs.writeFileSync(path.join(dir, "main.pdf"), "%PDF-1.5\n");
  fs.writeFileSync(path.join(dir, "main.synctex"), [
    "SyncTeX Version:1", `Input:1:${main}`, `Input:2:${part}`, "Output:pdf",
    "Magnification:1000", "Unit:1", "X Offset:0", "Y Offset:0", "Content:",
    ...pages.flat(), "Postamble:", "Count:0", "",
  ].join("\n"));
  return { dir, main, part, pdf: path.join(dir, "main.pdf") };
};

const pageOf = (files, line) => {
  const service = new SynctexService({});
  const quick = service.forwardLinesQuick({ sourcePath: files.part, pdfPath: files.pdf, lines: [line], firstSubstantialPage: true });
  assert.equal(quick.ok, true, quick.error);
  return quick.results[0].page;
};

test("a page that draws boxes while it ships is not where the line that shipped it appears", () => {
  // Page 1: the end of a chapter, 20 lines of its own text, plus what the page
  // drew at shipout (frames, a thumb index, overlays), all stamped with the
  // \part line that shipped it: 60 glyphs from top to bottom.
  const chapter = Array.from({ length: 20 }, (_, i) => row(1, 10 + i, 5000000 + i * 2000000, 40));
  const stamps = Array.from({ length: 12 }, (_, i) => row(2, 1, 4500000 + i * 3600000, 5, 31000000));
  // Page 2: the part's own page, one heading.
  const files = project([page(1, [...chapter, ...stamps]), page(2, [row(2, 1, 9000000, 18)])]);
  try {
    assert.equal(pageOf(files, 1), 2);
  } finally {
    fs.rmSync(files.dir, { recursive: true, force: true });
  }
});

test("a paragraph that fills most of a page and runs on to the next still begins on the first", () => {
  const paragraph = Array.from({ length: 16 }, (_, i) => row(2, 1, 9000000 + i * 2400000, 40));
  const above = [row(1, 10, 5000000, 40), row(1, 11, 7000000, 40)];
  const files = project([page(1, [...above, ...paragraph]), page(2, [row(2, 1, 5000000, 40), row(2, 1, 7000000, 12)])]);
  try {
    assert.equal(pageOf(files, 1), 1);
  } finally {
    fs.rmSync(files.dir, { recursive: true, force: true });
  }
});
