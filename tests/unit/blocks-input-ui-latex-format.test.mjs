import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeLegacyEnvMarkers,
  normalizeMatrixSyntax,
  shouldWrapAligned,
  stripEmptyAlignedRows,
  unwrapAligned,
  wrapAligned,
} from "../../Resources/web/app/blocks/input-ui-latex-format.js";

// ─── shouldWrapAligned ──────────────────────────────────────────────

test("shouldWrapAligned: empty / null-ish inputs return false", () => {
  assert.equal(shouldWrapAligned(""), false);
  assert.equal(shouldWrapAligned(null), false);
  assert.equal(shouldWrapAligned(undefined), false);
});

test("shouldWrapAligned: plain text without & or \\\\ returns false", () => {
  assert.equal(shouldWrapAligned("x+y=z"), false);
  assert.equal(shouldWrapAligned("\\alpha + \\beta"), false);
});

test("shouldWrapAligned: unescaped & triggers true", () => {
  assert.equal(shouldWrapAligned("a&b"), true);
  assert.equal(shouldWrapAligned("x & y & z"), true);
});

test("shouldWrapAligned: escaped \\& does NOT trigger", () => {
  assert.equal(shouldWrapAligned("a\\&b"), false);
  assert.equal(shouldWrapAligned("\\&"), false);
});

test("shouldWrapAligned: double-escaped backslash before & (\\\\\\\\&) triggers", () => {
  // Four backslashes → two escaped backslashes → line break, then &
  assert.equal(shouldWrapAligned("a\\\\&b"), true);
});

test("shouldWrapAligned: unescaped \\\\ (line break) triggers true", () => {
  assert.equal(shouldWrapAligned("a\\\\b"), true);
  assert.equal(shouldWrapAligned("x \\\\ y"), true);
});

test("shouldWrapAligned: skips text containing \\begin{ or \\end{", () => {
  assert.equal(shouldWrapAligned("\\begin{aligned}a&b\\end{aligned}"), false);
  assert.equal(shouldWrapAligned("\\begin{cases}x\\\\y\\end{cases}"), false);
  assert.equal(shouldWrapAligned("\\begin{matrix}a&b\\end{matrix}"), false);
  assert.equal(shouldWrapAligned("\\begin{pmatrix}1\\\\2\\end{pmatrix}"), false);
});

// ─── wrapAligned / unwrapAligned ────────────────────────────────────

test("wrapAligned produces correct format", () => {
  assert.equal(wrapAligned("a&b"), "\\begin{aligned}\na&b\n\\end{aligned}");
  assert.equal(wrapAligned(""), "\\begin{aligned}\n\n\\end{aligned}");
});

test("unwrapAligned: standard round-trip", () => {
  const inner = "a & b \\\\ c & d";
  const wrapped = wrapAligned(inner);
  const result = unwrapAligned(wrapped);
  assert.deepEqual(result, { value: inner, didUnwrap: true });
});

test("unwrapAligned: refuses if content before or after", () => {
  assert.deepEqual(
    unwrapAligned("prefix \\begin{aligned}a&b\\end{aligned}"),
    { value: "prefix \\begin{aligned}a&b\\end{aligned}", didUnwrap: false }
  );
  assert.deepEqual(
    unwrapAligned("\\begin{aligned}a&b\\end{aligned} suffix"),
    { value: "\\begin{aligned}a&b\\end{aligned} suffix", didUnwrap: false }
  );
});

test("unwrapAligned: returns original if no aligned environment found", () => {
  assert.deepEqual(unwrapAligned("x+y"), { value: "x+y", didUnwrap: false });
  assert.deepEqual(unwrapAligned(""), { value: "", didUnwrap: false });
});

test("unwrapAligned: strips leading/trailing newlines inside aligned", () => {
  const input = "\\begin{aligned}\nx=1\n\\end{aligned}";
  assert.deepEqual(unwrapAligned(input), { value: "x=1", didUnwrap: true });
});

