#!/usr/bin/env node
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

function exec(command, args, options = {}) {
  return execFileSync(command, args, { stdio: "pipe", encoding: "utf8", ...options });
}

function execInherit(command, args, options = {}) {
  execFileSync(command, args, { stdio: "inherit", ...options });
}

function sleepMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.round(ms));
}

function requireMacOs() {
  if (process.platform !== "darwin") {
    console.error("ERROR: macOS is required to build a notarized macOS release.");
    process.exit(1);
  }
}

function readPackageJson() {
  const pkgPath = path.resolve("package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  return pkg && typeof pkg === "object" ? pkg : {};
}

function resolveReleaseVersion(pkg) {
  const version =
    typeof pkg?.version === "string" && pkg.version.trim() ? pkg.version.trim() : "";
  if (!version || !/^\d+\.\d+\.\d+/.test(version)) {
    console.error(`ERROR: Invalid version in package.json: "${version}"`);
    process.exit(1);
  }
  return version;
}

function normalizeUrl(value, fallback) {
  if (typeof value !== "string" || !value.trim()) {
    return fallback;
  }
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return fallback;
    }
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return fallback;
  }
}

function hasDeveloperIdIdentity() {
  try {
    const out = exec("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning"]);
    return out.includes("Developer ID Application");
  } catch {
    return false;
  }
}

function resolveNotarytoolAuthArgs() {
  const {
    APPLE_KEYCHAIN_PROFILE,
    APPLE_ID,
    APPLE_APP_SPECIFIC_PASSWORD,
    APPLE_TEAM_ID,
    APPLE_API_KEY,
    APPLE_API_KEY_ID,
    APPLE_API_ISSUER,
  } = process.env;

  if (typeof APPLE_KEYCHAIN_PROFILE === "string" && APPLE_KEYCHAIN_PROFILE.trim()) {
    return ["--keychain-profile", APPLE_KEYCHAIN_PROFILE.trim()];
  }

  if (APPLE_ID && APPLE_APP_SPECIFIC_PASSWORD && APPLE_TEAM_ID) {
    return [
      "--apple-id",
      APPLE_ID,
      "--team-id",
      APPLE_TEAM_ID,
      "--password",
      APPLE_APP_SPECIFIC_PASSWORD,
    ];
  }

  if (APPLE_API_KEY && APPLE_API_KEY_ID && APPLE_API_ISSUER) {
    return [
      "--key",
      APPLE_API_KEY,
      "--key-id",
      APPLE_API_KEY_ID,
      "--issuer",
      APPLE_API_ISSUER,
    ];
  }

  return null;
}

function ensureNotarytoolAvailable() {
  try {
    execInherit("xcrun", ["--find", "notarytool"]);
  } catch {
    console.error(
      "ERROR: Xcode Command Line Tools are required (xcrun/notarytool not found).\n" +
        "Run: xcode-select --install\n"
    );
    process.exit(1);
  }
}

function parseBuiltArch(appPath, fallbackArch = null) {
  const parent = path.basename(path.dirname(appPath));
  if (parent === "mac" && fallbackArch) {
    const normalized = normalizeArchToken(fallbackArch);
    if (normalized) {
      return normalized;
    }
  }
  if (parent.startsWith("mac-")) {
    const token = parent.slice("mac-".length);
    if (token) {
      return normalizeArchToken(token) || token;
    }
  }
  return process.arch === "arm64" ? "arm64" : "x64";
}

function resolveArchFlag(arch) {
  const token = String(arch || "").trim().toLowerCase();
  if (token === "arm64") return "--arm64";
  if (token === "x64" || token === "amd64" || token === "x86_64") return "--x64";
  return null;
}

function normalizeArchToken(value) {
  const token = String(value || "").trim().toLowerCase();
  if (!token) return "";
  if (token === "amd64" || token === "x86_64") return "x64";
  if (token === "aarch64") return "arm64";
  if (token === "x64" || token === "arm64") return token;
  return token;
}

function findBuiltApps(distDir, archFilter = null) {
  const apps = [];
  if (!fs.existsSync(distDir)) return apps;

  const entries = fs.readdirSync(distDir, { withFileTypes: true });
  const normalizedFilter = archFilter ? normalizeArchToken(archFilter) : "";
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "mac") {
      if (normalizedFilter && normalizedFilter !== "x64") continue;
      const appPath = path.join(distDir, entry.name, "TeX64.app");
      if (fs.existsSync(appPath)) apps.push(appPath);
      continue;
    }
    if (!entry.name.startsWith("mac-")) continue;
    const entryArch = normalizeArchToken(entry.name.slice("mac-".length));
    if (normalizedFilter && entryArch !== normalizedFilter) continue;
    const appPath = path.join(distDir, entry.name, "TeX64.app");
    if (fs.existsSync(appPath)) apps.push(appPath);
  }
  return apps;
}

