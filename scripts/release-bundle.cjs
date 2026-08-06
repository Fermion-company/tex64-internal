#!/usr/bin/env node
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const {
  isMicrosoftStoreArtifact,
} = require("./release-artifact-policy.cjs");

const args = process.argv.slice(2);

const readOption = (name) => {
  const index = args.indexOf(name);
  if (index < 0) {
    return null;
  }
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    return null;
  }
  return value;
};

const hasFlag = (name) => args.includes(name);

const isEnvTrue = (value) => /^(1|true|yes|on)$/i.test(String(value || "").trim());

const isStorePublicationRequested = (argv = args, env = process.env) =>
  argv.includes("--include-windows-store") ||
  isEnvTrue(env.TEX64_INCLUDE_WINDOWS_STORE);

const normalizeUrl = (value) => {
  if (typeof value !== "string" || !value.trim()) {
    return "";
  }
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return "";
    }
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
};

const execInherit = (command, commandArgs, options = {}) => {
  execFileSync(command, commandArgs, { stdio: "inherit", ...options });
};

const ensureEmptyDir = async (dirPath) => {
  await fsp.rm(dirPath, { recursive: true, force: true }).catch(() => {});
  await fsp.mkdir(dirPath, { recursive: true });
};

const copyFile = async (src, dest) => {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.copyFile(src, dest);
};

const resolveReleaseVersion = () => {
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const version =
    typeof pkg?.version === "string" && pkg.version.trim() ? pkg.version.trim() : "";
  if (!version || !/^\d+\.\d+\.\d+/.test(version)) {
    console.error(`ERROR: Invalid version in package.json: "${version}"`);
    process.exit(1);
  }
  return version;
};

const resolveArtifacts = async (distDir, version, options = {}) => {
  const entries = await fsp.readdir(distDir, { withFileTypes: true }).catch(() => []);
  const artifacts = [];
  const excludedWindows = [];
  const storeArtifacts = [];
  const include = (name) => {
    if (typeof name !== "string" || !name) {
      return false;
    }
    if (!name.includes(`-${version}-`)) {
      return false;
    }
    const lower = name.toLowerCase();
    if (lower.endsWith(".dmg")) {
      return true;
    }
    if (lower.endsWith(".zip")) {
      // Notary submission zips are artifacts for Apple notarization, not for end users.
      // Keep them in dist/ but exclude from the public release bundle.
      return !lower.endsWith("-notary.zip");
    }
    if (isMicrosoftStoreArtifact(name)) {
      storeArtifacts.push(name);
      return false;
    }
    if (lower.endsWith(".exe") || lower.endsWith(".msi")) {
      if (!options.includeWindowsDirect) {
        excludedWindows.push(name);
        return false;
      }
      return true;
    }
    return false;
  };
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!include(entry.name)) continue;
    artifacts.push(path.join(distDir, entry.name));
  }
  artifacts.sort((a, b) => a.localeCompare(b));
  excludedWindows.sort((a, b) => a.localeCompare(b));
  storeArtifacts.sort((a, b) => a.localeCompare(b));
  return { artifacts, excludedWindows, storeArtifacts };
};

const main = async () => {
  const version = readOption("--version") || resolveReleaseVersion();
  const distDir = path.resolve(readOption("--dist") || "dist");

  const downloadsBaseUrl = normalizeUrl(
    process.env.TEX64_DOWNLOADS_PUBLIC_BASE_URL ||
      process.env.NEXT_PUBLIC_TEX64_DOWNLOADS_PUBLIC_BASE_URL ||
      "https://downloads.tex64.com"
  );
  const notesUrl = normalizeUrl(
    process.env.TEX64_RELEASE_NOTES_URL || `https://tex64.com/releases/${version}`
  );
  if (isStorePublicationRequested()) {
    throw new Error(
      "Microsoft Store artifacts cannot be added to the public release bundle. " +
        "Publish the Store package through the dedicated Partner Center workflow."
    );
  }
  const includeWindowsDirect =
    hasFlag("--include-windows-direct") || isEnvTrue(process.env.TEX64_INCLUDE_WINDOWS_DIRECT);

  const { artifacts, excludedWindows, storeArtifacts } = await resolveArtifacts(distDir, version, {
    includeWindowsDirect,
  });
  if (storeArtifacts.length > 0) {
    console.log("Microsoft Store artifacts isolated from the public release bundle:");
    for (const name of storeArtifacts) {
      console.log(`- ${name}`);
    }
    console.log("Submit these only through the dedicated Partner Center workflow.");
  }
  if (excludedWindows.length > 0) {
    console.log("Direct Windows artifacts excluded from the public release bundle by default:");
    for (const name of excludedWindows) {
      console.log(`- ${name}`);
    }
    console.log("Use --include-windows-direct for EXE/MSI direct publication.");
  }
  if (artifacts.length === 0) {
    console.error(`ERROR: No selected release artifacts found in ${distDir} for version ${version}.`);
    console.error(`Run a platform build first, or opt in to a Windows publication mode.`);
    process.exit(1);
  }

  const releaseDir = path.resolve("release");
  const updateDir = path.resolve("update");
  await ensureEmptyDir(releaseDir);
  await ensureEmptyDir(updateDir);

  for (const artifactPath of artifacts) {
    await copyFile(artifactPath, path.join(releaseDir, path.basename(artifactPath)));
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
    `${downloadsBaseUrl}/tex64/v${version}`,
    "--notesUrl",
    notesUrl,
  ]);

  console.log("");
  console.log("OK: Release bundle prepared.");
  console.log(`- ${path.join(releaseDir, "checksums-sha256.txt")}`);
  console.log(`- ${path.join(updateDir, "stable.json")}`);
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  isStorePublicationRequested,
  resolveArtifacts,
};
