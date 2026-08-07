"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  WARNING_END,
  WARNING_START,
  mergeChecksums,
  mergeReleaseNotes,
  mergeStableFeed,
  validateWindowsArtifact,
} = require("../scripts/prepare-windows-preview-promotion.cjs");

const VERSION = "0.1.21";
const MAC_ARM_SHA = "a".repeat(64);
const MAC_X64_SHA = "b".repeat(64);

const createUnsignedPe = (filePath, { signed = false } = {}) => {
  const bytes = Buffer.alloc(1024 * 1024, 0);
  bytes.write("MZ", 0, "ascii");
  const peOffset = 0x80;
  bytes.writeUInt32LE(peOffset, 0x3c);
  bytes.write("PE\0\0", peOffset, "ascii");
  bytes.writeUInt16LE(0x14c, peOffset + 4);
  bytes.writeUInt16LE(3, peOffset + 6);
  bytes.writeUInt16LE(224, peOffset + 20);
  const optionalOffset = peOffset + 24;
  bytes.writeUInt16LE(0x10b, optionalOffset);
  bytes.writeUInt32LE(16, optionalOffset + 92);
  if (signed) {
    bytes.writeUInt32LE(0x800, optionalOffset + 96 + 4 * 8);
    bytes.writeUInt32LE(256, optionalOffset + 96 + 4 * 8 + 4);
  }
  fs.writeFileSync(filePath, bytes);
};

test("promotion workflow is manual, gated, least-privilege, and verifies both public copies", () => {
  const workflow = fs.readFileSync(
    path.join(__dirname, "..", ".github", "workflows", "promote-windows-preview.yml"),
    "utf8"
  );

  assert.match(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /source_run_id:/u);
  assert.match(workflow, /version:/u);
  assert.match(
    workflow,
    /publish_unsigned_windows_preview:[\s\S]*?default: false[\s\S]*?type: boolean/u
  );
  assert.match(workflow, /permissions:\s*\n\s*actions: read\s*\n\s*contents: write/u);
  assert.match(workflow, /PUBLISH_ACKNOWLEDGED/u);
  assert.match(workflow, /conclusion[^\n]*success/u);
  assert.match(workflow, /head_sha/u);
  assert.match(workflow, /\.github\/workflows\/release\.yml/u);
  assert.match(workflow, /tex64-windows-unsigned-preview-x64-/u);
  assert.match(workflow, /tex64-windows-beta-x64-/u);
  assert.match(workflow, /gh release upload/u);
  assert.match(workflow, /s3:\/\/\$TEX64_DOWNLOADS_BUCKET\/tex64\/updates\/stable\.json/u);
  assert.match(workflow, /Microsoft Defender SmartScreen/u);
  assert.match(workflow, /r2-installer\.exe/u);
  assert.match(workflow, /sha256sum promotion\/verification\/r2-installer\.exe/u);
});

test("artifact validator accepts the legacy and canonical unsigned names", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-win-promotion-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  for (const fileName of [
    `TeX64-${VERSION}-win-x64.exe`,
    `TeX64-${VERSION}-unsigned-preview-win-x64.exe`,
  ]) {
    const artifactPath = path.join(dir, fileName);
    createUnsignedPe(artifactPath);
    const metadata = await validateWindowsArtifact({ artifactPath, version: VERSION });
    assert.equal(metadata.fileName, fileName);
    assert.equal(metadata.signature, "unsigned");
    assert.match(metadata.sha256, /^[a-f0-9]{64}$/u);
  }
});

test("artifact validator rejects a signed PE or wrong release version", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-win-promotion-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const signedPath = path.join(dir, `TeX64-${VERSION}-win-x64.exe`);
  createUnsignedPe(signedPath, { signed: true });

  await assert.rejects(
    validateWindowsArtifact({ artifactPath: signedPath, version: VERSION }),
    /Authenticode certificate table/u
  );
  await assert.rejects(
    validateWindowsArtifact({ artifactPath: signedPath, version: "0.1.22" }),
    /Unexpected installer name/u
  );
});

