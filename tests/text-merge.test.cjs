"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const load = () => {
  const source = fs.readFileSync(path.join(__dirname, "../web-src/app/editor-session/text-merge.ts"), "utf8");
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const exports = {};
  new Function("exports", code)(exports);
  return exports;
};
const { textHunks, applyHunks, rebaseHunks } = load();

// Deterministic PRNG so a failure is reproducible.
const rng = (seed) => () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const UNITS = ["a", "b", "c", " ", "\n", "\r\n", "漢", "字", "😀", "\\section{", "}"];
const randomText = (next, length) => Array.from({ length }, () => UNITS[Math.floor(next() * UNITS.length)]).join("");
const splitsUnit = (text, offset) =>
  (text[offset - 1] === "\r" && text[offset] === "\n") ||
  (/[\ud800-\udbff]/.test(text[offset - 1] ?? "") && /[\udc00-\udfff]/.test(text[offset] ?? ""));

test("textHunks: applying the hunks gives the target; no hunk splits \\r\\n or a surrogate pair", () => {
  const next = rng(7);
  for (let round = 0; round < 3000; round += 1) {
    const from = randomText(next, Math.floor(next() * 40));
    let to = from;
    for (let edits = Math.floor(next() * 4); edits > 0; edits -= 1) {
      const at = Math.floor(next() * (to.length + 1));
      const cut = Math.floor(next() * 4);
      to = to.slice(0, at) + randomText(next, Math.floor(next() * 3)) + to.slice(at + cut);
    }
    const hunks = textHunks(from, to);
    assert.ok(hunks, `round ${round}`);
    assert.equal(applyHunks(from, hunks), to, `round ${round}: ${JSON.stringify({ from, to, hunks })}`);
    for (let i = 0; i < hunks.length; i += 1) {
      assert.ok(hunks[i].start <= hunks[i].end);
      if (i > 0) assert.ok(hunks[i - 1].end <= hunks[i].start, "ascending and not overlapping");
      assert.equal(splitsUnit(from, hunks[i].start), false, JSON.stringify({ from, to, hunks }));
      assert.equal(splitsUnit(from, hunks[i].end), false, JSON.stringify({ from, to, hunks }));
    }
  }
});

test("textHunks: a one-word change in a long file is one small hunk; a huge rewrite gives up (null)", () => {
  const lines = Array.from({ length: 3000 }, (_, i) => `line ${i}\r\n`);
  const from = lines.join("");
  const to = from.replace("line 1500\r\n", "line 1500 edited\r\n").replace("line 10\r\n", "");
  const hunks = textHunks(from, to);
  assert.equal(applyHunks(from, hunks), to);
  assert.deepEqual(hunks.map((h) => [from.slice(h.start, h.end), h.text]), [["line 10\r\n", ""], ["", " edited"]]);
  const rewritten = lines.map((line) => line.toUpperCase()).join("");
  assert.equal(textHunks(from, rewritten, 400), null);
});

test("rebaseHunks: disjoint edits merge; touching or overlapping ones do not; identical ones count once", () => {
  const base = "\\section{A}\nalpha\nbeta\ngamma\n";
  const mine = base.replace("gamma", "gamma typed");
  const theirs = base.replace("alpha", "ALPHA");
  assert.equal(applyHunks(mine, rebaseHunks(base, mine, theirs)), "\\section{A}\nALPHA\nbeta\ngamma typed\n");
  // Same line, different words: merged at character level.
  const mine2 = base.replace("beta", "beta!");
  const theirs2 = base.replace("\\section{A}", "\\section{B}");
  assert.equal(applyHunks(mine2, rebaseHunks(base, mine2, theirs2)), "\\section{B}\nalpha\nbeta!\ngamma\n");
  // Overlap, and an insertion exactly where the other side typed: a conflict.
  assert.equal(rebaseHunks(base, base.replace("beta", "BETA"), base.replace("beta", "beta2")), null);
  assert.equal(rebaseHunks(base, base.replace("beta\n", "beta X\n"), base.replace("beta\n", "beta Y\n")), null);
  // Both sides made the same edit plus one disjoint edit each.
  const both = base.replace("beta", "BETA");
  const mine3 = both.replace("gamma", "gamma typed");
  const theirs3 = both.replace("alpha", "ALPHA");
  assert.equal(applyHunks(mine3, rebaseHunks(base, mine3, theirs3)), "\\section{A}\nALPHA\nBETA\ngamma typed\n");
  // Nothing to do.
  assert.deepEqual(rebaseHunks(base, mine, base), []);
  assert.deepEqual(rebaseHunks(base, mine, mine), []);
});

test("rebaseHunks: when it merges, the result is the same whichever side is 'mine'", () => {
  const next = rng(11);
  let merged = 0;
  for (let round = 0; round < 3000; round += 1) {
    const base = randomText(next, 5 + Math.floor(next() * 40));
    const edit = (text) => {
      const at = Math.floor(next() * (text.length + 1));
      return text.slice(0, at) + randomText(next, Math.floor(next() * 3)) + text.slice(at + Math.floor(next() * 3));
    };
    const mine = edit(base);
    const theirs = edit(base);
    const forward = rebaseHunks(base, mine, theirs);
    const backward = rebaseHunks(base, theirs, mine);
    if (forward && backward) {
      merged += 1;
      assert.equal(applyHunks(mine, forward), applyHunks(theirs, backward), JSON.stringify({ base, mine, theirs }));
    }
  }
  assert.ok(merged > 1000, `merged ${merged}`);
});

test("rebaseHunks: edits made at known disjoint places always merge to the expected text", () => {
  const next = rng(23);
  for (let round = 0; round < 2000; round += 1) {
    const lines = Array.from({ length: 6 + Math.floor(next() * 10) }, (_, i) => `l${i} ${randomText(next, 3).replace(/\r?\n/g, "")}\n`);
    const base = lines.join("");
    const a = Math.floor(next() * lines.length);
    let b = Math.floor(next() * lines.length);
    if (Math.abs(a - b) < 2) b = (a + 3) % lines.length;
    if (Math.abs(a - b) < 2) continue;
    const change = (index, text) => lines.map((line, i) => (i === index ? text : line)).join("");
    const mine = change(a, `typed ${a}\n`);
    const theirs = change(b, `outside ${b}\n`);
    const expected = lines.map((line, i) => (i === a ? `typed ${a}\n` : i === b ? `outside ${b}\n` : line)).join("");
    const hunks = rebaseHunks(base, mine, theirs);
    assert.ok(hunks, JSON.stringify({ base, mine, theirs }));
    assert.equal(applyHunks(mine, hunks), expected);
  }
});

test("the main-process copy (electron/services/text-merge.cjs) gives the same hunks as the renderer's", () => {
  const main = require("../electron/services/text-merge.cjs");
  const next = rng(31);
  for (let round = 0; round < 2000; round += 1) {
    const base = randomText(next, Math.floor(next() * 40));
    const edit = (text) => {
      const at = Math.floor(next() * (text.length + 1));
      return text.slice(0, at) + randomText(next, Math.floor(next() * 3)) + text.slice(at + Math.floor(next() * 3));
    };
    const mine = edit(base);
    const theirs = edit(base);
    assert.deepEqual(main.textHunks(base, theirs), textHunks(base, theirs));
    assert.deepEqual(main.rebaseHunks(base, mine, theirs), rebaseHunks(base, mine, theirs));
  }
});
