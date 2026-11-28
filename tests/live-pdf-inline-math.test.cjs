const test = require("node:test");
const assert = require("node:assert/strict");
const { horizontalRows, literalParagraph, paragraphMath } = require("../electron/services/live-pdf-inline-math.cjs");

const inputTags = new Set([6, 7]); // the same child file was read twice
const sp = n => Math.round(n * 65536 * 72.27 / 72);
const row = (tag, y) => [
  `(${tag},3:0,${sp(y)}:${sp(70)},${sp(8)},${sp(2)}`,
  `$1,9:${sp(20)},${sp(y)}`,
  `$1,9:${sp(25)},${sp(y)}`,
  ")",
];
const sheet = (...lines) => ["[1,9:0,0:0,0,0", ...lines.flat(), "]"];

test("the end of one inclusion and the beginning of the next edit different copies of the same inline formula", async () => {
  const source = "First $q$ followed\nby another $q$.\n\n";
  const regions = [...source.matchAll(/\$q\$/g)].map(match => ({
    kind: "math", start: match.index, end: match.index + 3, display: false,
  }));
  const bounds = literalParagraph(source, regions, source.indexOf("by"), source.indexOf("\n\n"), 2);
  const pages = [sheet(row(6, 20)), sheet(row(6, 20), row(7, 32)), sheet(row(7, 20))];
  const scan = async callback => { pages.forEach((lines, i) => callback(i + 1, lines)); return true; };
  const rows = horizontalRows({ lines: pages[1], originX: 0, originY: 0 }, inputTags, 2);
  const map = {};
  const click = y => paragraphMath(map, bounds, rows, { page: 2, x: 22, y }, inputTags, scan);
  assert.equal((await click(20)).region, regions[1]);
  assert.equal((await click(32)).region, regions[0]);
  assert.equal(await click(40), null);
  // Without proof of the first occurrence, the first row on page two has no source target.
  assert.equal(await paragraphMath({}, bounds, rows, { page: 2, x: 22, y: 20 }, inputTags,
    async callback => { callback(2, pages[1]); return true; }), null);
});

test("a section and an explicit paragraph end bound the inline source, while expanded prose needs its own evidence", () => {
  const source = "\\section*{Test}\nFirst $q$\nthen $q$.\\par\nNext paragraph.";
  const regions = [...source.matchAll(/\$q\$/g)].map(match => ({ kind: "math", start: match.index, end: match.index + 3 }));
  const line = source.indexOf("First");
  const bounds = literalParagraph(source, regions, line, source.indexOf("\n", line), 2);
  assert.deepEqual(bounds, { firstLine: 2, lastLine: 3, candidates: regions });
  assert.equal(literalParagraph(source.replace("First", "\\copy"), regions, line, source.indexOf("\n", line), 2), null);
});

test("math inside a nested box does not count as a second source formula", async () => {
  const outer = row(6, 20);
  const nested = sheet(row(6, 18));
  outer.splice(2, 0, ...nested);
  const rows = horizontalRows({ lines: sheet(outer, row(6, 34)), originX: 0, originY: 0 }, inputTags, 2);
  const bounds = { firstLine: 2, lastLine: 3, candidates: ["first", "second"] };
  const result = await paragraphMath({}, bounds, rows, { page: 1, x: 22, y: 18 }, inputTags,
    () => assert.fail("both source expressions are on this sheet"));
  assert.equal(result.region, "first");
  assert.equal(horizontalRows({ lines: ["[1,3:0,0:0,0,0", ")"] }, inputTags, 3), null);
});

test("a display following prose on the same source line only opens on its centered box", async () => {
  const { editTargetAt } = require("../electron/services/live-pdf-target.cjs");
  const path = require("node:path");
  const root = __dirname, file = path.join(root, "chapter.tex");
  const source = "手元の原稿です。\\[u+v=w\\]\n";
  const map = { root, engine: "uplatex", files: new Map([["chapter.tex", source]]) };
  const sheet = { originX: 0, originY: 0, inputs: new Map([[6, file]]), lines: [
    `[1,5:0,${sp(120)}:${sp(100)},${sp(120)},0`,
    `(6,1:0,${sp(20)}:${sp(100)},${sp(8)},0`, `x6,1:${sp(25)},${sp(20)}`, ")",
    `(6,1:${sp(35)},${sp(38)}:${sp(30)},${sp(8)},0`, `x6,1:${sp(60)},${sp(38)}`, ")", "]",
  ] };
  const click = (x, y) => editTargetAt(map, file, { line: 1 }, { page: 1, x, y },
    null, p => p, null, null, null, sheet);
  assert.equal((await click(50, 36)).baseValue, "u+v=w");
  assert.equal(await click(50, 18), null);
  assert.equal(await click(80, 36), null);
});
