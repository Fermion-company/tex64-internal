const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  checkExercisesInSources,
  checkJapaneseInSources,
  describeProfile,
  typesettingHint,
  parseNumber,
} = require("../electron/services/agent-teaching-checks.cjs");

const doc = (body, preamble = "\\documentclass{ltjsarticle}\n\\usepackage{amsmath}\n") =>
  `${preamble}\\begin{document}\n${body}\n\\end{document}\n`;
const rules = (result) => result.issues.map((issue) => issue.rule);

test("numbers in Japanese and full-width forms are read", () => {
  assert.equal(parseNumber("３"), 3);
  assert.equal(parseNumber("十二"), 12);
  assert.equal(parseNumber("二十"), 20);
  assert.equal(parseNumber("x"), null);
});

test("interleaved problems: missing solution, numbering gap, sub-question gap, points total", () => {
  const source = doc([
    "\\newtheorem{mondai}{問題}",
    "配点：100点満点",
    "\\begin{problem}[問1]（30点）",
    "(1) $x$ を求めよ。",
    "(2) $y$ を求めよ。",
    "\\end{problem}",
    "\\begin{solution}",
    "$x=1$, $y=2$",
    "\\end{solution}",
    "\\begin{problem}[問2]（30点）",
    "(1) 面積を求めよ。",
    "(3) 体積を求めよ。",
    "\\end{problem}",
    "\\begin{problem}[問4]（30点）",
    "次を計算せよ。",
    "\\end{problem}",
    "\\begin{solution}",
    "\\end{solution}",
  ].join("\n"));
  const result = checkExercisesInSources([{ path: "main.tex", content: source }]);
  assert.equal(result.problems, 3);
  assert.equal(result.solutions, 2);
  assert.equal(result.layout, "interleaved");
  const found = rules(result);
  assert.ok(found.includes("problem-without-solution"), found.join());
  assert.ok(found.includes("numbering-gap"), found.join());
  assert.ok(found.includes("empty-solution"), found.join());
  assert.ok(found.some((rule) => rule === "numbering-gap" && true));
  assert.ok(result.issues.some((issue) => /Sub-question/.test(issue.message)), JSON.stringify(result.issues));
  assert.equal(result.points.sum, 90);
  assert.equal(result.points.stated, 100);
  assert.ok(found.includes("points-total"));
});

test("environments are recognised from their definitions, proofs titled 解答 count as solutions", () => {
  const preamble = [
    "\\documentclass{ltjsarticle}",
    "\\usepackage{amsthm}",
    "\\newtheorem{reidaibox}{例題}",
    "\\newtheorem{thm}{定理}",
  ].join("\n") + "\n";
  const source = doc([
    "\\begin{thm} 定理の本文 \\end{thm}",
    "\\begin{reidaibox} 例題の本文 \\end{reidaibox}",
    "\\begin{proof}[解答] 解答の本文 \\end{proof}",
    "\\begin{reidaibox} 二つ目 \\end{reidaibox}",
    "\\begin{proof}[解答] 二つ目の解答 \\end{proof}",
  ].join("\n"), preamble);
  const result = checkExercisesInSources([{ path: "main.tex", content: source }]);
  assert.equal(result.problems, 2);
  assert.equal(result.solutions, 2);
  assert.deepEqual(result.issues, []);
});

test("marker-only documents (問1 / 【解答】) and a grouped solutions part", () => {
  const source = doc([
    "\\section{問題}",
    "\\noindent\\textbf{問1} 次の方程式を解け。",
    "\\noindent\\textbf{問2} 次の不等式を解け。",
    "\\noindent\\textbf{問3} 次の関数の最大値を求めよ。",
    "問1で求めた値を使う。",
    "\\section{解答}",
    "\\noindent\\textbf{解答1} $x=2$",
    "\\noindent\\textbf{解答2} $x>1$",
  ].join("\n"));
  const result = checkExercisesInSources([{ path: "main.tex", content: source }]);
  assert.equal(result.problems, 3, JSON.stringify(result.units));
  assert.equal(result.layout, "grouped");
  assert.ok(rules(result).includes("count-mismatch"));
});

test("exam class \\question points are summed against the stated total", () => {
  const source = doc([
    "\\begin{questions}",
    "\\question[40] 第一問",
    "\\question[40] 第二問",
    "\\end{questions}",
    "（100点満点）",
  ].join("\n"), "\\documentclass{exam}\n\\usepackage{luatexja}\n");
  const result = checkExercisesInSources([{ path: "main.tex", content: source }]);
  assert.equal(result.points.sum, 80);
  assert.ok(rules(result).includes("points-total"));
});

test("a document without problems reports nothing", () => {
  const result = checkExercisesInSources([{ path: "main.tex", content: doc("\\section{序論}\n本文。") }]);
  assert.equal(result.problems, 0);
  assert.deepEqual(result.issues, []);
});

