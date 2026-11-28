const assert = require("node:assert/strict");
const test = require("node:test");

test("a checksum collision cannot move a paper edit into another source version", async () => {
  const { trackLiveEditModel, anchorFromLiveEditSnapshot } = await import("../Resources/web/app/editor-session/live-edit-history.js");
  let text = "ab TARGET";
  let changed;
  let reads = 0;
  let version = 1;
  const model = {
    getValue() { reads++; return text; },
    getVersionId: () => version,
    onDidChangeContent(listener) { changed = listener; return { dispose() {} }; },
  };
  const replace = (offset, length, value) => {
    text = text.slice(0, offset) + value + text.slice(offset + length);
    version++;
    changed({ changes: [{ rangeOffset: offset, rangeLength: length, text: value }] });
  };

  trackLiveEditModel(model);
  replace(0, 2, "ba");
  replace(0, 0, "前");
  const readsAfterEdits = reads;
  const first = anchorFromLiveEditSnapshot(model, "ab TARGET", 3, 9);
  const second = anchorFromLiveEditSnapshot(model, "ba TARGET", 3, 9);
  for (const anchor of [first, second]) {
    assert.ok(anchor);
    assert.equal(text.slice(anchor.startOffset, anchor.endOffset), "TARGET");
  }
  // Same length and checksum as both saved versions, but never in the model.
  assert.equal(anchorFromLiveEditSnapshot(model, "a bTARGET", 3, 9), null);
  assert.equal(reads, readsAfterEdits);
  // A missed model event invalidates the old history and checksum baseline.
  text = "replacement";
  version++;
  assert.equal(anchorFromLiveEditSnapshot(model, "ab TARGET", 3, 9), null);
  replace(0, 0, "前");
  assert.equal(anchorFromLiveEditSnapshot(model, "replacement", 0, 1).startOffset, 1);
});
