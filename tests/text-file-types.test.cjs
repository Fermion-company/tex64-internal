"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  isUnknownTextBuffer, readUnknownTextFile, TEXT_SNIFF_BYTES,
  MAX_UNKNOWN_TEXT_FILE_BYTES, MAX_EXTENDED_TEXT_FILE_BYTES,
} = require("../electron/services/text-file-types.cjs");

for (const [name, bytes, expected] of [
  ["Japanese UTF-8", Buffer.from("漢字とルビ：かんじ\r\n"), true],
  ["UTF-8 BOM", Buffer.from("\uFEFF日本語\n"), true],
  ["empty file", Buffer.alloc(0), true],
  ["NUL byte", Buffer.from("text\0data"), false],
  ["NUL at the last sampled byte", Buffer.concat([Buffer.alloc(TEXT_SNIFF_BYTES - 1, 65), Buffer.from([0])]), false],
  ["NUL beyond the specified sample", Buffer.concat([Buffer.alloc(TEXT_SNIFF_BYTES, 65), Buffer.from([0])]), true],
  ["invalid UTF-8", Buffer.from([0xc3, 0x28]), false],
  ["truncated UTF-8", Buffer.from([0xe3, 0x81]), false],
  ["UTF-16 BOM", Buffer.from([0xff, 0xfe, 65, 0]), false],
  ["invalid UTF-8 after the sample", Buffer.concat([Buffer.alloc(TEXT_SNIFF_BYTES, 65), Buffer.from([0xff])]), false],
  ["UTF-8 character crossing the sample boundary", Buffer.from("a".repeat(TEXT_SNIFF_BYTES - 1) + "日本語"), true],
]) {
  test(`text sniffing: ${name}`, () => assert.equal(isUnknownTextBuffer(bytes), expected));
}

test("text sniffing reuses the existing size cap, including its boundary", () => {
  assert.equal(MAX_UNKNOWN_TEXT_FILE_BYTES, MAX_EXTENDED_TEXT_FILE_BYTES);
  assert.equal(isUnknownTextBuffer(Buffer.alloc(MAX_UNKNOWN_TEXT_FILE_BYTES, 65)), true);
  assert.equal(isUnknownTextBuffer(Buffer.alloc(MAX_UNKNOWN_TEXT_FILE_BYTES + 1, 65)), false);
});

test("bounded disk reader preserves BOM and CRLF and refuses oversized files", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-text-sniff-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "canon.ltjruby");
  const content = "\uFEFF日本語\r\nreturn {}\r\n";
  await fs.writeFile(file, content);
  assert.equal(await readUnknownTextFile(file), content);
  await fs.writeFile(file, Buffer.alloc(MAX_UNKNOWN_TEXT_FILE_BYTES, 65));
  assert.equal((await readUnknownTextFile(file)).length, MAX_UNKNOWN_TEXT_FILE_BYTES);
  await fs.truncate(file, MAX_UNKNOWN_TEXT_FILE_BYTES + 1);
  assert.equal(await readUnknownTextFile(file), null);
});