test("unwrapAligned: no extra stripping if no newlines present", () => {
  const input = "\\begin{aligned}x=1\\end{aligned}";
  assert.deepEqual(unwrapAligned(input), { value: "x=1", didUnwrap: true });
});

// ─── stripEmptyAlignedRows ──────────────────────────────────────────

test("stripEmptyAlignedRows: single row is always preserved", () => {
  assert.equal(stripEmptyAlignedRows("x"), "x");
  assert.equal(stripEmptyAlignedRows(""), "");
  assert.equal(stripEmptyAlignedRows("\\placeholder{}"), "\\placeholder{}");
  assert.equal(stripEmptyAlignedRows("&"), "&");
});

test("stripEmptyAlignedRows: strips trailing empty rows only", () => {
  assert.equal(stripEmptyAlignedRows("x\\\\&"), "x");
  assert.equal(stripEmptyAlignedRows("x\\\\&\\\\&"), "x");
  assert.equal(stripEmptyAlignedRows("x\\\\y\\\\&"), "x\\\\y");
});

test("stripEmptyAlignedRows: preserves non-empty trailing rows", () => {
  assert.equal(stripEmptyAlignedRows("x\\\\y"), "x\\\\y");
  assert.equal(stripEmptyAlignedRows("a&b\\\\c&d"), "a&b\\\\c&d");
});

test("stripEmptyAlignedRows: empty middle rows are preserved", () => {
  assert.equal(stripEmptyAlignedRows("x\\\\&\\\\y"), "x\\\\&\\\\y");
  assert.equal(
    stripEmptyAlignedRows("x\\\\\\placeholder{}\\\\y"),
    "x\\\\\\placeholder{}\\\\y"
  );
});

test("stripEmptyAlignedRows: first row is never deleted even if empty", () => {
  assert.equal(stripEmptyAlignedRows("\\placeholder{}\\\\&"), "\\placeholder{}");
  assert.equal(stripEmptyAlignedRows("&\\\\&"), "&");
});

test("stripEmptyAlignedRows: placeholder-only rows count as empty", () => {
  assert.equal(stripEmptyAlignedRows("x\\\\\\placeholder{}"), "x");
});

test("stripEmptyAlignedRows: rows with actual content are not empty", () => {
  const input = "x\\\\a&b";
  assert.equal(stripEmptyAlignedRows(input), input);
});

// ─── normalizeMatrixSyntax ──────────────────────────────────────────

test("normalizeMatrixSyntax: 2×2 matrix from 4 braced cells", () => {
  assert.equal(
    normalizeMatrixSyntax("\\begin{matrix}{a}{b}{c}{d}\\end{matrix}"),
    "\\begin{matrix}a&b\\\\c&d\\end{matrix}"
  );
});

test("normalizeMatrixSyntax: 2×3 from 6 braced cells (bmatrix)", () => {
  assert.equal(
    normalizeMatrixSyntax("\\begin{bmatrix}{a}{b}{c}{d}{e}{f}\\end{bmatrix}"),
    "\\begin{bmatrix}a&b&c\\\\d&e&f\\end{bmatrix}"
  );
});

test("normalizeMatrixSyntax: all matrix environment variants", () => {
  for (const env of ["matrix", "pmatrix", "bmatrix", "Bmatrix", "vmatrix", "Vmatrix", "smallmatrix"]) {
    const input = `\\begin{${env}}{1}{2}{3}{4}\\end{${env}}`;
    const expected = `\\begin{${env}}1&2\\\\3&4\\end{${env}}`;
    assert.equal(normalizeMatrixSyntax(input), expected, `failed for ${env}`);
  }
});

test("normalizeMatrixSyntax: 3 cells (not factorizable) → unchanged", () => {
  const input = "\\begin{matrix}{a}{b}{c}\\end{matrix}";
  assert.equal(normalizeMatrixSyntax(input), input);
});

