#!/usr/bin/env node
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

if (typeof fetch !== "function") {
  console.error("ERROR: Node.js 18+ is required (global fetch is unavailable).");
  process.exit(1);
}

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

const normalizeVersion = (value) => String(value || "").trim().replace(/^v/i, "");

const readPackageVersion = () => {
  try {
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
    return normalizeVersion(pkg?.version || "");
  } catch {
    return "";
  }
};

const normalizeHttpUrl = (value) => {
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

const normalizeEndpoint = (value) => {
  if (typeof value !== "string" || !value.trim()) {
    return "";
  }
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return "";
    }
    return `${url.protocol}//${url.host}`;
  } catch {
    return "";
  }
};

const ensureAwsCliAvailable = () => {
  try {
    execFileSync("aws", ["--version"], { stdio: "ignore" });
  } catch {
    console.error("ERROR: aws CLI is required. Install with `brew install awscli`.");
    process.exit(1);
  }
};

const runAws = (baseArgs, commandArgs, env) => {
  execFileSync("aws", [...baseArgs, ...commandArgs], { stdio: "inherit", env });
};

const parseFeedJson = (feedPath) => {
  const raw = fs.readFileSync(feedPath, "utf8");
  const payload = JSON.parse(raw);
  if (!payload || typeof payload !== "object") {
    throw new Error(`Invalid feed JSON: ${feedPath}`);
  }
  return payload;
};

const findReleaseArtifacts = (releaseDir, version) => {
  const entries = fs.readdirSync(releaseDir, { withFileTypes: true });
  const artifacts = [];
  const marker = `-${version}-`;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    const lower = name.toLowerCase();
    const isTarget = lower.endsWith(".dmg") || lower.endsWith(".zip") || lower.endsWith(".exe");
    if (!isTarget) continue;
    if (!name.includes(marker)) continue;
    artifacts.push(path.join(releaseDir, name));
  }
  artifacts.sort((a, b) => a.localeCompare(b));
  return artifacts;
};

const fetchWithTimeout = async (url, options, timeoutMs) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

const fetchJson = async (url, timeoutMs) => {
  const response = await fetchWithTimeout(url, { method: "GET", redirect: "follow" }, timeoutMs);
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`GET ${url} -> ${response.status}`);
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`Invalid JSON from ${url}`);
  }
};

const normalizeArch = (value) => {
  const token = String(value || "").trim().toLowerCase();
  if (token === "amd64" || token === "x86_64") return "x64";
  if (token === "aarch64") return "arm64";
  if (token === "x64" || token === "arm64") return token;
  return "";
};

const fileNameFromUrl = (value) => {
  try {
    const url = new URL(String(value || "").trim());
    return path.basename(decodeURIComponent(url.pathname || ""));
  } catch {
    return "";
  }
};

