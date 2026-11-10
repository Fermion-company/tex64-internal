"use strict";
// External saves must preserve the CRDT characters people are typing around.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const Diff = require("diff");
const Y = require("yjs");
const { DiskSync, mergeThreeWay } = require("../electron/services/collab/disk-sync.cjs");

const merge = (baseline, current, disk) => {
  const doc = new Y.Doc();
  const text = doc.getText("content");
  text.insert(0, current);
  const transactions = [];
  text.observe((event, transaction) => transactions.push({ origin: transaction.origin, delta: event.delta }));
  const dropped = mergeThreeWay(text, baseline, current, disk, "disk");
  const result = { text: text.toString(), dropped, transactions };
  doc.destroy();
  return result;
};

test("an external edit on another line preserves typing at the previous line's end", () => {
  const baseline = "\\section{矩形波の例} Each term adds a \nThe sum is 10.\nEnd.\n";
  const current = baseline.replace("adds a ", "adds a sine wave");
  const disk = baseline.replace("10", "20");
  const result = merge(baseline, current, disk);
  assert.equal(result.text, current.replace("10", "20"));
  assert.equal(result.dropped, 0);
  assert.deepEqual(result.transactions, [{ origin: "disk", delta: [
    { retain: current.indexOf("10") }, { delete: 1 }, { insert: "2" },
  ] }]);
});

test("another writer's partial line is dropped without duplicating or deleting typing", () => {
  const baseline = "Original sentence.\nOther line.\n";
  const current = "Original sentence. ABCDEFG\nOther line.\n";
  for (const partial of [" ABC", " ABCDEFG", " XYZ", " ABCDEFGHIJK"]) {
    const result = merge(baseline, current, baseline.replace("sentence.", `sentence.${partial}`));
    assert.equal(result.text, current, partial);
    assert.equal(result.dropped, 1, partial);
    assert.deepEqual(result.transactions, [], partial);
  }
  // A stale writer can also remove the last characters of our baseline,
  // exactly where the next keystrokes have since been inserted.
  const saved = "Original sentence. ABC\nOther line.\n";
  const stale = merge(saved, current, "Original sentence. AB\nOther line.\n");
  assert.equal(stale.text, current);
  assert.equal(stale.dropped, 1);
  assert.deepEqual(stale.transactions, []);
});

test("disk deletions and replacements on untouched lines apply at shifted positions", () => {
  const baseline = "First line.\nRemove this line.\nValue: 10.\nLast line.\n";
  for (const current of [baseline.replace("First line.", "First line. typing"), baseline.replace("First line.", "First.")]) {
    const disk = baseline.replace("Remove this line.\n", "").replace("10", "20");
    const result = merge(baseline, current, disk);
    assert.equal(result.text, current.replace("Remove this line.\n", "").replace("10", "20"));
    assert.equal(result.dropped, 0);
  }
});

test("separate edits on the same line merge without replacing its unchanged characters", () => {
  const result = merge("alpha = 10; beta = 20;", "alpha = 10; beta = 20; typing", "alpha = 11; beta = 21;");
  assert.equal(result.text, "alpha = 11; beta = 21; typing");
  assert.equal(result.dropped, 0);
  assert.deepEqual(result.transactions[0].delta, [
    { retain: 9 }, { delete: 1 }, { insert: "1" },
    { retain: 10 }, { delete: 1 }, { insert: "1" },
  ]);
});

test("overlapping and touching edits keep current, including both insertion boundaries", () => {
  for (const [current, disk] of [
    ["abcXdef", "abcYdef"], // Insertions at the same point.
    ["abcXdef", "abCdef"], // Disk replacement ends at our insertion.
    ["abcXdef", "abcDef"], // Disk replacement starts at our insertion.
    ["abCdef", "abcYdef"], // Disk insertion at our replacement's end.
    ["abcDef", "abcYdef"], // Disk insertion at our replacement's start.
    ["abCdef", "abcDef"], // Adjacent replacements touch.
    ["abCDef", "abcXef"], // Replacements overlap.
    ["abef", "abcXdef"], // Insertion inside our deletion.
  ]) {
    const result = merge("abcdef", current, disk);
    assert.equal(result.text, current, `${current} / ${disk}`);
    assert.equal(result.dropped, 1);
    assert.deepEqual(result.transactions, []);
  }
});