test("Japanese text: punctuation, widths, math, units, $$, \\verb, tcolorbox titles", () => {
  const source = doc([
    "これは本文です、そして続きます。",
    "二つ目の文です、ここも同じです。",
    "ここだけ，違う．",
    "全角の数字１２３と ＡＢＣ を使う。",
    "　字下げを手で入れた段落。",
    "ｶﾀｶﾅ は半角。",
    "文末がピリオド.",
    "面積は $S = 縦 \\times 横$ で、$\\text{面積}$ は問題ない。",
    "長さは $5 cm$ で、質量は $3\\,\\mathrm{kg}$、$2m$ は積かもしれない。",
    "$$ a + b $$",
    "\\verb|x| を使う。",
    "\\begin{tcolorbox}[title=問1, 2を解け, colback=white]本文\\end{tcolorbox}",
    "\\texttt{a...b} は等幅なので数えない。",
  ].join("\n"));
  const result = checkJapaneseInSources([{ path: "main.tex", content: source }]);
  assert.equal(result.japanese, true);
  assert.equal(result.japaneseSetup, true);
  assert.equal(result.punctuationStyle, "、。");
  const found = new Set(rules(result));
  for (const rule of [
    "mixed-punctuation", "fullwidth-alnum", "fullwidth-space-indent", "halfwidth-kana", "ascii-punctuation",
    "japanese-in-math", "italic-unit", "display-dollars", "pgfkeys-comma",
  ]) {
    assert.ok(found.has(rule), `${rule} missing from ${[...found].join(", ")}`);
  }
  // \text{面積} and 3\,\mathrm{kg} and 2m are fine; \texttt{a...b} is literal.
  assert.equal(result.issues.filter((i) => i.rule === "japanese-in-math").length, 1);
  assert.equal(result.issues.filter((i) => i.rule === "italic-unit").length, 1);
  assert.ok(!found.has("ascii-ellipsis"));
});

test("Japanese text in a class without Japanese support is an error", () => {
  const result = checkJapaneseInSources([{ path: "main.tex", content: doc("日本語の本文。", "\\documentclass{article}\n") }]);
  assert.equal(result.issues[0].rule, "class-not-japanese");
  assert.equal(result.issues[0].severity, "error");
});

test("、． is a consistent style, not a mix", () => {
  const result = checkJapaneseInSources([{ path: "main.tex", content: doc("一文目、続き．\n二文目、続き．") }]);
  assert.equal(result.punctuationStyle, "、．");
  assert.ok(!rules(result).includes("mixed-punctuation"));
});

test("a clean Japanese document has no issues", () => {
  const source = doc([
    "\\section{二次関数}",
    "関数 $f(x)=x^2$ の最小値を求める。長さ $5\\,\\mathrm{cm}$ の線分を考える。",
    "\\[ f(x) = (x-1)^2 + 2 \\]",
    "よって最小値は $2$ である。",
  ].join("\n"));
  const result = checkJapaneseInSources([{ path: "main.tex", content: source }]);
  assert.deepEqual(result.issues, []);
});

test("the document map profile names Japanese text and teaching material", () => {
  const source = doc("\\begin{problem}問題文\\end{problem}\n\\begin{solution}解答\\end{solution}");
  const line = describeProfile([{ path: "main.tex", content: source }]);
  assert.match(line, /Japanese text \(ltjsarticle\)/);
  assert.match(line, /1 problem, 1 solution/);
  assert.match(line, /check_exercises \/ check_japanese_text/);
  assert.equal(describeProfile([{ path: "main.tex", content: "\\documentclass{article}\\begin{document}Hello\\end{document}" }]), "");
});

test("build issue hints name the known luatexja / tcolorbox traps", () => {
  assert.match(typesettingHint("Package pgfkeys Error: I do not know the key '/tcb/2を解け'"), /、/);
  assert.match(typesettingHint("Missing character: There is no A (U+0041) in font nullfont!"), /tikzpicture/);
  assert.match(typesettingHint("Missing character: There is no 😀 (U+1F600) in font ipaexm"), /dropped/);
  assert.equal(typesettingHint("Undefined control sequence"), "");
});

test("\\verb is flagged under jlreq only, and a project package that loads luatexja counts as Japanese setup", () => {
  const body = "\\verb|x| を使う。";
  const jlreq = checkJapaneseInSources([{ path: "main.tex", content: doc(body, "\\documentclass{jlreq}\n") }]);
  assert.ok(rules(jlreq).includes("verb-with-jlreq"));
  const ltjs = checkJapaneseInSources([{ path: "main.tex", content: doc(body) }]);
  assert.ok(!rules(ltjs).includes("verb-with-jlreq"));
  const house = checkJapaneseInSources(
    [{ path: "main.tex", content: doc("日本語。", "\\documentclass{article}\n\\usepackage{house}\n") }],
    { localStyles: ["\\RequirePackage{luatexja-fontspec}"] },
  );
  assert.ok(!rules(house).includes("class-not-japanese"));
});

test("TikZ calc coordinates are not math", () => {
  const source = doc("\\begin{tikzpicture}\\fill (0,0) rectangle ($(a)+(0,-62 mm)$);\\end{tikzpicture}\n本文。");
  assert.ok(!rules(checkJapaneseInSources([{ path: "main.tex", content: source }])).includes("italic-unit"));
});

test("two formulas side by side are not read as one (…+2$ と $A,B$)", () => {
  const source = doc("最小公倍数が $x^3-2x^2-x+2$ であるとき、$A,B$ を求めよ。");
  assert.ok(!rules(checkJapaneseInSources([{ path: "main.tex", content: source }])).includes("italic-unit"));
});

test("the DOCUMENT MAP carries the profile line from disk", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { scanDocument, formatDocumentMapForPrompt } = require("../electron/services/agent-document-map.cjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-profile-"));
  try {
    fs.writeFileSync(path.join(root, "main.tex"), doc("\\begin{problem}[問1]問題文\\end{problem}\n\\input{part2}"));
    fs.writeFileSync(path.join(root, "part2.tex"), "\\begin{problem}[問2]二問目\\end{problem}\n\\begin{solution}解答\\end{solution}\n");
    const service = { workspace: { resolvePath: (rel) => path.join(root, rel), listFiles: async () => ["main.tex", "part2.tex"] } };
    const map = await scanDocument(service, "main.tex");
    assert.match(map.profile, /2 problems, 1 solution/);
    assert.match(formatDocumentMapForPrompt(map).split("\n")[1], /^profile: Japanese text/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
