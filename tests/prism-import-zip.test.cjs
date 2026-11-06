"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { once } = require("node:events");
const prism = require("../electron/services/prism-import.cjs");

// A zip writer small enough to forge what a real one would not: sizes that
// lie, entry counts, symlink modes, raw name bytes, zip64 records.
const FILE_MODE = (0o100644 << 16) >>> 0;
const LINK_MODE = (0o120777 << 16) >>> 0;
const makeZip = (entries, { count, zip64 = false } = {}) => {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = entry.nameBytes ?? Buffer.from(entry.name, "utf8");
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? "", "utf8");
    const method = entry.method ?? 8;
    const payload = entry.payload ?? (method === 8 ? zlib.deflateRawSync(data) : data);
    const size = entry.declaredSize ?? entry.size ?? data.length;
    const flags = entry.flags ?? 0x800;
    const crc = typeof zlib.crc32 === "function" && !entry.payload ? zlib.crc32(data) : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0x5b61, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(zip64 ? 0xffffffff : payload.length, 18);
    local.writeUInt32LE(zip64 ? 0xffffffff : size, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, payload);
    const extra = Buffer.alloc(zip64 ? 28 : 0);
    if (zip64) {
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(24, 2);
      extra.writeBigUInt64LE(BigInt(size), 4);
      extra.writeBigUInt64LE(BigInt(payload.length), 12);
      extra.writeBigUInt64LE(BigInt(offset), 20);
    }
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE((3 << 8) | 45, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(flags, 8);
    record.writeUInt16LE(method, 10);
    record.writeUInt16LE(0x5b61, 14);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(zip64 ? 0xffffffff : payload.length, 20);
    record.writeUInt32LE(zip64 ? 0xffffffff : size, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt16LE(extra.length, 30);
    record.writeUInt32LE(entry.mode ?? FILE_MODE, 38);
    record.writeUInt32LE(zip64 ? 0xffffffff : offset, 42);
    central.push(record, name, extra);
    offset += 30 + name.length + payload.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(zip64 ? 0xffff : count ?? entries.length, 8);
  end.writeUInt16LE(zip64 ? 0xffff : count ?? entries.length, 10);
  end.writeUInt32LE(zip64 ? 0xffffffff : directory.length, 12);
  end.writeUInt32LE(zip64 ? 0xffffffff : offset, 16);
  if (!zip64) return Buffer.concat([...parts, directory, end]);
  const record64 = Buffer.alloc(56);
  record64.writeUInt32LE(0x06064b50, 0);
  record64.writeBigUInt64LE(44n, 4);
  record64.writeUInt16LE(45, 12);
  record64.writeUInt16LE(45, 14);
  record64.writeBigUInt64LE(BigInt(entries.length), 24);
  record64.writeBigUInt64LE(BigInt(count ?? entries.length), 32);
  record64.writeBigUInt64LE(BigInt(directory.length), 40);
  record64.writeBigUInt64LE(BigInt(offset), 48);
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeBigUInt64LE(BigInt(offset + directory.length), 8);
  locator.writeUInt32LE(1, 16);
  return Buffer.concat([...parts, directory, record64, locator, end]);
};

// A deflate stream of `bytes` zeros, made without holding them in memory.
const deflatedZeros = async (bytes) => {
  const deflate = zlib.createDeflateRaw({ level: 9 });
  const chunks = [];
  deflate.on("data", (chunk) => chunks.push(chunk));
  const zero = Buffer.alloc(1 << 20);
  for (let written = 0; written < bytes; written += zero.length) {
    if (!deflate.write(zero)) await once(deflate, "drain");
  }
  deflate.end();
  await once(deflate, "end");
  return Buffer.concat(chunks);
};

const tempDir = async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "prism-zip-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
};

const writeZip = async (dir, entries, options) => {
  const zipPath = path.join(dir, "export.zip");
  await fs.writeFile(zipPath, makeZip(entries, options));
  return zipPath;
};

const exists = (target) => fs.lstat(target).then(() => true, () => false);

const listFiles = async (root) => {
  const out = [];
  const visit = async (dir, prefix) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(path.join(dir, entry.name), relative);
      else out.push(relative.normalize("NFC"));
    }
  };
  await visit(root, "");
  return out.sort();
};

const ZEROS = 256 * 1024 * 1024;
let zerosPayload = null;
const zeros = async () => (zerosPayload ??= await deflatedZeros(ZEROS));

test("the Info-ZIP sample export unpacks into its two projects", async (t) => {
  const dir = await tempDir(t);
  const zipPath = path.join(__dirname, "../testing/prism-import-20261031/prism-export-sample.zip");
  const { root, files } = await prism.extractZip(zipPath, path.join(dir, "out"));
  assert.equal(files.length, 8);
  assert.deepEqual(prism.findProjects(files.map((file) => file.relativePath)), ["nihongo-report", "quantum-notes"]);
  const tex = await fs.readFile(path.join(root, "quantum-notes", "main.tex"), "utf8");
  assert.match(tex, /\\documentclass/);
});