test("the baseline fast path applies separated minimal edits and keeps Unicode intact", () => {
  const baseline = "😀 one = 10; 日本語 = 20;\r\n";
  const disk = "😃 one = 11; 日本語 = 21;\r\n";
  const result = merge(baseline, baseline, disk);
  assert.equal(result.text, disk);
  assert.equal(result.dropped, 0);
  assert.deepEqual(result.transactions[0].delta, [
    { delete: 2 }, { insert: "😃" }, { retain: 8 }, { delete: 1 }, { insert: "1" },
    { retain: 9 }, { delete: 1 }, { insert: "1" },
  ]);
  const shifted = merge(baseline, baseline.replace("😀", "😀🚀"), baseline.replace("20", "21"));
  assert.equal(shifted.text, baseline.replace("😀", "😀🚀").replace("20", "21"));
  assert.equal(shifted.dropped, 0);
});

test("empty files, final newlines and edits before unsaved changes preserve exact text", () => {
  for (const [baseline, current, disk, expected] of [
    ["", "", "new\n", "new\n"],
    ["old\n", "old\n", "", ""],
    ["abc\nlast", "aBc\nlast", "abc\nlast\n", "aBc\nlast\n"],
    ["abc\nlast\n", "aBc\nlast\n", "abc\nlast", "aBc\nlast"],
    ["abc\nlast\n", "abc\nlast typed\n", "aBc\nlast\n", "aBc\nlast typed\n"],
  ]) {
    const result = merge(baseline, current, disk);
    assert.equal(result.text, expected);
    assert.equal(result.dropped, 0);
  }
});

test("character refinement never receives unchanged lines", (t) => {
  const unchanged = `${"unchanged 日本語 😀 ".repeat(600)}\r\n`;
  const baseline = `first = 10;\n${unchanged}last = 20;\n`;
  const disk = `first = 11;\n${unchanged}last = 21;\n`;
  const diff = t.mock.method(Diff.characterDiff, "diff");
  const result = merge(baseline, baseline, disk);
  assert.equal(result.text, disk);
  assert.equal(result.dropped, 0);
  assert.deepEqual(diff.mock.calls.map(({ arguments: args }) => args.slice(0, 2)), [
    ["first = 10;\n", "first = 11;\n"],
    ["last = 20;\n", "last = 21;\n"],
  ]);
});

// The first fixture exceeds the per-side size limit. The second fits that
// limit but exceeds the character edit-distance budget (including a common
// suffix that a completed character diff would have preserved).
for (const [reason, before, after] of [
  ["size limit", "old content\n".repeat(500), "replacement content\n".repeat(500)],
  ["edit budget", `${"a".repeat(600)} shared\n`, `${"b".repeat(700)} shared\n`],
]) {
  test(`coarse hunks from the ${reason} relocate in both directions`, () => {
    const header = "Header 😀.\n";
    const footer = "Unchanged separator.\nValue: 10.\n";
    const baseline = header + before + footer;
    const disk = header + after + footer.replace("10", "20");
    for (const newHeader of ["Header 😀🚀 typing.\n", "H.\n"]) {
      const result = merge(baseline, newHeader + before + footer, disk);
      assert.equal(result.text, newHeader + after + footer.replace("10", "20"));
      assert.equal(result.dropped, 0);
    }
    // A coarse current edit shifts a later, fine disk edit too.
    const result = merge(baseline, header + after + footer, baseline.replace("10", "20"));
    assert.equal(result.text, header + after + footer.replace("10", "20"));
    assert.equal(result.dropped, 0);
    const direct = merge(baseline, baseline, header + after + footer);
    assert.deepEqual(direct.transactions[0].delta, [
      { retain: header.length }, { delete: before.length }, { insert: after },
    ]);
  });

  test(`coarse hunks from the ${reason} report overlaps and both touching boundaries`, () => {
    const header = "Header.\n";
    const footer = "Footer.\n";
    const baseline = header + before + footer;
    const disk = header + after + footer;
    for (const offset of [header.length, header.length + 3, header.length + before.length]) {
      const current = baseline.slice(0, offset) + "X" + baseline.slice(offset);
      const result = merge(baseline, current, disk);
      assert.equal(result.text, current, `insertion at ${offset}`);
      assert.equal(result.dropped, 1);
      assert.deepEqual(result.transactions, []);
    }
  });
}

