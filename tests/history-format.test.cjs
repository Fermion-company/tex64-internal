"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");
const source = fs.readFileSync(require.resolve("../web-src/app/history-format.ts"), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 } }).outputText;
const exported = {};
new Function("exports", compiled)(exported);
const { historyVersionTitle: title, historyDateLabels: dates } = exported;
const record = (id, createdAt, extra = {}) => ({ id, createdAt, kind: "manual", label: "", ...extra });
const labels = { unnamed: "Unnamed", beforeRestore: "Before restore", interruptedRestore: "Interrupted restore", returned: "Returned", restored: name => `Restored ${name}` };
const local = (year, month, day, hour = 12, minute = 0, second = 0) => new Date(year, month - 1, day, hour, minute, second).toISOString();

test("titles preserve explicit date names and do not recursively expand restoration history", () => {
  const named = record("named", local(2026, 9, 8), { label: "2026/9/8 03:48:01" });
  const restore = record("restore", named.createdAt, { kind: "restore", restoredFrom: named.id });
  const second = record("second", named.createdAt, { kind: "restore", restoredFrom: restore.id });
  const safety = record("safety", named.createdAt, { kind: "safety", label: "Before restore" });
  const returned = record("returned", named.createdAt, { kind: "restore", restoredFrom: safety.id, preRestore: safety.id });
  const all = [named, restore, second, safety, returned];
  assert.equal(title(named, all, labels), named.label);
  assert.equal(title(restore, all, labels), `Restored ${named.label}`);
  assert.equal(title(second, all, labels), "Restored Unnamed");
  assert.equal(title(safety, all, labels), "Before restore");
  assert.equal(title(safety, [], labels), "Interrupted restore");
  assert.equal(title(returned, all, labels), "Returned");
  assert.equal(title({ ...returned, label: "Chosen label" }, all, labels), "Chosen label");
  assert.equal(title(record("missing", named.createdAt, { kind: "restore", restoredFrom: "unknown" }), all, labels), "Restored Unnamed");
});

test("local days, years and today use the supplied clock; exact labels include local UTC offset", () => {
  const now = new Date(2026, 0, 1, 0, 0, 1);
  const result = dates([record("old", local(2025, 12, 31, 23, 59)), record("new", local(2026, 1, 1, 0, 0))], now);
  assert.equal(result.get("old").group, "2025/12/31");
  assert.equal(result.get("old").today, false);
  assert.equal(result.get("new").group, "1/1");
  assert.equal(result.get("new").today, true);
  assert.equal(result.get("new").time, "00:00");
  assert.equal(result.get("old").compact, "2025/12/31 23:59");
  const offset = -new Date(local(2026, 1, 1, 0, 0)).getTimezoneOffset();
  const p = n => String(n).padStart(2, "0");
  assert.equal(result.get("new").exact, `2026/01/01 00:00:00 (UTC${offset >= 0 ? "+" : "-"}${p(Math.floor(Math.abs(offset) / 60))}:${p(Math.abs(offset) % 60)})`);
});

test("minute collisions show seconds, second collisions show a distinguishing ID prefix", () => {
  const result = dates([
    record("abcdef1", local(2026, 9, 8, 17, 2, 10)),
    record("abcdef2", local(2026, 9, 8, 17, 2, 10)),
    record("different", local(2026, 9, 8, 17, 2, 11)),
    record("next", local(2026, 9, 8, 17, 3, 10)),
    record("tomorrow", local(2026, 9, 9, 17, 3, 10)),
  ], new Date(2026, 8, 8));
  assert.equal(result.get("abcdef1").time, "17:02:10 · abcdef1");
  assert.equal(result.get("abcdef2").time, "17:02:10 · abcdef2");
  assert.equal(result.get("different").time, "17:02:11");
  assert.equal(result.get("next").time, "17:03");
  assert.equal(result.get("abcdef1").compact, "9/8 17:02:10 · abcdef1");
});

test("duplicate IDs are counted once and short prefix IDs stay unique", () => {
  const first = record("a", local(2026, 9, 8, 1, 2, 3));
  const lone = dates([first, { ...first, createdAt: local(2026, 9, 9) }]);
  assert.equal(lone.size, 1);
  assert.equal(lone.get("a").time, "01:02");
  const result = dates([first, first, { ...first, id: "ab" }]);
  assert.equal(result.size, 2);
  assert.notEqual(result.get("a").time, result.get("ab").time);
});