test("normalizeMatrixSyntax: already has & or \\\\ → unchanged", () => {
  const withAmp = "\\begin{matrix}a&b\\\\c&d\\end{matrix}";
  assert.equal(normalizeMatrixSyntax(withAmp), withAmp);

  const withBreak = "\\begin{matrix}a\\\\b\\end{matrix}";
  assert.equal(normalizeMatrixSyntax(withBreak), withBreak);
});

test("normalizeMatrixSyntax: unrecognized environment name → unchanged", () => {
  const input = "\\begin{|matrix}{a}{b}{c}{d}\\end{|matrix}";
  assert.equal(normalizeMatrixSyntax(input), input);
});

test("normalizeMatrixSyntax: mixed content (not all braced) → unchanged", () => {
  const mixed = "\\begin{matrix}{a}\\label{eq:mx}{c}{d}\\end{matrix}";
  assert.equal(normalizeMatrixSyntax(mixed), mixed);
});

test("normalizeMatrixSyntax: unbraced body → unchanged", () => {
  const input = "\\begin{matrix}\\operatorname{Var}(X)\\end{matrix}";
  assert.equal(normalizeMatrixSyntax(input), input);
});

test("normalizeMatrixSyntax: nested braces within cells are preserved", () => {
  assert.equal(
    normalizeMatrixSyntax("\\begin{matrix}{\\frac{1}{2}}{b}{c}{d}\\end{matrix}"),
    "\\begin{matrix}\\frac{1}{2}&b\\\\c&d\\end{matrix}"
  );
});

test("normalizeMatrixSyntax: empty input", () => {
  assert.equal(normalizeMatrixSyntax(""), "");
  assert.equal(normalizeMatrixSyntax(null), null);
  assert.equal(normalizeMatrixSyntax(undefined), undefined);
});

test("normalizeMatrixSyntax: 9 cells → 3×3", () => {
  const cells = Array.from({ length: 9 }, (_, i) => `{${i + 1}}`).join("");
  const input = `\\begin{matrix}${cells}\\end{matrix}`;
  assert.equal(
    normalizeMatrixSyntax(input),
    "\\begin{matrix}1&2&3\\\\4&5&6\\\\7&8&9\\end{matrix}"
  );
});

test("normalizeMatrixSyntax: empty braced cells → unchanged (filtered by empty check)", () => {
  const input = "\\begin{matrix}{}{}{a}{b}\\end{matrix}";
  assert.equal(normalizeMatrixSyntax(input), input);
});

// ─── normalizeLegacyEnvMarkers ──────────────────────────────────────

test("normalizeLegacyEnvMarkers: all legacy tx* command mappings", () => {
  const mappings = {
    txlbl: "label",
    txtag: "tag",
    txtgs: "tag*",
    txntg: "notag",
    txnnum: "nonumber",
    txeqr: "eqref",
    txref: "ref",
    txpgrf: "pageref",
    txatrf: "autoref",
    txintr: "intertext",
    txshintr: "shortintertext",
  };
  for (const [legacy, modern] of Object.entries(mappings)) {
    assert.equal(
      normalizeLegacyEnvMarkers(`\\${legacy}{arg}`),
      `\\${modern}{arg}`,
      `failed for \\${legacy}`
    );
  }
});

test("normalizeLegacyEnvMarkers: aligned proxy env migrations", () => {
  assert.equal(
    normalizeLegacyEnvMarkers("\\begin{aligned}\\txalnat a&=b\\quad c&=d\\end{aligned}"),
    "\\begin{alignat*}{2}a&=b\\quad c&=d\\end{alignat*}"
  );
  assert.equal(
    normalizeLegacyEnvMarkers("\\begin{aligned}\\txflaln a&=b\\end{aligned}"),
    "\\begin{flalign*}a&=b\\end{flalign*}"
  );
  assert.equal(
    normalizeLegacyEnvMarkers("\\begin{aligned}\\txarrcf a&b&c\\\\d&e&f\\end{aligned}"),
    "\\begin{array}{@{}>r<{}c@{|}l<{}@{}}a&b&c\\\\d&e&f\\end{array}"
  );
});

