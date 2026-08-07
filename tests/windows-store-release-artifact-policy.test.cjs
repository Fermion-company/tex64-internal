const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  isMicrosoftStoreArtifact,
  isPublicDownloadsArtifact,
  parsePublicUpdateArtifactKind,
} = require("../scripts/release-artifact-policy.cjs");
const {
  isStorePublicationRequested,
  resolveArtifacts,
} = require("../scripts/release-bundle.cjs");
const {
  findReleaseArtifacts,
} = require("../scripts/release-upload-downloads.cjs");
const {
  parseKind: parseStableFeedArtifactKind,
} = require("../scripts/release-update-feed.cjs");

const version = "1.2.3";
const windowsPreviewName = `TeX64-${version}-unsigned-preview-win-x64.exe`;
const names = [
  `TeX64-${version}-mac-arm64.dmg`,
  `TeX64-${version}-mac-arm64.zip`,
  windowsPreviewName,
  `TeX64-${version}-win-x64.msi`,
  `TeX64-${version}-win-x64.appx`,
  `TeX64-${version}-win-x64.msix`,
  `TeX64-${version}-win-x64.appxbundle`,
  `TeX64-${version}-win-x64.msixbundle`,
  `TeX64-${version}-win-x64.appxupload`,
  `TeX64-${version}-win-x64.msixupload`,
];

const withArtifactDirectory = async (callback) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-release-policy-"));
  try {
    for (const name of names) {
      fs.writeFileSync(path.join(directory, name), name);
    }
    await callback(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
};

test("Microsoft Store packages are classified outside every public artifact kind", () => {
  for (const name of names.filter((item) => isMicrosoftStoreArtifact(item))) {
    assert.equal(parsePublicUpdateArtifactKind(name), "", name);
    assert.equal(parseStableFeedArtifactKind(name), "", name);
    assert.equal(isPublicDownloadsArtifact(name), false, name);
  }
  assert.equal(parsePublicUpdateArtifactKind(windowsPreviewName), "exe");
  assert.equal(parsePublicUpdateArtifactKind(`TeX64-${version}-win-x64.msi`), "msi");
});

test("release bundle always isolates Store packages while direct Windows remains opt-in", async () => {
  await withArtifactDirectory(async (directory) => {
    const defaultSelection = await resolveArtifacts(directory, version);
    assert.deepEqual(
      defaultSelection.artifacts.map((item) => path.basename(item)),
      [`TeX64-${version}-mac-arm64.dmg`, `TeX64-${version}-mac-arm64.zip`]
    );
    assert.equal(defaultSelection.storeArtifacts.length, 6);

    const directSelection = await resolveArtifacts(directory, version, {
      includeWindowsDirect: true,
      includeWindowsStore: true,
    });
    assert.deepEqual(
      directSelection.artifacts.map((item) => path.basename(item)),
      [
        `TeX64-${version}-mac-arm64.dmg`,
        `TeX64-${version}-mac-arm64.zip`,
        windowsPreviewName,
        `TeX64-${version}-win-x64.msi`,
      ]
    );
    assert.equal(directSelection.storeArtifacts.length, 6);
  });
});

test("legacy Store-publication switches fail closed", () => {
  assert.equal(isStorePublicationRequested(["--include-windows-store"], {}), true);
  assert.equal(isStorePublicationRequested([], { TEX64_INCLUDE_WINDOWS_STORE: "true" }), true);
  assert.equal(isStorePublicationRequested([], {}), false);
});

test("CDN upload discovery excludes Store packages", async () => {
  await withArtifactDirectory(async (directory) => {
    assert.deepEqual(
      findReleaseArtifacts(directory, version).map((item) => path.basename(item)),
      [
        `TeX64-${version}-mac-arm64.dmg`,
        `TeX64-${version}-mac-arm64.zip`,
        windowsPreviewName,
        `TeX64-${version}-win-x64.msi`,
      ]
    );
  });
});

test("stable update feed includes the labeled Windows preview installer", async () => {
  await withArtifactDirectory(async (directory) => {
    const checksumsPath = path.join(directory, "checksums-sha256.txt");
    const feedPath = path.join(directory, "stable.json");
    execFileSync(process.execPath, [
      path.join(__dirname, "..", "scripts", "release-checksums.cjs"),
      "--dir",
      directory,
      "--out",
      checksumsPath,
    ]);
    execFileSync(process.execPath, [
      path.join(__dirname, "..", "scripts", "release-update-feed.cjs"),
      "--dir",
      directory,
      "--out",
      feedPath,
      "--channel",
      "stable",
      "--version",
      version,
      "--artifactsBaseUrl",
      `https://downloads.tex64.com/tex64/v${version}`,
      "--notesUrl",
      `https://tex64.com/releases/${version}`,
    ]);

    const feed = JSON.parse(fs.readFileSync(feedPath, "utf8"));
    const windowsArtifact = feed.artifacts.find(
      ({ platform, arch, kind }) =>
        platform === "win32" && arch === "x64" && kind === "exe"
    );
    assert.ok(windowsArtifact, "stable feed must contain the Windows preview installer");
    assert.deepEqual(windowsArtifact, {
      platform: "win32",
      arch: "x64",
      channel: "stable",
      kind: "exe",
      url: `https://downloads.tex64.com/tex64/v${version}/${windowsPreviewName}`,
      sha256: windowsArtifact.sha256,
    });
    assert.match(windowsArtifact.sha256, /^sha256:[a-f0-9]{64}$/u);
  });
});