test("an aborted character diff falls back to its line range and still applies other ranges", (t) => {
  const originalDiff = Diff.characterDiff.diff;
  t.mock.method(Diff.characterDiff, "diff", function (from, to, options) {
    assert.ok(options.timeout > 0 && options.timeout <= 20);
    assert.ok(options.maxEditLength > 0);
    if (from === "old shared\n" && to === "new shared\n") return undefined;
    return originalDiff.call(this, from, to, options);
  });
  const baseline = "Header.\nold shared\nSeparator.\nValue: 10.\n";
  const disk = baseline.replace("old", "new").replace("10", "20");
  // The shared suffix is part of the coarse range, so this must conflict.
  const current = baseline.replace("shared", "shared typing");
  const result = merge(baseline, current, disk);
  assert.equal(result.text, current.replace("10", "20"));
  assert.equal(result.dropped, 1);
  assert.equal(merge(baseline, baseline, disk).text, disk);
});

// A deterministic 75 KB document with distinct lines, independent of the
// bundled engine's samples. Time the full merge, including Y.Text updates.
const stressLines = Array.from({ length: 1000 }, (_, i) =>
  `\\paragraph{${String(i).padStart(4, "0")}} The Fourier series has coefficients a_n and b_n.`.padEnd(74, " ") + "\n");
const stressBaseline = stressLines.join("");
for (const [name, disk] of [
  ["20 scattered one-character inserts", stressLines.map((line, i) => i % 50 === 25 ? line.replace("Fourier", "FourierX") : line).join("")],
  ["every line re-indented", stressLines.map((line) => `  ${line}`).join("")],
  ["30 KB middle block replaced", stressLines.slice(0, 300).join("") + "Z".repeat(29999) + "\n" + stressLines.slice(700).join("")],
]) {
  test(`75 KB merge performance: ${name}`, (t) => {
    assert.equal(stressBaseline.length, 75000);
    for (const concurrent of [false, true]) {
      const current = concurrent ? stressBaseline.replace("Fourier", "Fourier typed") : stressBaseline;
      const started = performance.now();
      const result = merge(stressBaseline, current, disk);
      const elapsed = performance.now() - started;
      t.diagnostic(`${concurrent ? "concurrent" : "baseline"} merge: ${elapsed.toFixed(2)} ms`);
      assert.ok(elapsed < 1500, `${name} took ${elapsed.toFixed(2)} ms (limit 1500 ms)`);
      // Re-indenting all lines is one coarse range, conflicting with typing.
      const conflicts = concurrent && name === "every line re-indented";
      assert.equal(result.text, conflicts ? current : concurrent ? disk.replace("Fourier", "Fourier typed") : disk);
      assert.equal(result.dropped, conflicts ? 1 : 0);
    }
  });
}

for (const operation of ["ingestDisk", "writeNow"]) {
  test(`${operation} writes current back and reports a partial-save conflict only once`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-disk-"));
    const baseline = "Original.\nValue: 10.\n";
    const current = "Original. ABCDEFG\nValue: 10.\n";
    const disk = "Original. ABC\nValue: 20.\n";
    const expected = "Original. ABCDEFG\nValue: 20.\n";
    const notices = [];
    const sync = new DiskSync({ rootPath: () => root, onNotice: (...args) => notices.push(args) });
    sync.paused = true;
    const doc = new Y.Doc();
    const text = doc.getText("content");
    text.insert(0, current);
    t.after(() => { sync.stop(); doc.destroy(); fs.rmSync(root, { recursive: true, force: true }); });
    sync.attach("main.tex", text, baseline);
    fs.writeFileSync(path.join(root, "main.tex"), disk);
    await sync[operation]("main.tex");
    assert.equal(text.toString(), expected);
    assert.deepEqual(notices, [["main.tex", 1]]);
    assert.equal(await sync.flush(), true);
    assert.equal(fs.readFileSync(path.join(root, "main.tex"), "utf8"), expected);
    assert.equal(sync.baselineOf("main.tex"), expected);
    await sync.ingestDisk("main.tex");
    await sync.writeNow("main.tex");
    assert.equal(text.toString(), expected);
    assert.deepEqual(notices, [["main.tex", 1]]);
  });
}