const main = async () => {
  ensureAwsCliAvailable();

  const version = normalizeVersion(readOption("--version") || readPackageVersion());
  const channel = String(readOption("--channel") || process.env.TEX64_UPDATE_CHANNEL || "stable")
    .trim()
    .toLowerCase();
  const releaseDir = path.resolve(readOption("--releaseDir") || "release");
  const feedPath = path.resolve(readOption("--feed") || path.join("update", `${channel}.json`));
  const bucket = String(readOption("--bucket") || process.env.TEX64_DOWNLOADS_BUCKET || "").trim();
  const endpointRaw = readOption("--endpoint") || process.env.TEX64_DOWNLOADS_ENDPOINT || "";
  const endpoint = normalizeEndpoint(endpointRaw);
  const region = String(readOption("--region") || process.env.TEX64_DOWNLOADS_REGION || "auto").trim();
  const profile = String(readOption("--profile") || process.env.AWS_PROFILE || "").trim();
  const publicBaseUrl = normalizeHttpUrl(
    readOption("--publicBaseUrl") ||
      process.env.TEX64_DOWNLOADS_PUBLIC_BASE_URL ||
      process.env.NEXT_PUBLIC_TEX64_DOWNLOADS_PUBLIC_BASE_URL ||
      "https://downloads.tex64.com"
  );
  const dryRun = hasFlag("--dry-run");
  const timeoutMs = Number.parseInt(readOption("--timeoutMs") || "15000", 10);

  if (!version || !/^\d+\.\d+\.\d+/.test(version)) {
    console.error(`ERROR: Missing or invalid --version (resolved: "${version}")`);
    process.exit(1);
  }
  if (!bucket) {
    console.error("ERROR: Missing bucket (set --bucket or TEX64_DOWNLOADS_BUCKET).");
    process.exit(1);
  }
  if (!publicBaseUrl) {
    console.error("ERROR: Missing public base URL.");
    process.exit(1);
  }
  if (endpointRaw && !endpoint) {
    console.error(`ERROR: Invalid endpoint: ${endpointRaw}`);
    process.exit(1);
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) {
    console.error(`ERROR: Invalid --timeoutMs: ${timeoutMs}`);
    process.exit(1);
  }
  if (!fs.existsSync(releaseDir) || !fs.statSync(releaseDir).isDirectory()) {
    console.error(`ERROR: release dir not found: ${releaseDir}`);
    process.exit(1);
  }
  if (!fs.existsSync(feedPath) || !fs.statSync(feedPath).isFile()) {
    console.error(`ERROR: update feed not found: ${feedPath}`);
    process.exit(1);
  }

  const artifacts = findReleaseArtifacts(releaseDir, version);
  if (artifacts.length === 0) {
    console.error(`ERROR: No .dmg/.zip/.exe artifacts found in ${releaseDir} for version ${version}`);
    process.exit(1);
  }

  const checksumPath = path.join(releaseDir, "checksums-sha256.txt");
  if (!fs.existsSync(checksumPath) || !fs.statSync(checksumPath).isFile()) {
    console.error(`ERROR: checksums file is missing: ${checksumPath}`);
    process.exit(1);
  }

  let feed = null;
  try {
    feed = parseFeedJson(feedPath);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

  if (String(feed.latestVersion || "") !== version) {
    console.error(
      `ERROR: ${feedPath} latestVersion mismatch (expected ${version}, got ${String(
        feed.latestVersion || ""
      )})`
    );
    process.exit(1);
  }

  if (String(feed.channel || "").trim().toLowerCase() !== channel) {
    console.error(
      `ERROR: ${feedPath} channel mismatch (expected ${channel}, got ${String(feed.channel || "")})`
    );
    process.exit(1);
  }

  const feedArtifacts = Array.isArray(feed.artifacts) ? feed.artifacts : [];
  if (feedArtifacts.length === 0) {
    console.error(`ERROR: ${feedPath} has no artifacts.`);
    process.exit(1);
  }

  const hasDarwinDmg = feedArtifacts.some((item) => {
    const platform = String(item?.platform || "").trim().toLowerCase();
    const normalizedArch = normalizeArch(item?.arch);
    const kind = String(item?.kind || "").trim().toLowerCase();
    return platform === "darwin" && !!normalizedArch && kind === "dmg";
  });
  if (!hasDarwinDmg) {
    console.error(`ERROR: ${feedPath} has no darwin/dmg artifact.`);
    process.exit(1);
  }

  const hasWinExe = feedArtifacts.some((item) => {
    const platform = String(item?.platform || "").trim().toLowerCase();
    const normalizedArch = normalizeArch(item?.arch);
    const kind = String(item?.kind || "").trim().toLowerCase();
    return platform === "win32" && !!normalizedArch && kind === "exe";
  });
  if (!hasWinExe) {
    console.error(`ERROR: ${feedPath} has no win32/exe artifact.`);
    process.exit(1);
  }

  const releaseFileNames = new Set([
    ...artifacts.map((artifactPath) => path.basename(artifactPath)),
    "checksums-sha256.txt",
  ]);
  for (const item of feedArtifacts) {
    const urlFileName = fileNameFromUrl(item?.url || "");
    if (!urlFileName) continue;
    if (!releaseFileNames.has(urlFileName)) {
      console.error(
        `ERROR: ${feedPath} references "${urlFileName}" but it does not exist in ${releaseDir}`
      );
      process.exit(1);
    }
  }

  const awsEnv = {
    ...process.env,
    AWS_EC2_METADATA_DISABLED: "true",
    AWS_S3_FORCE_PATH_STYLE: "true",
    AWS_REGION: region || "auto",
    AWS_DEFAULT_REGION: region || "auto",
  };
  if (!awsEnv.AWS_ACCESS_KEY_ID && process.env.TEX64_DOWNLOADS_ACCESS_KEY_ID) {
    awsEnv.AWS_ACCESS_KEY_ID = process.env.TEX64_DOWNLOADS_ACCESS_KEY_ID;
  }
  if (!awsEnv.AWS_SECRET_ACCESS_KEY && process.env.TEX64_DOWNLOADS_SECRET_ACCESS_KEY) {
    awsEnv.AWS_SECRET_ACCESS_KEY = process.env.TEX64_DOWNLOADS_SECRET_ACCESS_KEY;
  }
  if (!awsEnv.AWS_SESSION_TOKEN && process.env.TEX64_DOWNLOADS_SESSION_TOKEN) {
    awsEnv.AWS_SESSION_TOKEN = process.env.TEX64_DOWNLOADS_SESSION_TOKEN;
  }

  const awsBaseArgs = [];
  if (profile) {
    awsBaseArgs.push("--profile", profile);
  }
  if (endpoint) {
    awsBaseArgs.push("--endpoint-url", endpoint);
  }

  console.log(`Version: ${version}`);
  console.log(`Channel: ${channel}`);
  console.log(`Bucket: ${bucket}`);
  if (endpoint) {
    console.log(`Endpoint: ${endpoint}`);
    if (endpointRaw && endpointRaw.trim() !== endpoint) {
      console.log(`Endpoint normalized from: ${endpointRaw}`);
    }
  } else {
    console.log("Endpoint: default (AWS S3)");
  }
  console.log(`Release dir: ${releaseDir}`);
  console.log(`Feed: ${feedPath}`);
  console.log(`Public base URL: ${publicBaseUrl}`);
  if (dryRun) {
    console.log("Mode: dry-run");
  }
  console.log("");

  const syncArgs = [
    "s3",
    "sync",
    releaseDir,
    `s3://${bucket}/tex64/v${version}/`,
    "--cache-control",
    "public,max-age=31536000,immutable",
  ];
  if (dryRun) {
    syncArgs.push("--dryrun");
  }
  runAws(awsBaseArgs, syncArgs, awsEnv);

  const cpArgs = [
    "s3",
    "cp",
    feedPath,
    `s3://${bucket}/tex64/updates/${channel}.json`,
    "--cache-control",
    "public,max-age=60",
    "--content-type",
    "application/json",
  ];
  if (dryRun) {
    cpArgs.push("--dryrun");
  }
  runAws(awsBaseArgs, cpArgs, awsEnv);

  if (dryRun) {
    console.log("");
    console.log("Dry-run complete.");
    process.exit(0);
  }

  const stableUrl = `${publicBaseUrl}/tex64/updates/${encodeURIComponent(channel)}.json`;
  const stable = await fetchJson(stableUrl, timeoutMs).catch((error) => {
    console.error(`ERROR: failed to fetch uploaded feed (${stableUrl}): ${error.message}`);
    process.exit(1);
  });

  if (String(stable.latestVersion || "") !== version) {
    console.error(
      `ERROR: Uploaded feed latestVersion mismatch (expected ${version}, got ${String(
        stable.latestVersion || ""
      )})`
    );
    process.exit(1);
  }

  console.log("");
  console.log("Upload complete.");
  console.log(`- ${publicBaseUrl}/tex64/v${version}/...`);
  console.log(`- ${stableUrl}`);
  console.log("");
  console.log("Next step:");
  console.log(`npm run -s release:go-no-go -- --version ${version} --channel ${channel}`);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
