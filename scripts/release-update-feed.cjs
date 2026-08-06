#!/usr/bin/env node
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const {
  parsePublicUpdateArtifactKind,
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

const rootDirInput = readOption("--dir") || "release";
const outPathInput = readOption("--out") || path.join(rootDirInput, "stable.json");
const version = readOption("--version") || "";
const channel = readOption("--channel") || "stable";
const artifactsBaseUrlInput = readOption("--artifactsBaseUrl") || "";
const notesUrlInput = readOption("--notesUrl") || "";
const checksumsPathInput =
  readOption("--checksums") || path.join(rootDirInput, "checksums-sha256.txt");

const rootDir = path.resolve(process.cwd(), rootDirInput);
const outPath = path.resolve(process.cwd(), outPathInput);
const checksumsPath = path.resolve(process.cwd(), checksumsPathInput);

const normalizeBaseUrl = (value) => {
  if (typeof value !== "string" || !value.trim()) {
    return "";
  }
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
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

const sanitizeHttpUrl = (value) => {
  if (typeof value !== "string" || !value.trim()) {
    return "";
  }
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return "";
    }
    return url.toString();
  } catch {
    return "";
  }
};

const parseSha256ChecksumsText = (text) => {
  const result = {};
  if (typeof text !== "string" || !text.trim()) {
    return result;
  }
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^([a-fA-F0-9]{64})\s+(.+)$/);
    if (!match) continue;
    const digest = match[1].toLowerCase();
    const name = match[2].trim();
    if (!name) continue;
    result[name] = digest;
  }
  return result;
};

const parseKind = parsePublicUpdateArtifactKind;

const removeKnownExtension = (fileName) => {
  const kind = parseKind(fileName);
  if (!kind) return { base: fileName, kind: "" };
  if (kind === "tar.gz") {
    return { base: fileName.slice(0, -".tar.gz".length), kind };
  }
  const ext = `.${kind === "appimage" ? "AppImage" : kind}`;
  if (fileName.endsWith(ext)) {
    return { base: fileName.slice(0, -ext.length), kind };
  }
  const lowerExt = `.${kind}`;
  if (fileName.toLowerCase().endsWith(lowerExt)) {
    return { base: fileName.slice(0, -lowerExt.length), kind };
  }
  return { base: fileName, kind };
};

const normalizeArch = (value) => {
  const token = String(value || "").trim().toLowerCase();
  if (!token) return "";
  if (token === "amd64" || token === "x86_64") return "x64";
  if (token === "aarch64") return "arm64";
  return token;
};

const parsePlatformAndArch = (fileBaseName) => {
  const normalized = String(fileBaseName || "").trim();
  const lower = normalized.toLowerCase();
  const match = lower.match(/-(mac|win|linux)-([a-z0-9_]+)$/);
  if (!match) return null;
  const platformToken = match[1];
  const archToken = normalizeArch(match[2]);
  if (!archToken) return null;
  if (platformToken === "mac") return { platform: "darwin", arch: archToken };
  if (platformToken === "win") return { platform: "win32", arch: archToken };
  if (platformToken === "linux") return { platform: "linux", arch: archToken };
  return null;
};

const joinUrl = (baseUrl, fileName) => {
  if (!baseUrl || !fileName) return "";
  try {
    const base = new URL(`${baseUrl.replace(/\/+$/, "")}/`);
    const url = new URL(fileName, base);
    return url.toString();
  } catch {
    return "";
  }
};

const walkFiles = async (dirPath) => {
  const entries = await fsp.readdir(dirPath, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(fullPath)));
      continue;
    }
    if (!entry.isFile()) continue;
    files.push(fullPath);
  }
  return files;
};

const run = async () => {
  if (!version || !/^\d+\.\d+\.\d+/.test(version)) {
    console.error(`Missing or invalid --version: "${version}"`);
    process.exit(1);
  }
  const artifactsBaseUrl = normalizeBaseUrl(artifactsBaseUrlInput);
  if (!artifactsBaseUrl) {
    console.error("Missing or invalid --artifactsBaseUrl");
    process.exit(1);
  }
  const notesUrl = sanitizeHttpUrl(notesUrlInput);

  const stats = await fsp.stat(rootDir).catch(() => null);
  if (!stats || !stats.isDirectory()) {
    console.error(`Directory not found: ${rootDir}`);
    process.exit(1);
  }

  const checksumsText = await fsp.readFile(checksumsPath, "utf8").catch(() => "");
  const checksums = parseSha256ChecksumsText(checksumsText);

  const allFiles = await walkFiles(rootDir);
  const fileNames = allFiles.map((filePath) => path.basename(filePath));

  const artifacts = [];
  for (const fileName of fileNames) {
    const digest = checksums[fileName];
    if (!digest) continue;
    const { base, kind } = removeKnownExtension(fileName);
    if (!kind) continue;
    const parsed = parsePlatformAndArch(base);
    if (!parsed) continue;
    const url = joinUrl(artifactsBaseUrl, fileName);
    if (!url) continue;
    artifacts.push({
      platform: parsed.platform,
      arch: parsed.arch,
      channel,
      kind,
      url,
      sha256: `sha256:${digest}`,
    });
  }

  artifacts.sort((a, b) => {
    const keyA = `${a.platform}:${a.arch}:${a.kind}:${a.url}`;
    const keyB = `${b.platform}:${b.arch}:${b.kind}:${b.url}`;
    return keyA.localeCompare(keyB);
  });

  const payload = {
    latestVersion: version,
    channel,
    publishedAt: new Date().toISOString(),
    required: false,
    notesUrl: notesUrl || "",
    artifacts,
  };

  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  await fsp.writeFile(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  process.stdout.write(`${outPath}\n`);
};

if (require.main === module) {
  run().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  parseKind,
};