function verifySigned(appPath) {
  execInherit("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
}

function verifyGatekeeper(appPath) {
  const spctl = spawnSync("spctl", ["-a", "-vv", "--type", "execute", appPath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const assess = `${spctl.stdout || ""}${spctl.stderr || ""}`;
  if (spctl.status !== 0 || !assess.includes(": accepted")) {
    console.error(assess.trimEnd());
    console.error(
      "ERROR: Gatekeeper assessment failed. The app is not acceptable for distribution.\n" +
        "- Ensure you are signing with a Developer ID Application certificate.\n" +
        "- Ensure notarization completed and the ticket is stapled.\n"
    );
    process.exit(1);
  }
}

function stapleAndValidate(appPath, attempts = 8, delayMs = 15000) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      execInherit("xcrun", ["stapler", "staple", appPath]);
      execInherit("xcrun", ["stapler", "validate", appPath]);
      return;
    } catch (error) {
      if (attempt >= attempts) {
        throw error;
      }
      sleepMs(delayMs);
    }
  }
}

function createNotaryZip(appPath, zipPath) {
  execInherit("ditto", [
    "-c",
    "-k",
    "--sequesterRsrc",
    "--keepParent",
    appPath,
    zipPath,
  ]);
}

function submitNotary(zipPath, authArgs) {
  execInherit("xcrun", [
    "notarytool",
    "submit",
    zipPath,
    ...authArgs,
    "--wait",
    "--timeout",
    process.env.TEX64_NOTARY_TIMEOUT || "120m",
  ]);
}

function buildUnpackedApp(arch) {
  execInherit("npm", ["run", "-s", "dist:prep"]);
  execInherit("npm", ["run", "-s", "web:build"]);
  const builderArgs = ["--no-install", "electron-builder", "--mac", "--dir", "--publish", "never"];
  const archFlag = resolveArchFlag(arch);
  if (archFlag) {
    builderArgs.push(archFlag);
  }
  // Prevent electron-builder from performing notarization itself. This script
  // performs notarization + stapling to keep the flow deterministic.
  const builderEnv = { ...process.env };
  delete builderEnv.APPLE_KEYCHAIN_PROFILE;
  delete builderEnv.APPLE_KEYCHAIN;
  delete builderEnv.APPLE_ID;
  delete builderEnv.APPLE_APP_SPECIFIC_PASSWORD;
  delete builderEnv.APPLE_TEAM_ID;
  delete builderEnv.APPLE_API_KEY;
  delete builderEnv.APPLE_API_KEY_ID;
  delete builderEnv.APPLE_API_ISSUER;
  execInherit("npx", builderArgs, { env: builderEnv });
}

function buildArtifactsFromApp(appPath, arch, productName, version) {
  const builderEnv = {
    ...process.env,
    CSC_IDENTITY_AUTO_DISCOVERY: "false",
  };

  const archFlag = resolveArchFlag(arch);

  const zipArgs = ["--no-install", "electron-builder", "--mac", "zip"];
  if (archFlag) zipArgs.push(archFlag);
  zipArgs.push("--publish", "never", "--prepackaged", appPath);
  execInherit("npx", zipArgs, { env: builderEnv });

  // Electron-builder creates an APFS DMG on Apple Silicon by default, which does not
  // reliably render background artwork in Finder on recent macOS releases.
  // Build a HFS+ DMG stage and apply layout via dmgbuild for a consistent installer UI.
  const outDmg = path.join(path.resolve("dist"), `${productName}-${version}-mac-${arch}.dmg`);
  execInherit("node", [
    "scripts/build-macos-dmg.cjs",
    "--app",
    appPath,
    "--out",
    outDmg,
    "--volumeName",
    `${productName} ${version}`,
  ]);
}

function ensureEmptyDir(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
  fs.mkdirSync(dirPath, { recursive: true });
}

function linkOrCopy(src, dest) {
  fs.rmSync(dest, { force: true });
  try {
    fs.linkSync(src, dest);
  } catch {
    fs.copyFileSync(src, dest);
  }
}