test("names: the wrapper folder is dropped, Japanese names survive, macOS litter is ignored", async (t) => {
  const dir = await tempDir(t);
  const shiftJisName = Buffer.concat([Buffer.from("export/p/"), Buffer.from([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea]), Buffer.from(".tex")]);
  const zipPath = await writeZip(dir, [
    { name: "export/p/main.tex", data: "\\documentclass{article}\\begin{document}x\\end{document}" },
    { name: "export/p/図/グラフ.txt", data: "utf8 flagged" },
    { name: "export/p/メモ.txt", data: "utf8 without flag", flags: 0 },
    { nameBytes: shiftJisName, data: "shift_jis", flags: 0 },
    { name: "export/p/\u304b\u3099.txt", data: "nfd" },
    { name: "export/p/", data: "" },
    { name: "__MACOSX/export/p/._main.tex", data: "resource fork" },
    { name: "export/p/.DS_Store", data: "finder" },
    { name: "export/p/.tex64/settings.json", data: "{\"buildProfiles\":[]}" },
  ]);
  const { root, files } = await prism.extractZip(zipPath, path.join(dir, "out"));
  const expected = ["p/main.tex", "p/図/グラフ.txt", "p/メモ.txt", "p/日本語.tex", "p/が.txt"].sort();
  assert.deepEqual(files.map((file) => file.relativePath.normalize("NFC")).sort(), expected);
  assert.deepEqual(await listFiles(root), expected);
  assert.equal(await fs.readFile(path.join(root, "p", "日本語.tex"), "utf8"), "shift_jis");
});

test("traversal, absolute and drive paths are refused before anything is written", async (t) => {
  for (const name of ["../evil.tex", "p/../../evil.tex", "/abs/evil.tex", "C:/evil.tex", "p\\..\\..\\evil.tex"]) {
    const dir = await tempDir(t);
    const zipPath = await writeZip(dir, [{ name: "p/main.tex", data: "ok" }, { name, data: "evil" }]);
    const destination = path.join(dir, "nested", "out");
    await assert.rejects(prism.extractZip(zipPath, destination), /Unsafe path/, name);
    assert.equal(await exists(path.join(dir, "nested")), false, name);
    assert.equal(await exists(path.join(dir, "evil.tex")), false, name);
  }
});

test("a symbolic link entry is neither written as a link nor as a file", async (t) => {
  const dir = await tempDir(t);
  const zipPath = await writeZip(dir, [
    { name: "p/main.tex", data: "ok" },
    { name: "p/escape", data: "/etc", mode: LINK_MODE, method: 0 },
    { name: "p/escape/passwd", data: "through the link" },
  ]);
  const { root, files } = await prism.extractZip(zipPath, path.join(dir, "out"));
  assert.equal(await exists(path.join(root, "escape")), true);
  assert.equal((await fs.lstat(path.join(root, "escape"))).isDirectory(), true);
  assert.deepEqual(files.map((file) => file.relativePath).sort(), ["escape/passwd", "main.tex"]);
});

test("duplicate and case-colliding names: the first entry keeps the path and is never replaced", async (t) => {
  const dir = await tempDir(t);
  const zipPath = await writeZip(dir, [
    { name: "p/main.tex", data: "first" },
    { name: "p/main.tex", data: "second" },
    { name: "p/Fig.png", data: "upper" },
    { name: "p/fig.png", data: "lower" },
    { name: "p/a", data: "file" },
    { name: "p/A/b.tex", data: "under a file" },
    { name: "p/d/x.tex", data: "folder first" },
    { name: "p/D", data: "file over a folder" },
    { name: "p/\u304c.tex", data: "nfc" },
    { name: "p/\u304b\u3099.tex", data: "nfd" },
  ]);
  const { root, files } = await prism.extractZip(zipPath, path.join(dir, "out"));
  assert.deepEqual(files.map((file) => file.relativePath.normalize("NFC")).sort(), ["Fig.png", "a", "d/x.tex", "main.tex", "が.tex"]);
  assert.deepEqual(await listFiles(root), ["Fig.png", "a", "d/x.tex", "main.tex", "が.tex"]);
  assert.equal(await fs.readFile(path.join(root, "main.tex"), "utf8"), "first");
  assert.equal(await fs.readFile(path.join(root, "Fig.png"), "utf8"), "upper");
  assert.equal(await fs.readFile(path.join(root, "が.tex"), "utf8"), "nfc");
});

test("an entry that inflates past its declared size stops at the declaration, without buffering it", async (t) => {
  const dir = await tempDir(t);
  const payload = await zeros();
  const zipPath = await writeZip(dir, [
    { name: "p/main.tex", data: "ok" },
    { name: "p/bomb.bin", payload, size: 1024 },
  ]);
  const destination = path.join(dir, "out");
  const before = process.memoryUsage();
  await assert.rejects(prism.extractZip(zipPath, destination), /larger than declared/);
  const after = process.memoryUsage();
  assert.equal(await exists(destination), false);
  // The old path held the whole 256 MB entry in one Buffer.
  assert.ok(after.arrayBuffers - before.arrayBuffers < 64 * 1024 * 1024, `arrayBuffers grew by ${after.arrayBuffers - before.arrayBuffers}`);
  assert.ok(after.rss - before.rss < 128 * 1024 * 1024, `rss grew by ${after.rss - before.rss}`);
});

