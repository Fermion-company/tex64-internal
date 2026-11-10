"use strict";
// Files over the shared-file limit: a PNG or JPEG goes out as a smaller copy
// (its owner keeps the full file), anything else is not shared, and everyone
// is told. The hubs run outside Electron, so a stand-in reducer replaces
// nativeImage; the resolution rewriting is tested on its own.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { CollabHub } = require("../electron/services/collab/hub.cjs");
const reduce = require("../electron/services/collab/image-reduce.cjs");

const waitFor = async (predicate, timeoutMs = 8000, label = "condition") => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
};

// A minimal RGB PNG, optionally with a pHYs chunk (pixels per meter).
const pngChunk = (type, data) => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  data.copy(out, 8);
  out.writeUInt32BE(reduce.crc32(Buffer.concat([Buffer.from(type, "latin1"), data])), 8 + data.length);
  return out;
};
const makePng = (width, height, ppm = null) => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height);
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk("IHDR", header)];
  if (ppm) {
    const phys = Buffer.alloc(9);
    phys.writeUInt32BE(ppm, 0);
    phys.writeUInt32BE(ppm, 4);
    phys[8] = 1;
    parts.push(pngChunk("pHYs", phys));
  }
  parts.push(pngChunk("IDAT", zlib.deflateSync(rows)), pngChunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(parts);
};
// SOI, an optional JFIF APP0 (units, x, y), then stand-in image data.
const makeJpeg = (density = null) => {
  const parts = [Buffer.from([0xff, 0xd8])];
  if (density) {
    const app0 = Buffer.alloc(18);
    app0.writeUInt16BE(0xffe0, 0);
    app0.writeUInt16BE(16, 2);
    app0.write("JFIF\0", 4, "latin1");
    app0[9] = 1;
    app0[10] = 1;
    app0[11] = density.units;
    app0.writeUInt16BE(density.x, 12);
    app0.writeUInt16BE(density.y, 14);
    parts.push(app0);
  }
  parts.push(Buffer.from([0xff, 0xdb, 0x00, 0x04, 0x00, 0x00, 0xff, 0xd9]));
  return Buffer.concat(parts);
};

test("a smaller copy keeps the image's printed size: resolution scales with the pixels", () => {
  // 300 dpi = 11811 px/m; at half the pixels the copy says 150 dpi.
  const original = makePng(8, 8, 11811);
  const copy = reduce.scalePngDensity(makePng(4, 4), original, 0.5);
  assert.equal(reduce.pngDensity(copy).x, Math.round(11811 * 0.5));
  // Every chunk of the copy still checks out.
  let offset = 8;
  while (offset < copy.length) {
    const length = copy.readUInt32BE(offset);
    const body = copy.subarray(offset + 4, offset + 8 + length);
    assert.equal(copy.readUInt32BE(offset + 8 + length), reduce.crc32(body));
    offset += 12 + length;
  }
  // No pHYs in the original: TeX's default of 72 dpi, scaled.
  const plain = reduce.scalePngDensity(makePng(4, 4), makePng(8, 8), 0.5);
  assert.equal(reduce.pngDensity(plain).x, Math.round(72 * 39.37007874015748 * 0.5));

  // JPEG: JFIF density in dpi, replaced or added.
  const jpeg300 = makeJpeg({ units: 1, x: 300, y: 300 });
  assert.deepEqual(reduce.jpegDensity(reduce.scaleJpegDensity(makeJpeg({ units: 0, x: 1, y: 1 }), jpeg300, 0.25)), { x: 75, y: 75 });
  assert.deepEqual(reduce.jpegDensity(reduce.scaleJpegDensity(makeJpeg(), jpeg300, 0.5)), { x: 150, y: 150 });
  assert.deepEqual(reduce.jpegDensity(reduce.scaleJpegDensity(makeJpeg(), makeJpeg(), 0.5)), { x: 36, y: 36 });
});

const LIMIT = 64 * 1024;
// Stands in for nativeImage: images become a small marked copy, other files cannot be reduced.
const fakeReduce = async ({ path: file, extension, maxBytes }) => {
  if (!["png", "jpg", "jpeg"].includes(extension)) return null;
  const copy = Buffer.concat([Buffer.from(`small copy of ${path.basename(file)}:`), fs.readFileSync(file).subarray(0, 1000)]);
  return copy.length <= maxBytes ? copy : null;
};

const makeHub = (rootRef, { collabRoot, name, messages }) => new CollabHub({
  workspace: {
    getRootPath: () => rootRef.path,
    rootInfo: async () => ({ path: "main.tex" }),
    withFileMutation: (_relative, operation) => operation(),
  },
  state: {},
  sendCollab: (message) => messages.push(message),
  withWorkspaceMutation: (operation) => operation(),
  trackSaved: () => {},
  openWorkspacePath: async (root) => { rootRef.path = root; },
  refreshTree: () => {},
  recordVersion: async () => {},
  locale: () => "ja",
  userName: () => name,
  collabRoot: () => collabRoot,
  fileLimitBytes: () => LIMIT,
  reduceImage: fakeReduce,
});