test("normalizeLegacyEnvMarkers: \\txarrayc with 2 brace args → array", () => {
  assert.equal(
    normalizeLegacyEnvMarkers("\\txarrayc{@{}>r<{}c@{|}l<{}@{}}{a&b&c\\\\d&e&f}"),
    "\\begin{array}{@{}>r<{}c@{|}l<{}@{}}a&b&c\\\\d&e&f\\end{array}"
  );
});

test("normalizeLegacyEnvMarkers: \\lbrace / \\rbrace in aux command args are cleaned", () => {
  assert.equal(
    normalizeLegacyEnvMarkers("\\label{\\lbrace sec/intro+alpha@v1\\rbrace}"),
    "\\label{sec/intro+alpha@v1}"
  );
  assert.equal(
    normalizeLegacyEnvMarkers("\\ref{\\lbrace eq:1\\rbrace}"),
    "\\ref{eq:1}"
  );
});

test("normalizeLegacyEnvMarkers: no tx commands → unchanged", () => {
  const plain = "\\frac{a}{b} + \\sqrt{c}";
  assert.equal(normalizeLegacyEnvMarkers(plain), plain);
});

test("normalizeLegacyEnvMarkers: empty input", () => {
  assert.equal(normalizeLegacyEnvMarkers(""), "");
  assert.equal(normalizeLegacyEnvMarkers(null), null);
  assert.equal(normalizeLegacyEnvMarkers(undefined), undefined);
});

test("normalizeLegacyEnvMarkers: partial legacy without \\begin{aligned} → unchanged", () => {
  assert.equal(
    normalizeLegacyEnvMarkers("{2}a&=b\\quad c&=d\\end{alignat*}"),
    "{2}a&=b\\quad c&=d\\end{alignat*}"
  );
  assert.equal(
    normalizeLegacyEnvMarkers("a&=b\\end{flalign*}\\tag{A1}"),
    "a&=b\\end{flalign*}\\tag{A1}"
  );
});

test("normalizeLegacyEnvMarkers: multiple legacy commands combined", () => {
  assert.equal(
    normalizeLegacyEnvMarkers("\\txlbl{eq:newton}+\\txtgs{A-1}+\\txintr{text}"),
    "\\label{eq:newton}+\\tag*{A-1}+\\intertext{text}"
  );
});

test("normalizeLegacyEnvMarkers: lbrace/rbrace outside aux commands → unchanged", () => {
  const input = "x = \\lbrace y \\rbrace";
  assert.equal(normalizeLegacyEnvMarkers(input), input);
});

// ─── Real-world LaTeX formula integrity ─────────────────────────────

test("real-world: common formulas pass through all normalizations unmodified", () => {
  const formulas = [
    "E = mc^{2}",
    "\\int_{0}^{\\infty} e^{-x} dx",
    "\\sum_{n=1}^{N} n = \\frac{N(N+1)}{2}",
    "\\lim_{x \\to 0} \\frac{\\sin x}{x} = 1",
    "f(x) = \\begin{cases} 1 & x > 0 \\\\ 0 & x \\leq 0 \\end{cases}",
    "\\nabla \\times \\vec{E} = -\\frac{\\partial \\vec{B}}{\\partial t}",
    "\\left( \\frac{a}{b} \\right)^{n}",
    "\\binom{n}{k} = \\frac{n!}{k!(n-k)!}",
  ];
  for (const f of formulas) {
    assert.equal(normalizeLegacyEnvMarkers(f), f, `legacy modified: ${f}`);
    assert.equal(normalizeMatrixSyntax(f), f, `matrix modified: ${f}`);
  }
});

test("real-world: aligned equation wrap-unwrap round-trip", () => {
  const inner = "a & = b + c \\\\ d & = e + f";
  const wrapped = wrapAligned(inner);
  const unwrapped = unwrapAligned(wrapped);
  assert.deepEqual(unwrapped, { value: inner, didUnwrap: true });
  assert.equal(stripEmptyAlignedRows(inner), inner);
});