test("forged sizes: smaller-than-declared, stored overruns and a declared total over 2 GB are refused", async (t) => {
  const dir = await tempDir(t);
  const shortZip = await writeZip(dir, [{ name: "p/main.tex", data: "ok" }, { name: "p/short.tex", data: "abc", size: 10 }]);
  await assert.rejects(prism.extractZip(shortZip, path.join(dir, "short")), /smaller than declared/);
  assert.equal(await exists(path.join(dir, "short")), false);

  const storedZip = await writeZip(dir, [{ name: "p/stored.tex", data: "0123456789", method: 0, size: 4 }]);
  await assert.rejects(prism.extractZip(storedZip, path.join(dir, "stored")), /larger than declared/);
  assert.equal(await exists(path.join(dir, "stored")), false);

  const hugeZip = await writeZip(dir, [
    { name: "p/a.bin", data: "x", size: 0x7fffffff },
    { name: "p/b.bin", data: "x", size: 0x7fffffff },
  ]);
  await assert.rejects(prism.extractZip(hugeZip, path.join(dir, "huge")), /more than 2 GB/);
  assert.equal(await exists(path.join(dir, "huge")), false);
});

test("the entry count and the directory size are checked before the directory is read", async (t) => {
  const dir = await tempDir(t);
  const manyZip = await writeZip(dir, [{ name: "p/main.tex", data: "ok" }], { count: 60000 });
  await assert.rejects(prism.extractZip(manyZip, path.join(dir, "many")), /too many files/);
  const many64 = await writeZip(dir, [{ name: "p/main.tex", data: "ok" }], { zip64: true, count: 2 ** 40 });
  await assert.rejects(prism.extractZip(many64, path.join(dir, "many64")), /too many files/);
  assert.equal(await exists(path.join(dir, "many")), false);
});

test("zip64 records are read", async (t) => {
  const dir = await tempDir(t);
  const zipPath = await writeZip(dir, [{ name: "p/main.tex", data: "zip64 main" }, { name: "p/b.tex", data: "zip64 b" }], { zip64: true });
  const { root, files } = await prism.extractZip(zipPath, path.join(dir, "out"));
  assert.deepEqual(files.map((file) => file.relativePath).sort(), ["b.tex", "main.tex"]);
  assert.equal(await fs.readFile(path.join(root, "main.tex"), "utf8"), "zip64 main");
});

test("encrypted, unsupported and truncated zips are invalid", async (t) => {
  const dir = await tempDir(t);
  const encrypted = await writeZip(dir, [{ name: "p/main.tex", data: "x", flags: 0x801 }]);
  await assert.rejects(prism.extractZip(encrypted, path.join(dir, "a")), /Invalid zip/);
  const bzip2 = await writeZip(dir, [{ name: "p/main.tex", data: "x", method: 12, payload: Buffer.from("BZh9") }]);
  await assert.rejects(prism.extractZip(bzip2, path.join(dir, "b")), /Invalid zip/);
  const truncatedPath = path.join(dir, "truncated.zip");
  await fs.writeFile(truncatedPath, makeZip([{ name: "p/main.tex", data: "x".repeat(1000) }]).subarray(0, 40));
  await assert.rejects(prism.extractZip(truncatedPath, path.join(dir, "c")), /Invalid zip/);
});

test("cancelling between entries and inside an entry removes everything written", async (t) => {
  const dir = await tempDir(t);
  const many = Array.from({ length: 20 }, (_, index) => ({ name: `p/f${index}.tex`, data: `file ${index}` }));
  const zipPath = await writeZip(dir, many);
  const controller = new AbortController();
  const destination = path.join(dir, "out");
  await assert.rejects(
    prism.extractZip(zipPath, destination, { signal: controller.signal, onProgress: ({ current }) => { if (current === 3) controller.abort(); } }),
    { name: "AbortError" },
  );
  assert.equal(await exists(destination), false);

  const bigZip = path.join(dir, "big.zip");
  await fs.writeFile(bigZip, makeZip([{ name: "p/main.tex", data: "ok" }, { name: "p/big.bin", payload: await zeros(), size: ZEROS }]));
  const inside = new AbortController();
  const bigDestination = path.join(dir, "big");
  const pending = prism.extractZip(bigZip, bigDestination, { signal: inside.signal, onProgress: () => setTimeout(() => inside.abort(), 5) });
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(await exists(bigDestination), false);
});

test("a failure in a folder that already existed removes only what this call wrote", async (t) => {
  const dir = await tempDir(t);
  const destination = path.join(dir, "existing");
  await fs.mkdir(destination);
  await fs.writeFile(path.join(destination, "keep.txt"), "user file");
  const zipPath = await writeZip(dir, [
    { name: "a.tex", data: "written first" },
    { name: "sub/b.tex", data: "written second" },
    { name: "sub/c.tex", data: "abc", size: 99 },
  ]);
  await assert.rejects(prism.extractZip(zipPath, destination), /smaller than declared/);
  assert.deepEqual(await listFiles(destination), ["keep.txt"]);
});