test("promotion metadata preserves macOS checksums and feed artifacts", () => {
  const metadata = {
    fileName: `TeX64-${VERSION}-win-x64.exe`,
    sha256: "c".repeat(64),
    version: VERSION,
  };
  const existingChecksums = [
    `${MAC_ARM_SHA}  TeX64-${VERSION}-mac-arm64.dmg`,
    `${MAC_X64_SHA}  TeX64-${VERSION}-mac-x64.dmg`,
    `${"d".repeat(64)}  TeX64-${VERSION}-unsigned-preview-win-x64.exe`,
    "",
  ].join("\n");
  const mergedChecksums = mergeChecksums({ existingText: existingChecksums, metadata });
  assert.match(mergedChecksums, new RegExp(MAC_ARM_SHA, "u"));
  assert.match(mergedChecksums, new RegExp(MAC_X64_SHA, "u"));
  assert.match(mergedChecksums, new RegExp(`${metadata.sha256}  ${metadata.fileName}`, "u"));
  assert.doesNotMatch(mergedChecksums, /unsigned-preview-win-x64/u);

  const macArtifacts = [
    {
      platform: "darwin",
      arch: "arm64",
      channel: "stable",
      kind: "dmg",
      url: `https://downloads.tex64.com/tex64/v${VERSION}/TeX64-${VERSION}-mac-arm64.dmg`,
      sha256: `sha256:${MAC_ARM_SHA}`,
    },
    {
      platform: "darwin",
      arch: "x64",
      channel: "stable",
      kind: "dmg",
      url: `https://downloads.tex64.com/tex64/v${VERSION}/TeX64-${VERSION}-mac-x64.dmg`,
      sha256: `sha256:${MAC_X64_SHA}`,
    },
  ];
  const existingFeed = {
    latestVersion: VERSION,
    channel: "stable",
    publishedAt: "2026-08-01T00:00:00.000Z",
    required: false,
    notesUrl: `https://tex64.com/releases/${VERSION}`,
    artifacts: [
      ...macArtifacts,
      {
        platform: "win32",
        arch: "x64",
        channel: "stable",
        kind: "exe",
        url: "https://example.invalid/old.exe",
        sha256: `sha256:${"e".repeat(64)}`,
      },
    ],
  };
  const artifactUrl =
    `https://downloads.tex64.com/tex64/v${VERSION}/${metadata.fileName}`;
  const mergedFeed = mergeStableFeed({ existingFeed, metadata, artifactUrl });
  assert.deepEqual(
    mergedFeed.artifacts.filter((artifact) => artifact.platform === "darwin"),
    macArtifacts
  );
  const windows = mergedFeed.artifacts.filter(
    (artifact) =>
      artifact.platform === "win32" && artifact.arch === "x64" && artifact.kind === "exe"
  );
  assert.deepEqual(windows, [
    {
      platform: "win32",
      arch: "x64",
      channel: "stable",
      kind: "exe",
      url: artifactUrl,
      sha256: `sha256:${metadata.sha256}`,
    },
  ]);
});

test("release warning is explicit and idempotent", () => {
  const metadata = {
    fileName: `TeX64-${VERSION}-win-x64.exe`,
    sha256: "f".repeat(64),
    version: VERSION,
  };
  const first = mergeReleaseNotes({ existingText: "Existing release notes\n", metadata });
  const second = mergeReleaseNotes({ existingText: first, metadata });
  assert.equal(second, first);
  assert.equal(first.split(WARNING_START).length - 1, 1);
  assert.equal(first.split(WARNING_END).length - 1, 1);
  assert.match(first, /Microsoft Defender SmartScreen/u);
  assert.match(first, new RegExp(metadata.sha256, "u"));
  assert.match(first, /Existing release notes/u);
});