test("real-world: matrix with nested \\frac normalizes correctly", () => {
  const input = "\\begin{pmatrix}{\\frac{a}{b}}{c}{d}{e}\\end{pmatrix}";
  const expected = "\\begin{pmatrix}\\frac{a}{b}&c\\\\d&e\\end{pmatrix}";
  assert.equal(normalizeMatrixSyntax(input), expected);
});

// ─── Stress tests: complex structures ────────────────────────────────

test("stress: deeply nested fractions survive all normalizations", () => {
  // 10-deep nested fraction
  let formula = "x";
  for (let i = 0; i < 10; i++) {
    formula = `\\frac{${formula}}{${i}}`;
  }
  assert.equal(normalizeLegacyEnvMarkers(formula), formula);
  assert.equal(normalizeMatrixSyntax(formula), formula);
  assert.equal(shouldWrapAligned(formula), false);
});

test("stress: deeply nested sqrt + frac survives", () => {
  const deep = "\\sqrt{\\frac{\\sqrt{\\frac{\\sqrt{\\frac{a}{b}}}{c}}}{d}}";
  assert.equal(normalizeLegacyEnvMarkers(deep), deep);
  assert.equal(normalizeMatrixSyntax(deep), deep);
});

test("stress: matrix inside aligned row — splitAlignedRows respects environment boundaries", () => {
  // Aligned content with a matrix in the first row
  const inner = "a &= \\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix} \\\\ b &= c";
  const rows = inner.split(" \\\\ ");
  // The split should NOT break on the \\\\ inside pmatrix
  // stripEmptyAlignedRows should return unchanged (no trailing empty rows)
  assert.equal(stripEmptyAlignedRows(inner), inner);
});

test("stress: matrix inside aligned with trailing empty row strips correctly", () => {
  const inner = "a &= \\begin{pmatrix} 1 \\\\ 2 \\end{pmatrix} \\\\ b &= c \\\\  &";
  const result = stripEmptyAlignedRows(inner);
  // Should strip only the trailing empty row, preserving matrix's \\
  assert.ok(result.includes("\\begin{pmatrix}"), "matrix begin preserved");
  assert.ok(result.includes("\\end{pmatrix}"), "matrix end preserved");
  assert.ok(result.includes("b &= c"), "second aligned row preserved");
  assert.ok(!result.endsWith(" &"), "trailing empty row stripped");
});

test("stress: nested environments inside aligned — 3 levels deep", () => {
  const inner = "a &= \\begin{cases} x & \\begin{pmatrix} 1 \\\\ 2 \\end{pmatrix} \\\\ y & z \\end{cases} \\\\ b &= 1";
  const result = stripEmptyAlignedRows(inner);
  assert.equal(result, inner, "unchanged — no trailing empty rows");
});

test("stress: very long formula (500+ chars) through all normalizations", () => {
  // Build a long formula: sum of 50 fractions
  const terms = [];
  for (let i = 1; i <= 50; i++) {
    terms.push(`\\frac{x_{${i}}^{2}}{y_{${i}}}`);
  }
  const formula = terms.join(" + ");
  assert.ok(formula.length > 500, "formula is long enough");
  assert.equal(normalizeLegacyEnvMarkers(formula), formula);
  assert.equal(normalizeMatrixSyntax(formula), formula);
  assert.equal(shouldWrapAligned(formula), false);
});

test("stress: 5×5 matrix normalizes correctly", () => {
  const cells = [];
  for (let i = 0; i < 25; i++) {
    cells.push(`{a_{${i}}}`);
  }
  const input = `\\begin{pmatrix}${cells.join("")}\\end{pmatrix}`;
  const result = normalizeMatrixSyntax(input);
  // 25 cells → 5×5 matrix
  assert.ok(result.includes("&"), "has column separators");
  assert.ok(result.includes("\\\\"), "has row separators");
  // Verify structure: 5 rows of 5
  const body = result.replace(/\\begin\{pmatrix\}/, "").replace(/\\end\{pmatrix\}/, "");
  const rows = body.split("\\\\");
  assert.equal(rows.length, 5, "5 rows");
  for (const row of rows) {
    assert.equal(row.split("&").length, 5, "5 columns per row");
  }
});

