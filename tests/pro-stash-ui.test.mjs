import test from "node:test";
import assert from "node:assert/strict";
import {
  buildStashEditPrompt,
  clampStashWidth,
  enforceStashCapacity,
  parseProStashUiState,
  parseStashEditResponse,
  reorderStashItems,
  runStashAiEdit,
  snapStashSide,
} from "../Resources/web/app/pro-stash-ui.js";

test("stash reorder is immutable and moves an item to the drop index", () => {
  const source = ["a", "b", "c"];
  assert.deepEqual(reorderStashItems(source, 0, 2), ["b", "c", "a"]);
  assert.deepEqual(source, ["a", "b", "c"]);
});

test("stash snapping and persisted width stay within viewport bounds", () => {
  assert.equal(snapStashSide(199, 800), "left");
  assert.equal(snapStashSide(600, 800), "right");
  assert.equal(clampStashWidth(100, 800), 260);
  assert.equal(clampStashWidth(900, 800), 560);
  assert.deepEqual(parseProStashUiState('{"side":"left","width":420,"collapsed":true}', 800), { side: "left", width: 420, collapsed: true });
  // Opening the tray is remembered; with nothing stored it starts collapsed so
  // it never covers the editor on first run.
  assert.deepEqual(parseProStashUiState('{"side":"left","width":420,"collapsed":false}', 800), { side: "left", width: 420, collapsed: false });
  assert.equal(parseProStashUiState(null).collapsed, true);
  assert.equal(parseProStashUiState("not json").collapsed, true);
});

const textItem = (id, content, createdAt = 1) => ({ id, kind: "text", content, createdAt });

test("stash prompt numbers every fragment and includes the instruction", () => {
  const prompt = buildStashEditPrompt([textItem("a", "alpha"), textItem("b", "beta")], "1と2を入れ替え");
  assert.match(prompt.system, /JSON/);
  assert.match(prompt.user, /\[1\]\nalpha[\s\S]*\[2\]\nbeta/);
  assert.match(prompt.user, /1と2を入れ替え/);
});

test("stash response parser accepts plain or fenced JSON and rejects invalid items", () => {
  assert.deepEqual(parseStashEditResponse('```json\n{"items":[{"n":2,"text":"B"}]}\n```'), [{ n: 2, text: "B" }]);
  assert.throws(() => parseStashEditResponse('{"items":[{"n":0,"text":3}]}'), /invalid item/);
});

test("capacity enforcement removes oldest items until serialized UTF-8 fits", () => {
  const items = [textItem("old", "x".repeat(80), 1), textItem("new", "ok", 2)];
  const oneItemBytes = new TextEncoder().encode(JSON.stringify([items[1]])).byteLength;
  const limited = enforceStashCapacity(items, oneItemBytes);
  assert.deepEqual(limited.items.map((item) => item.id), ["new"]);
  assert.deepEqual(limited.removed.map((item) => item.id), ["old"]);
});

test("AI edit converts images through texize and calls injected single completion", async () => {
  const calls = [];
  const result = await runStashAiEdit([
    { id: "img", kind: "image", content: "data:image/png;base64,AAAA", createdAt: 1 },
    textItem("txt", "original", 2),
  ], "shorten 2", {
    texize: async (base64) => { calls.push(["texize", base64]); return "\\frac{1}{2}"; },
    complete: async (prompt) => { calls.push(["complete", prompt]); return '{"items":[{"n":1,"text":"half"}]}'; },
  });
  assert.deepEqual(calls[0], ["texize", "AAAA"]);
  assert.match(calls[1][1].user, /\\frac\{1\}\{2\}/);
  assert.deepEqual(result.map((item) => item.content), ["half"]);
});