const notices = (messages) => messages.filter((message) => message.type === "collab:notice").map((message) => message.message);

test("an image over the limit is shared as a smaller copy, other large files are not, and both sides are told", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-large-"));
  const hostRoot = path.join(base, "paper");
  fs.mkdirSync(hostRoot);
  fs.writeFileSync(path.join(hostRoot, "main.tex"), "Hello\n");
  const big = crypto.randomBytes(100 * 1024);
  const small = crypto.randomBytes(10 * 1024);
  fs.writeFileSync(path.join(hostRoot, "big.png"), big);
  fs.writeFileSync(path.join(hostRoot, "small.png"), small);
  fs.writeFileSync(path.join(hostRoot, "data.bin"), crypto.randomBytes(100 * 1024));
  const hostMessages = [];
  const guestMessages = [];
  const host = makeHub({ path: hostRoot }, { collabRoot: path.join(base, "host-collab"), name: "Host", messages: hostMessages });
  const guestRoot = { path: null };
  const guest = makeHub(guestRoot, { collabRoot: path.join(base, "guest-collab"), name: "Guest", messages: guestMessages });
  t.after(async () => {
    await Promise.allSettled([guest.leave(), host.leave()]);
    fs.rmSync(base, { recursive: true, force: true });
  });

  const started = await host.start({ name: "Host" });
  assert.ok(notices(hostMessages).some((text) => text.startsWith("big.png は 64 KB を超えるため、縮小版")), "the owner is told the image goes out smaller");
  assert.ok(notices(hostMessages).some((text) => text.startsWith("data.bin（100 KB）は 64 KB を超えるため共有していません")), "and that the other file is not shared");

  await guest.join({ link: started.inviteLink, name: "Guest" });
  const mirror = (name) => path.join(guestRoot.path, name);
  await waitFor(() => fs.existsSync(mirror("big.png")) && fs.existsSync(mirror("small.png")), 8000, "figures");
  assert.ok(fs.readFileSync(mirror("big.png")).toString("latin1").startsWith("small copy of big.png:"), "the guest has the smaller copy");
  assert.ok(fs.readFileSync(mirror("small.png")).equals(small), "a file under the limit is shared as it is");
  assert.equal(fs.existsSync(mirror("data.bin")), false);
  assert.ok(fs.readFileSync(path.join(hostRoot, "big.png")).equals(big), "the host's own file is untouched");
  assert.deepEqual(guest.status().limitedFiles, {
    reduced: [{ path: "big.png", size: fs.statSync(mirror("big.png")).size, original: big.length }],
    skipped: [{ path: "data.bin", size: 100 * 1024 }],
  });
  assert.ok(notices(guestMessages).some((text) => text.includes("画質を落として共有されているファイルが 1 件") && text.includes("大きすぎて共有されていないファイルが 1 件")), "the guest is told on joining");

  // Scans on both sides settle: nobody re-sends, nobody asks again.
  for (let round = 0; round < 3; round += 1) {
    await host.rescan();
    await guest.rescan();
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok(fs.readFileSync(path.join(hostRoot, "big.png")).equals(big));
  assert.ok(fs.readFileSync(mirror("big.png")).toString("latin1").startsWith("small copy of big.png:"));
  assert.equal(guest.status().incoming.files, 0);

  // The host replaces the image: a new smaller copy follows.
  const bigger = crypto.randomBytes(120 * 1024);
  fs.writeFileSync(path.join(hostRoot, "big.png"), bigger);
  await host.rescan();
  await waitFor(() => fs.readFileSync(mirror("big.png")).subarray(-1000).equals(bigger.subarray(0, 1000)), 8000, "the new smaller copy");
  assert.equal(guest.status().limitedFiles.reduced[0].original, bigger.length);

  // A guest's own large photo: the host gets a smaller copy, the guest keeps its full file.
  const photo = crypto.randomBytes(90 * 1024);
  fs.writeFileSync(mirror("photo.jpg"), photo);
  await guest.rescan();
  await waitFor(() => fs.existsSync(path.join(hostRoot, "photo.jpg")), 8000, "the guest's photo at the host");
  assert.ok(fs.readFileSync(path.join(hostRoot, "photo.jpg")).toString("latin1").startsWith("small copy of photo.jpg:"));
  assert.ok(notices(guestMessages).some((text) => text.startsWith("photo.jpg は 64 KB を超えるため、縮小版")));
  await waitFor(() => notices(hostMessages).some((text) => text.startsWith("photo.jpg は元のファイルが大きいため、画質を落として共有されています")), 4000, "the host is told");
  for (let round = 0; round < 3; round += 1) {
    await host.rescan();
    await guest.rescan();
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok(fs.readFileSync(mirror("photo.jpg")).equals(photo), "the guest's full photo is not replaced by its own smaller copy");
  assert.ok(fs.readFileSync(path.join(hostRoot, "photo.jpg")).toString("latin1").startsWith("small copy of photo.jpg:"));
});
