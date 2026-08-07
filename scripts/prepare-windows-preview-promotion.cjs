#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const WARNING_START = "<!-- tex64-windows-unsigned-preview-warning:start -->";
const WARNING_END = "<!-- tex64-windows-unsigned-preview-warning:end -->";

const args = process.argv.slice(2);

const readOption = (name) => {
  const index = args.indexOf(name);
  if (index < 0) return "";
  const value = args[index + 1];
  if (!value || value.startsWith("--")) return "";
  return value;
};

const normalizeVersion = (value) => String(value || "").trim().replace(/^v/u, "");

const assertVersion = (value) => {
  const version = normalizeVersion(value);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error(`Invalid version: ${JSON.stringify(value)}`);
  }
  return version;
};

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const expectedArtifactPattern = (version) =>
  new RegExp(
    `^TeX64-${escapeRegExp(version)}-(?:unsigned-preview-)?win-x64\\.exe$`,
    "u"
  );

const sha256File = async (filePath) => {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(filePath);
  await new Promise((resolve, reject) => {
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
};

const readPeSecurityDirectory = (buffer) => {
  if (buffer.length < 512 || buffer.toString("ascii", 0, 2) !== "MZ") {
    throw new Error("Installer is not a valid PE executable (missing MZ header)");
  }
  const peOffset = buffer.readUInt32LE(0x3c);
  if (
    peOffset < 0x40 ||
    peOffset + 24 > buffer.length ||
    buffer.toString("ascii", peOffset, peOffset + 4) !== "PE\0\0"
  ) {
    throw new Error("Installer is not a valid PE executable (missing PE header)");
  }

  const optionalHeaderSize = buffer.readUInt16LE(peOffset + 20);
  const optionalOffset = peOffset + 24;
  if (optionalOffset + optionalHeaderSize > buffer.length) {
    throw new Error("Installer has a truncated PE optional header");
  }

  const magic = buffer.readUInt16LE(optionalOffset);
  const dataDirectoryOffset =
    magic === 0x10b ? optionalOffset + 96 : magic === 0x20b ? optionalOffset + 112 : 0;
  const numberOfDirectoriesOffset =
    magic === 0x10b ? optionalOffset + 92 : magic === 0x20b ? optionalOffset + 108 : 0;
  if (!dataDirectoryOffset || numberOfDirectoriesOffset + 4 > buffer.length) {
    throw new Error(`Unsupported PE optional-header magic: 0x${magic.toString(16)}`);
  }
  if (buffer.readUInt32LE(numberOfDirectoriesOffset) < 5) {
    return { address: 0, size: 0 };
  }

  const securityDirectoryOffset = dataDirectoryOffset + 4 * 8;
  if (
    securityDirectoryOffset + 8 > optionalOffset + optionalHeaderSize ||
    securityDirectoryOffset + 8 > buffer.length
  ) {
    throw new Error("Installer has a truncated PE security directory");
  }
  return {
    address: buffer.readUInt32LE(securityDirectoryOffset),
    size: buffer.readUInt32LE(securityDirectoryOffset + 4),
  };
};

const validateWindowsArtifact = async ({ artifactPath, version, minimumBytes = 1024 * 1024 }) => {
  const normalizedVersion = assertVersion(version);
  const fileName = path.basename(artifactPath);
  if (!expectedArtifactPattern(normalizedVersion).test(fileName)) {
    throw new Error(
      `Unexpected installer name: ${fileName}; expected TeX64-${normalizedVersion}-[unsigned-preview-]win-x64.exe`
    );
  }

  const stats = await fsp.stat(artifactPath).catch(() => null);
  if (!stats || !stats.isFile() || stats.size < minimumBytes) {
    throw new Error(`Installer is missing or unexpectedly small: ${artifactPath}`);
  }

  const handle = await fsp.open(artifactPath, "r");
  let header;
  try {
    header = Buffer.alloc(Math.min(stats.size, 4096));
    await handle.read(header, 0, header.length, 0);
  } finally {
    await handle.close();
  }
  const securityDirectory = readPeSecurityDirectory(header);
  if (securityDirectory.address !== 0 || securityDirectory.size !== 0) {
    throw new Error(
      `Installer contains an Authenticode certificate table (${securityDirectory.size} bytes); this workflow only promotes explicitly unsigned previews`
    );
  }

  return {
    fileName,
    size: stats.size,
    sha256: await sha256File(artifactPath),
    signature: "unsigned",
    version: normalizedVersion,
  };
};

const parseChecksums = (text) => {
  const entries = [];
  for (const rawLine of String(text || "").split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^([a-fA-F0-9]{64})\s{2,}(.+)$/u);
    if (!match) throw new Error(`Malformed checksum line: ${rawLine}`);
    entries.push({ sha256: match[1].toLowerCase(), fileName: match[2].trim() });
  }
  return entries;
};

const mergeChecksums = ({ existingText, metadata }) => {
  const windowsPattern = expectedArtifactPattern(metadata.version);
  const preserved = parseChecksums(existingText).filter(
    (entry) => !windowsPattern.test(entry.fileName)
  );
  if (!preserved.some((entry) => /-mac-(?:arm64|x64)\.(?:dmg|zip)$/u.test(entry.fileName))) {
    throw new Error("Existing release checksum file has no macOS artifacts to preserve");
  }
  preserved.push({ sha256: metadata.sha256, fileName: metadata.fileName });
  return `${preserved.map((entry) => `${entry.sha256}  ${entry.fileName}`).join("\n")}\n`;
};

const normalizeArch = (value) => {
  const token = String(value || "").trim().toLowerCase();
  if (token === "amd64" || token === "x86_64") return "x64";
  if (token === "aarch64") return "arm64";
  return token;
};

const isTargetWindowsArtifact = (artifact) =>
  String(artifact?.platform || "").trim().toLowerCase() === "win32" &&
  normalizeArch(artifact?.arch) === "x64" &&
  String(artifact?.kind || "").trim().toLowerCase() === "exe";

const mergeStableFeed = ({ existingFeed, metadata, artifactUrl }) => {
  if (!existingFeed || typeof existingFeed !== "object" || Array.isArray(existingFeed)) {
    throw new Error("Existing stable feed is not an object");
  }
  if (String(existingFeed.latestVersion || "") !== metadata.version) {
    throw new Error(
      `Stable feed version mismatch: expected ${metadata.version}, got ${String(
        existingFeed.latestVersion || ""
      )}`
    );
  }
  if (String(existingFeed.channel || "").trim().toLowerCase() !== "stable") {
    throw new Error("Existing update feed is not the stable channel");
  }
  if (!Array.isArray(existingFeed.artifacts)) {
    throw new Error("Existing stable feed has no artifacts array");
  }

  const preserved = existingFeed.artifacts.filter((artifact) => !isTargetWindowsArtifact(artifact));
  const macArtifactsBefore = existingFeed.artifacts.filter(
    (artifact) => String(artifact?.platform || "").trim().toLowerCase() === "darwin"
  );
  const macArtifactsAfter = preserved.filter(
    (artifact) => String(artifact?.platform || "").trim().toLowerCase() === "darwin"
  );
  if (macArtifactsBefore.length === 0 || JSON.stringify(macArtifactsAfter) !== JSON.stringify(macArtifactsBefore)) {
    throw new Error("Refusing to publish a stable feed that does not preserve macOS artifacts");
  }

  let url;
  try {
    url = new URL(artifactUrl);
  } catch {
    throw new Error(`Invalid Windows artifact URL: ${artifactUrl}`);
  }
  if (url.protocol !== "https:") {
    throw new Error("Windows artifact URL must use HTTPS");
  }

  const windowsArtifact = {
    platform: "win32",
    arch: "x64",
    channel: "stable",
    kind: "exe",
    url: url.toString(),
    sha256: `sha256:${metadata.sha256}`,
  };
  const artifacts = [...preserved, windowsArtifact].sort((left, right) => {
    const leftKey = `${left.platform}:${left.arch}:${left.kind}:${left.url}`;
    const rightKey = `${right.platform}:${right.arch}:${right.kind}:${right.url}`;
    return leftKey.localeCompare(rightKey);
  });
  return {
    ...existingFeed,
    latestVersion: metadata.version,
    channel: "stable",
    publishedAt: new Date().toISOString(),
    artifacts,
  };
};

const mergeReleaseNotes = ({ existingText, metadata }) => {
  const warning = [
    WARNING_START,
    "> [!WARNING]",
    "> **Windows is an unsigned preview.** The installer is not code-signed, so Microsoft Defender SmartScreen may warn or block it. Verify the SHA-256 against `checksums-sha256.txt` before running it.",
    `> File: \`${metadata.fileName}\`  `,
    `> SHA-256: \`${metadata.sha256}\``,
    WARNING_END,
  ].join("\n");
  const body = String(existingText || "").trim();
  const markedBlock = new RegExp(
    `${escapeRegExp(WARNING_START)}[\\s\\S]*?${escapeRegExp(WARNING_END)}`,
    "u"
  );
  if (markedBlock.test(body)) {
    return `${body.replace(markedBlock, warning).trim()}\n`;
  }
  return `${warning}${body ? `\n\n${body}` : ""}\n`;
};

const run = async () => {
  const artifactPathInput = readOption("--artifact");
  const version = readOption("--version");
  const checksumsInInput = readOption("--checksums-in");
  const checksumsOutInput = readOption("--checksums-out");
  const feedInInput = readOption("--feed-in");
  const feedOutInput = readOption("--feed-out");
  const notesInInput = readOption("--notes-in");
  const notesOutInput = readOption("--notes-out");
  const metadataOutInput = readOption("--metadata-out");
  const artifactUrl = readOption("--artifact-url");

  const required = {
    artifactPathInput,
    version,
    checksumsInInput,
    checksumsOutInput,
    feedInInput,
    feedOutInput,
    notesInInput,
    notesOutInput,
    metadataOutInput,
    artifactUrl,
  };
  for (const [name, value] of Object.entries(required)) {
    if (!value) throw new Error(`Missing required option: ${name}`);
  }

  const artifactPath = path.resolve(artifactPathInput);
  const checksumsIn = path.resolve(checksumsInInput);
  const checksumsOut = path.resolve(checksumsOutInput);
  const feedIn = path.resolve(feedInInput);
  const feedOut = path.resolve(feedOutInput);
  const notesIn = path.resolve(notesInInput);
  const notesOut = path.resolve(notesOutInput);
  const metadataOut = path.resolve(metadataOutInput);

  const metadata = await validateWindowsArtifact({ artifactPath, version });
  const checksumsText = await fsp.readFile(checksumsIn, "utf8");
  const existingFeed = JSON.parse(await fsp.readFile(feedIn, "utf8"));
  const existingNotes = await fsp.readFile(notesIn, "utf8");
  const checksums = mergeChecksums({ existingText: checksumsText, metadata });
  const stableFeed = mergeStableFeed({ existingFeed, metadata, artifactUrl });
  const releaseNotes = mergeReleaseNotes({ existingText: existingNotes, metadata });

  await Promise.all([
    fsp.mkdir(path.dirname(checksumsOut), { recursive: true }),
    fsp.mkdir(path.dirname(feedOut), { recursive: true }),
    fsp.mkdir(path.dirname(notesOut), { recursive: true }),
    fsp.mkdir(path.dirname(metadataOut), { recursive: true }),
  ]);
  await Promise.all([
    fsp.writeFile(checksumsOut, checksums, "utf8"),
    fsp.writeFile(feedOut, `${JSON.stringify(stableFeed, null, 2)}\n`, "utf8"),
    fsp.writeFile(notesOut, releaseNotes, "utf8"),
    fsp.writeFile(metadataOut, `${JSON.stringify(metadata, null, 2)}\n`, "utf8"),
  ]);
  process.stdout.write(`${JSON.stringify(metadata)}\n`);
};

if (require.main === module) {
  run().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  });
}

module.exports = {
  WARNING_END,
  WARNING_START,
  expectedArtifactPattern,
  mergeChecksums,
  mergeReleaseNotes,
  mergeStableFeed,
  readPeSecurityDirectory,
  validateWindowsArtifact,
};
