"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { analyzeDisplayMath } = require("../electron/services/synctex/marker-box.cjs");

const src = (text) => text.split("\n");

test("outside a display there is nothing to pick", () => {
  assert.equal(analyzeDisplayMath(src("Plain text.\nMore text."), 1), null);
});

test("align rows: each row line picks its row, begin/end lines the whole display", () => {
  const lines = src([
    "\\begin{align}",      // 1
    "  a &= b \\\\",        // 2
    "  c &= d \\\\",        // 3
    "  e &= f",            // 4
    "\\end{align}",        // 5
  ].join("\n"));
  assert.deepEqual(analyzeDisplayMath(lines, 1), { closingLine: 5, all: true });
  assert.deepEqual(analyzeDisplayMath(lines, 2), { closingLine: 5, all: false, firstRow: 0, lastRow: 0, totalRows: 3 });
  assert.deepEqual(analyzeDisplayMath(lines, 4), { closingLine: 5, all: false, firstRow: 2, lastRow: 2, totalRows: 3 });
  assert.deepEqual(analyzeDisplayMath(lines, 5), { closingLine: 5, all: true });
});

test("two rows on one source line cover both; separators inside braces or inner environments do not count", () => {
  const lines = src([
    "\\begin{gather}",                                            // 1
    "  p = q \\\\ r = s \\\\",                                    // 2
    "  g = \\begin{cases} 1 \\\\ 0 \\end{cases} \\text{x\\\\y}", // 3
    "\\end{gather}",                                              // 4
  ].join("\n"));
  assert.deepEqual(analyzeDisplayMath(lines, 2), { closingLine: 4, all: false, firstRow: 0, lastRow: 1, totalRows: 3 });
  assert.deepEqual(analyzeDisplayMath(lines, 3), { closingLine: 4, all: false, firstRow: 2, lastRow: 2, totalRows: 3 });
});

test("split rows close on \\end{split}; an equation without rows is marked whole", () => {
  const lines = src([
    "\\begin{equation}",   // 1
    "  \\begin{split}",    // 2
    "    f &= g \\\\",      // 3
    "      &= h",          // 4
    "  \\end{split}",      // 5
    "\\end{equation}",     // 6
    "\\[ x = 1 \\]",       // 7
    "% \\begin{align} in a comment",
  ].join("\n"));
  assert.deepEqual(analyzeDisplayMath(lines, 4), { closingLine: 5, all: false, firstRow: 1, lastRow: 1, totalRows: 2 });
  assert.deepEqual(analyzeDisplayMath(lines, 2), { closingLine: 5, all: true });
  assert.deepEqual(analyzeDisplayMath(lines, 1), { closingLine: 6, all: true });
  assert.deepEqual(analyzeDisplayMath(lines, 7), { closingLine: 7, all: true });
  assert.equal(analyzeDisplayMath(lines, 8), null);
});