test("stress: nested matrix inside matrix — outer unchanged", () => {
  // Nested matrix: the outer one already has & and \\, so it stays unchanged
  const nested = "\\begin{pmatrix} \\begin{bmatrix} a & b \\\\ c & d \\end{bmatrix} & e \\\\ f & g \\end{pmatrix}";
  assert.equal(normalizeMatrixSyntax(nested), nested);
});

test("stress: unbalanced braces don't crash", () => {
  const inputs = [
    "\\frac{a}{",
    "\\frac{a",
    "{{{",
    "}}}",
    "\\begin{pmatrix}{a}{b",
    "\\begin{pmatrix}\\end{pmatrix",
    "a & b \\\\ c { & d",
  ];
  for (const input of inputs) {
    // None of these should throw
    assert.doesNotThrow(() => normalizeLegacyEnvMarkers(input), `legacy threw on: ${input}`);
    assert.doesNotThrow(() => normalizeMatrixSyntax(input), `matrix threw on: ${input}`);
    assert.doesNotThrow(() => shouldWrapAligned(input), `wrap threw on: ${input}`);
    assert.doesNotThrow(() => stripEmptyAlignedRows(input), `strip threw on: ${input}`);
  }
});

test("stress: malformed LaTeX doesn't corrupt data", () => {
  const malformed = [
    "\\begin{aligned}\\end{aligned}",           // empty aligned
    "\\begin{pmatrix}\\end{pmatrix}",            // empty matrix
    "\\begin{aligned}a\\end{pmatrix}",           // mismatched envs
    "\\end{aligned}a\\begin{aligned}",           // reversed envs
    "\\\\\\\\\\\\",                              // only line breaks
    "& & & &",                                   // only ampersands
    "",                                          // empty string
  ];
  for (const input of malformed) {
    assert.doesNotThrow(() => {
      const r1 = normalizeLegacyEnvMarkers(input);
      const r2 = normalizeMatrixSyntax(input);
      const r3 = shouldWrapAligned(input);
      const r4 = stripEmptyAlignedRows(input);
      // Results must be strings (or the original type)
      assert.ok(typeof r1 === "string" || r1 === input, `legacy bad type for: ${input}`);
      assert.ok(typeof r2 === "string" || r2 === input, `matrix bad type for: ${input}`);
      assert.ok(typeof r3 === "boolean", `wrap bad type for: ${input}`);
      assert.ok(typeof r4 === "string", `strip bad type for: ${input}`);
    }, `processing crashed on: ${input}`);
  }
});

test("stress: wrap/unwrap round-trip with nested environments", () => {
  const complexInner = "a &= \\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix} + \\sqrt{\\frac{x}{y}} \\\\ b &= \\sum_{i=1}^{n} i";
  const wrapped = wrapAligned(complexInner);
  const { value, didUnwrap } = unwrapAligned(wrapped);
  assert.equal(didUnwrap, true);
  assert.equal(value, complexInner);
  // stripEmptyAlignedRows should not modify (no trailing empty rows)
  assert.equal(stripEmptyAlignedRows(value), value);
});

test("stress: performance — 10000-char formula completes in <50ms", () => {
  const bigTerms = [];
  for (let i = 0; i < 200; i++) {
    bigTerms.push(`\\frac{\\alpha_{${i}}^{\\beta_{${i}}}}{\\gamma_{${i}} + \\delta_{${i}}}`);
  }
  const bigFormula = bigTerms.join(" + ");
  assert.ok(bigFormula.length > 10000, "formula is 10k+ chars");

  const start = performance.now();
  normalizeLegacyEnvMarkers(bigFormula);
  normalizeMatrixSyntax(bigFormula);
  shouldWrapAligned(bigFormula);
  stripEmptyAlignedRows(bigFormula);
  const elapsed = performance.now() - start;
  assert.ok(elapsed < 50, `took ${elapsed.toFixed(1)}ms, expected <50ms`);
});
