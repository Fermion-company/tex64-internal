const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");

const { SpellService } = require("../electron/services/spell/service.cjs");

test("spell service: check flags misspellings, accepts correct words", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-spell-"));
  const svc = new SpellService({ userDataPath: dir });
  try {
    const bad = await svc.check(["the", "teh", "receive", "recieve", "hello"]);
    assert.ok(bad.includes("teh"), "teh should be flagged");
    assert.ok(bad.includes("recieve"), "recieve should be flagged");
    assert.ok(!bad.includes("the"), "the should be accepted");
    assert.ok(!bad.includes("receive"), "receive should be accepted");
    assert.ok(!bad.includes("hello"), "hello should be accepted");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("spell service: suggestions for a misspelling", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-spell-"));
  const svc = new SpellService({ userDataPath: dir });
  try {
    const suggestions = await svc.suggest("recieve");
    assert.ok(Array.isArray(suggestions) && suggestions.includes("receive"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("spell service: add to dictionary persists and accepts the word", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-spell-"));
  try {
    const svc = new SpellService({ userDataPath: dir });
    assert.deepEqual(await svc.check(["mathbb"]), ["mathbb"], "unknown word flagged first");
    await svc.addWord("mathbb");
    assert.deepEqual(await svc.check(["mathbb"]), [], "accepted after add");

    // A fresh service instance should load the persisted user word.
    const svc2 = new SpellService({ userDataPath: dir });
    assert.deepEqual(await svc2.check(["mathbb"]), [], "persisted across instances");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
