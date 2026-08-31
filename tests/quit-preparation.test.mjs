import assert from "node:assert/strict";
import test from "node:test";

import { prepareRendererForQuit } from "../Resources/web/app/quit-preparation.js";

test("quit preparation saves every dirty buffer before freezing", async () => {
  const dirty = new Set(["first.tex", "second.tex"]);
  const order = [];
  const result = await prepareRendererForQuit({
    quiesce: async () => {
      order.push("quiesce");
      return { ok: true };
    },
    saveDirtyFiles: async () => {
      for (const path of [...dirty]) {
        await Promise.resolve();
        order.push(`save:${path}`);
        dirty.delete(path);
      }
      return true;
    },
    getDirtyFileCount: () => dirty.size,
    freeze: () => order.push("freeze"),
  });

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(order, ["quiesce", "save:first.tex", "save:second.tex", "freeze"]);
});

test("edits arriving during a save are drained in another pass", async () => {
  const dirty = new Set(["first.tex"]);
  let savePass = 0;
  let frozen = false;
  const result = await prepareRendererForQuit({
    quiesce: async () => ({ ok: true }),
    saveDirtyFiles: async () => {
      savePass += 1;
      dirty.clear();
      if (savePass === 1) dirty.add("late.tex");
      return true;
    },
    getDirtyFileCount: () => dirty.size,
    freeze: () => {
      frozen = true;
    },
  });

  assert.equal(result.ok, true);
  assert.equal(savePass, 2);
  assert.equal(frozen, true);
  assert.equal(dirty.size, 0);
});

test("failed quiesce or save cancels quit without freezing", async () => {
  for (const scenario of ["quiesce", "save"]) {
    let frozen = false;
    const result = await prepareRendererForQuit({
      quiesce: async () =>
        scenario === "quiesce" ? { ok: false, error: "busy" } : { ok: true },
      saveDirtyFiles: async () => scenario !== "save",
      getDirtyFileCount: () => 1,
      freeze: () => {
        frozen = true;
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.phase, scenario);
    assert.equal(frozen, false);
  }
});