function main() {
  requireMacOs();

  const pkg = readPackageJson();
  const version = resolveReleaseVersion(pkg);
  const productName =
    typeof pkg?.build?.productName === "string" && pkg.build.productName.trim()
      ? pkg.build.productName.trim()
      : "TeX64";

  const downloadBaseUrl = normalizeUrl(
    process.env.TEX64_DOWNLOADS_PUBLIC_BASE_URL || process.env.NEXT_PUBLIC_TEX64_DOWNLOADS_PUBLIC_BASE_URL,
    "https://downloads.tex64.com"
  );
  const notesUrl = normalizeUrl(
    process.env.TEX64_RELEASE_NOTES_URL,
    `https://tex64.com/releases/${version}`
  );

  const arch =
    typeof process.env.TEX64_RELEASE_ARCH === "string" && process.env.TEX64_RELEASE_ARCH.trim()
      ? process.env.TEX64_RELEASE_ARCH.trim()
      : process.arch === "arm64"
        ? "arm64"
        : "x64";

  if (!hasDeveloperIdIdentity() && !(process.env.CSC_LINK && process.env.CSC_KEY_PASSWORD)) {
    console.error(
      "ERROR: Developer ID Application signing identity was not found.\n" +
        "- Install a \"Developer ID Application\" certificate in your Keychain, or\n" +
        "- Set CSC_LINK (path to .p12) and CSC_KEY_PASSWORD.\n"
    );
    process.exit(1);
  }

  ensureNotarytoolAvailable();
  const notaryAuthArgs = resolveNotarytoolAuthArgs();
  if (!notaryAuthArgs) {
    console.error(
      "ERROR: Notarization credentials are missing.\n" +
        "Provide one of:\n" +
        "- APPLE_KEYCHAIN_PROFILE (recommended), or\n" +
        "- APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID, or\n" +
        "- APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER.\n"
    );
    process.exit(1);
  }

  buildUnpackedApp(arch);

  const distDir = path.resolve("dist");
  const apps = findBuiltApps(distDir, arch);
  if (apps.length === 0) {
    console.error(`ERROR: No built .app found under ${distDir} (arch=${arch})`);
    process.exit(1);
  }

  const artifacts = [];
  for (const appPath of apps) {
    const builtArch = parseBuiltArch(appPath, arch);
    verifySigned(appPath);

    const zipPath = path.join(distDir, `${productName}-${version}-mac-${builtArch}-notary.zip`);
    createNotaryZip(appPath, zipPath);
    submitNotary(zipPath, notaryAuthArgs);

    try {
      stapleAndValidate(appPath);
    } catch {
      console.error(
        "ERROR: Stapler failed after notarization.\n" +
          "Try again (sometimes Apple propagation is slow):\n" +
          `  xcrun stapler staple ${appPath}\n` +
          `  xcrun stapler validate ${appPath}\n`
      );
      process.exit(1);
    }

    verifyGatekeeper(appPath);

    buildArtifactsFromApp(appPath, builtArch, productName, version);

    const baseName = `${productName}-${version}-mac-${builtArch}`;
    const dmgPath = path.join(distDir, `${baseName}.dmg`);
    const zipPathOut = path.join(distDir, `${baseName}.zip`);

    if (!fs.existsSync(dmgPath) || !fs.existsSync(zipPathOut)) {
      console.error("ERROR: Expected dist artifacts were not created.");
      console.error(`- ${dmgPath}`);
      console.error(`- ${zipPathOut}`);
      process.exit(1);
    }

    artifacts.push({ arch: builtArch, appPath, dmgPath, zipPath: zipPathOut });
  }

  // Prepare upload bundle (no upload yet).
  ensureEmptyDir(path.resolve("release"));
  ensureEmptyDir(path.resolve("update"));

  for (const item of artifacts) {
    linkOrCopy(item.dmgPath, path.resolve("release", path.basename(item.dmgPath)));
    linkOrCopy(item.zipPath, path.resolve("release", path.basename(item.zipPath)));
  }

  execInherit("node", [
    "scripts/release-checksums.cjs",
    "--dir",
    "release",
    "--out",
    "release/checksums-sha256.txt",
    "--version",
    version,
  ]);

  execInherit("node", [
    "scripts/release-update-feed.cjs",
    "--dir",
    "release",
    "--out",
    "update/stable.json",
    "--channel",
    process.env.TEX64_UPDATE_CHANNEL || "stable",
    "--version",
    version,
    "--artifactsBaseUrl",
    `${downloadBaseUrl}/tex64/v${version}`,
    "--notesUrl",
    notesUrl,
  ]);

  console.log("OK: Signed + notarized + bundled for upload.");
  console.log("");
  console.log("Artifacts:");
  for (const item of artifacts) {
    console.log(`- ${item.dmgPath}`);
    console.log(`- ${item.zipPath}`);
  }
  console.log("");
  console.log("Bundle (upload later):");
  console.log(`- ${path.resolve("release")}`);
  console.log(`- ${path.resolve("update", "stable.json")}`);
  console.log("");
  console.log("Upload targets:");
  console.log(`- ${downloadBaseUrl}/tex64/v${version}/...`);
  console.log(`- ${downloadBaseUrl}/tex64/updates/stable.json`);
}

main();
