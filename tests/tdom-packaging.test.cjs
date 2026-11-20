"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { syncTdomEngine } = require("../scripts/sync-tdom-engine.cjs");
const { prepareTdomShim } = require("../scripts/prepare-tdom-shim.cjs");
const verifyPackagedShim = require("../scripts/verify-tdom-shim.cjs");

const fixture = t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-tdom-package-"));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const sourceDir = path.join(root, "source");
  const checkpoint = path.join(sourceDir, "engine/checkpoint");
  fs.mkdirSync(checkpoint, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, "server.js"), "");
  fs.writeFileSync(path.join(sourceDir, "package.json"), '{"type":"module"}');
  fs.writeFileSync(path.join(checkpoint, "tdomfork.c"), "source fixture");
  fs.writeFileSync(path.join(checkpoint, "forkshim-probe.lua"), "probe fixture");
  // A deterministic native-build stand-in: exercise the actual sync, prepare
  // and packaged-layout checks without requiring a compiler in unit tests.
  fs.writeFileSync(path.join(checkpoint, "forkshim.js"), `
    import fs from 'node:fs'; import path from 'node:path'; import {createHash} from 'node:crypto';
    export async function buildPrebuiltShim({ sourceDir, arch, platform }) {
      const out = path.join(sourceDir, 'prebuilt', 'tdomfork-' + platform + '-' + arch + '.so');
      fs.mkdirSync(path.dirname(out), {recursive:true});
      const bytes = Buffer.alloc(32); bytes.writeUInt32LE(0xfeedfacf,0);
      bytes.writeUInt32LE(arch === 'arm64' ? 0x0100000c : 0x01000007,4);
      fs.writeFileSync(out,bytes);
      fs.writeFileSync(out+'.sha256',createHash('sha256').update(fs.readFileSync(path.join(sourceDir,'tdomfork.c'))).digest('hex')+'\\n');
      return out;
    }
  `);
  return { root, sourceDir };
};

for (const [arch, id] of [["arm64", 3], ["x64", 1]]) {
  test(`sync builds and stamps ${arch}; packaged shim is unpacked and discovered for signing`, { skip: process.platform !== "darwin" }, async t => {
    const { root, sourceDir } = fixture(t);
    const contents = path.join(root, "TeX64.app/Contents");
    const destinationDir = path.join(contents, "Resources/app.asar.unpacked/Resources/tdom-engine");
    await syncTdomEngine({ sourceDir, destinationDir, arch });
    const checkpoint = path.join(destinationDir, "engine/checkpoint");
    const so = path.join(checkpoint, `prebuilt/tdomfork-darwin-${arch}.so`);
    const hash = createHash("sha256").update(fs.readFileSync(path.join(checkpoint, "tdomfork.c"))).digest("hex");
    assert.equal(fs.readFileSync(so + ".sha256", "utf8").trim(), hash);
    verifyPackagedShim({ appOutDir: root, electronPlatformName: "darwin", arch: id });
    const { walkAsync } = require("../node_modules/@electron/osx-sign/dist/cjs/util.js");
    assert.ok((await walkAsync(contents)).includes(so));
    const config = require("../package.json");
    assert.ok(config.build.asarUnpack.includes("Resources/tdom-engine/**"));
    assert.ok(config.build.mac.files.includes("Resources/**"));
    assert.equal(config.build.afterPack, "scripts/verify-tdom-shim.cjs");
    assert.match(config.scripts["dist:prep"], /prepare-tdom-shim/);
    fs.writeFileSync(so + ".sha256", "stale");
    assert.throws(() => verifyPackagedShim({ appOutDir: root, electronPlatformName: "darwin", arch: id }), /Stale/);
    await prepareTdomShim({ engineDir: destinationDir, arch });
    assert.equal(fs.readFileSync(so + ".sha256", "utf8").trim(), hash);
    assert.throws(() => verifyPackagedShim({ appOutDir: root, electronPlatformName: "darwin", arch: id === 3 ? 1 : 3 }), /ENOENT/);
  });
}

test("missing build API and failed native build abort packaging", async t => {
  const { root, sourceDir } = fixture(t);
  const file = path.join(sourceDir, "engine/checkpoint/forkshim.js");
  fs.writeFileSync(file, "export const oldEngine = true;");
  await assert.rejects(prepareTdomShim({ engineDir: sourceDir, platform: "darwin" }), /update TDOM_ENGINE_COMMIT/);
  const broken = path.join(root, "broken");
  fs.cpSync(sourceDir, broken, { recursive: true });
  fs.writeFileSync(path.join(broken, "engine/checkpoint/forkshim.js"), "export async function buildPrebuiltShim() { throw new Error('cc failed'); }");
  await assert.rejects(prepareTdomShim({ engineDir: broken, platform: "darwin" }), /cc failed/);
});

test("Windows and Linux packaging retain runtime compilation", async () => {
  for (const platform of ["win32", "linux"]) {
    assert.equal(await prepareTdomShim({ engineDir: "/missing", platform }), null);
    verifyPackagedShim({ appOutDir: "/missing", electronPlatformName: platform, arch: 1 });
  }
});
