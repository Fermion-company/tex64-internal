#!/usr/bin/env node
const fs = require("node:fs");

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

const sanitizeHttpUrl = (value) => {
  if (typeof value !== "string" || !value.trim()) {
    return "";
  }
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return "";
    }
    return url.toString();
  } catch {
    return "";
  }
};

const normalizeComparableUrl = (value) => {
  const normalized = normalizeUrl(value);
  if (!normalized) {
    return "";
  }
  try {
    const url = new URL(normalized);
    url.hash = "";
    url.search = "";
    return url.toString();
  } catch {
    return "";
  }
};

const normalizeVersion = (value) => String(value || "").trim().replace(/^v/i, "");

const normalizeArch = (value) => {
  const token = String(value || "").trim().toLowerCase();
  if (token === "amd64" || token === "x86_64") return "x64";
  if (token === "aarch64") return "arm64";
  if (token === "x64" || token === "arm64") return token;
  return "";
};

const parseArchList = (value) => {
  const items = String(value || "")
    .split(",")
    .map((item) => normalizeArch(item))
    .filter(Boolean);
  return [...new Set(items)];
};

const normalizeSha256 = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const lower = raw.toLowerCase();
  if (/^[a-f0-9]{64}$/.test(lower)) {
    return lower;
  }
  const withPrefix = lower.match(/^sha256:([a-f0-9]{64})$/);
  if (withPrefix) {
    return withPrefix[1];
  }
  const base64Match = raw.match(/^sha256-([A-Za-z0-9+/=]+)$/);
  if (base64Match) {
    try {
      const bytes = Buffer.from(base64Match[1], "base64");
      if (bytes.length === 32) {
        return bytes.toString("hex");
      }
    } catch {
      return "";
    }
  }
  return "";
};

const readPackageVersion = () => {
  try {
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
    return normalizeVersion(pkg?.version || "");
  } catch {
    return "";
  }
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

const checkUrlReachable = async (url, timeoutMs) => {
  let response = null;
  try {
    response = await fetchWithTimeout(
      url,
      { method: "HEAD", redirect: "follow", headers: { "cache-control": "no-cache" } },
      timeoutMs
    );
    if (response.ok) {
      return { ok: true, status: response.status };
    }
  } catch {}
  try {
    response = await fetchWithTimeout(
      url,
      {
        method: "GET",
        redirect: "follow",
        headers: { Range: "bytes=0-0", "cache-control": "no-cache" },
      },
      timeoutMs
    );
    if (response.ok || response.status === 206) {
      return { ok: true, status: response.status };
    }
    return { ok: false, status: response.status };
  } catch {
    return { ok: false, status: response ? response.status : 0 };
  }
};

const fetchRedirectLocation = async (url, timeoutMs) => {
  const response = await fetchWithTimeout(
    url,
    { method: "GET", redirect: "manual", headers: { "cache-control": "no-cache" } },
    timeoutMs
  );
  const locationRaw = response.headers.get("location") || "";
  const location = locationRaw ? new URL(locationRaw, url).toString() : "";
  return { status: response.status, location };
};

const ensureArtifactMap = (stable, platformFilter, archs, kindFilter = "") => {
  const result = new Map();
  const artifacts = Array.isArray(stable?.artifacts) ? stable.artifacts : [];
  for (const artifact of artifacts) {
    const platform = String(artifact?.platform || "").trim().toLowerCase();
    const arch = normalizeArch(artifact?.arch);
    const kind = String(artifact?.kind || "").trim().toLowerCase();
    const url = normalizeUrl(artifact?.url || "");
    const shaHex = normalizeSha256(artifact?.sha256 || "");
    if (platform !== platformFilter || !arch || !url || !shaHex) continue;
    if (kindFilter && kind !== kindFilter) continue;
    if (!archs.includes(arch)) continue;
    if (!result.has(arch)) {
      result.set(arch, { url, shaHex });
    }
  }
  return result;
};

const fetchResolvedUrl = async (url, timeoutMs) => {
  let response = null;
  try {
    response = await fetchWithTimeout(
      url,
      { method: "HEAD", redirect: "follow", headers: { "cache-control": "no-cache" } },
      timeoutMs
    );
    if (response.ok) {
      return { ok: true, status: response.status, url: response.url || url };
    }
  } catch {}
  try {
    response = await fetchWithTimeout(
      url,
      {
        method: "GET",
        redirect: "follow",
        headers: { Range: "bytes=0-0", "cache-control": "no-cache" },
      },
      timeoutMs
    );
    if (response.ok || response.status === 206) {
      return { ok: true, status: response.status, url: response.url || url };
    }
    return { ok: false, status: response.status, url: response.url || url };
  } catch {
    return { ok: false, status: response ? response.status : 0, url };
  }
};

const printPass = (message) => process.stdout.write(`PASS: ${message}\n`);
const printFail = (message) => process.stderr.write(`FAIL: ${message}\n`);
const printWarn = (message) => process.stderr.write(`WARN: ${message}\n`);

const main = async () => {
  const version = normalizeVersion(readOption("--version") || readPackageVersion());
  const channel = String(readOption("--channel") || process.env.TEX64_UPDATE_CHANNEL || "stable")
    .trim()
    .toLowerCase();
  const downloadsBaseUrl = normalizeUrl(
    readOption("--downloadsBaseUrl") ||
      process.env.TEX64_DOWNLOADS_PUBLIC_BASE_URL ||
      process.env.NEXT_PUBLIC_TEX64_DOWNLOADS_PUBLIC_BASE_URL ||
      "https://downloads.tex64.com"
  );
  const siteBaseUrl = normalizeUrl(
    readOption("--siteBaseUrl") || process.env.TEX64_SITE_BASE_URL || "https://tex64.com"
  );
  const timeoutMs = Number.parseInt(readOption("--timeoutMs") || "15000", 10);
  const archs = parseArchList(readOption("--archs") || "arm64,x64");
  const winArchs = parseArchList(readOption("--winArchs") || "x64");

  if (!version || !/^\d+\.\d+\.\d+/.test(version)) {
    console.error(`ERROR: Missing or invalid --version (resolved: "${version}")`);
    process.exit(1);
  }
  if (!downloadsBaseUrl) {
    console.error("ERROR: Missing or invalid downloads base URL.");
    process.exit(1);
  }
  if (!siteBaseUrl) {
    console.error("ERROR: Missing or invalid site base URL.");
    process.exit(1);
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) {
    console.error(`ERROR: Invalid --timeoutMs: ${timeoutMs}`);
    process.exit(1);
  }
  if (archs.length === 0) {
    console.error("ERROR: Missing valid --archs (expected arm64/x64).");
    process.exit(1);
  }

  process.stdout.write(`Version: ${version}\n`);
  process.stdout.write(`Channel: ${channel}\n`);
  process.stdout.write(`Downloads: ${downloadsBaseUrl}\n`);
  process.stdout.write(`Site: ${siteBaseUrl}\n`);
  process.stdout.write(`macOS Architectures: ${archs.join(", ")}\n`);
  process.stdout.write(`Windows Architectures: ${winArchs.join(", ")}\n`);
  process.stdout.write("\n");

  const failures = [];
  const warnings = [];

  const stableUrl = `${downloadsBaseUrl}/tex64/updates/${encodeURIComponent(channel)}.json`;
  const stable = await fetchJson(stableUrl, timeoutMs).catch((error) => {
    failures.push(`Failed to fetch update feed: ${error.message}`);
    return null;
  });
  if (!stable) {
    for (const message of failures) printFail(message);
    process.exit(1);
  }
  printPass(`Fetched update feed: ${stableUrl}`);

  if (String(stable.latestVersion || "") !== version) {
    failures.push(
      `Update feed latestVersion mismatch (expected ${version}, got ${String(stable.latestVersion || "")})`
    );
  } else {
    printPass(`Update feed latestVersion is ${version}`);
  }

  if (String(stable.channel || "").trim().toLowerCase() !== channel) {
    warnings.push(
      `Update feed channel mismatch (expected ${channel}, got ${String(stable.channel || "")})`
    );
  } else {
    printPass(`Update feed channel is ${channel}`);
  }

  const artifacts = Array.isArray(stable.artifacts) ? stable.artifacts : [];
  if (artifacts.length === 0) {
    failures.push("Update feed has no artifacts.");
  } else {
    printPass(`Update feed exposes ${artifacts.length} artifact(s)`);
  }

  for (const artifact of artifacts) {
    const url = normalizeUrl(artifact?.url || "");
    const shaHex = normalizeSha256(artifact?.sha256 || "");
    const platform = String(artifact?.platform || "").trim().toLowerCase();
    const arch = normalizeArch(artifact?.arch);
    const kind = String(artifact?.kind || "").trim().toLowerCase();
    const label = `${platform || "?"}/${arch || "?"}/${kind || "?"}`;

    if (!url) {
      failures.push(`Artifact ${label} has invalid url.`);
      continue;
    }
    if (!shaHex) {
      failures.push(`Artifact ${label} has invalid sha256.`);
      continue;
    }

    const reachability = await checkUrlReachable(url, timeoutMs);
    if (!reachability.ok) {
      failures.push(`Artifact ${label} is not reachable (${url}).`);
      continue;
    }
    printPass(`Artifact ${label} reachable (${reachability.status})`);
  }

  const notesUrl = normalizeUrl(stable.notesUrl || "");
  if (notesUrl) {
    const notesReachability = await checkUrlReachable(notesUrl, timeoutMs);
    if (!notesReachability.ok) {
      failures.push(`notesUrl is not reachable (${notesUrl}).`);
    } else {
      printPass(`notesUrl reachable (${notesReachability.status})`);
    }
  } else {
    warnings.push("notesUrl is empty in update feed.");
  }

  const verifyPlatformManifests = async (updatePlatform, platformArchs, updateKind) => {
    const stableByArch = ensureArtifactMap(stable, updatePlatform, platformArchs, updateKind);
    for (const arch of platformArchs) {
      const label = `${updatePlatform}/${arch}/${updateKind}`;
      const expected = stableByArch.get(arch);
      if (!expected) {
        failures.push(`Update feed is missing ${label} artifact.`);
        continue;
      }

      const manifestUrl =
        `${siteBaseUrl}/api/v2/updates/manifest?platform=${encodeURIComponent(updatePlatform)}` +
        `&arch=${encodeURIComponent(arch)}` +
        `&channel=${encodeURIComponent(channel)}` +
        `&kind=${encodeURIComponent(updateKind)}`;
      const manifest = await fetchJson(manifestUrl, timeoutMs).catch((error) => {
        failures.push(`Failed to fetch manifest for ${label}: ${error.message}`);
        return null;
      });
      if (!manifest) {
        continue;
      }
      printPass(`Fetched manifest for ${label}`);

      if (String(manifest.latestVersion || "") !== version) {
        failures.push(
          `Manifest latestVersion mismatch for ${label} (expected ${version}, got ${String(
            manifest.latestVersion || ""
          )})`
        );
      } else {
        printPass(`Manifest latestVersion matches for ${label}`);
      }

      const manifestArtifactUrl = sanitizeHttpUrl(manifest.artifactUrl || "");
      const manifestShaHex = normalizeSha256(manifest.artifactSha256 || manifest.sha256 || "");
      if (!manifestArtifactUrl) {
        failures.push(`Manifest artifactUrl is invalid for ${label}.`);
      } else {
        const expectedComparable = normalizeComparableUrl(expected.url);
        if (normalizeComparableUrl(manifestArtifactUrl) === expectedComparable) {
          printPass(`Manifest artifactUrl matches update feed for ${label}`);
        } else {
          const resolvedArtifact = await fetchResolvedUrl(manifestArtifactUrl, timeoutMs).catch((error) => {
            failures.push(`Failed to resolve manifest artifactUrl for ${label}: ${error.message}`);
            return null;
          });
          if (!resolvedArtifact?.ok) {
            failures.push(`Manifest artifactUrl is not reachable for ${label}.`);
          } else if (normalizeComparableUrl(resolvedArtifact.url) !== expectedComparable) {
            failures.push(`Manifest artifactUrl mismatch for ${label}.`);
          } else {
            printPass(`Manifest artifactUrl resolves to update feed artifact for ${label}`);
          }
        }
      }
      if (!manifestShaHex) {
        failures.push(`Manifest artifactSha256 is invalid for ${label}.`);
      } else if (manifestShaHex !== expected.shaHex) {
        failures.push(`Manifest artifactSha256 mismatch for ${label}.`);
      } else {
        printPass(`Manifest artifactSha256 matches update feed for ${label}`);
      }

      if (notesUrl) {
        const manifestNotesUrl = normalizeUrl(manifest.notesUrl || "");
        if (!manifestNotesUrl) {
          warnings.push(`Manifest notesUrl is empty for ${label}.`);
        } else if (normalizeComparableUrl(manifestNotesUrl) !== normalizeComparableUrl(notesUrl)) {
          warnings.push(`Manifest notesUrl differs for ${label}.`);
        } else {
          printPass(`Manifest notesUrl matches update feed for ${label}`);
        }
      }

      const latestUrl =
        `${siteBaseUrl}/download/latest?platform=${encodeURIComponent(updatePlatform)}` +
        `&arch=${encodeURIComponent(arch)}` +
        `&channel=${encodeURIComponent(channel)}` +
        `&kind=${encodeURIComponent(updateKind)}`;
      const redirectResult = await fetchRedirectLocation(latestUrl, timeoutMs).catch((error) => {
        failures.push(`Failed to resolve /download/latest for ${label}: ${error.message}`);
        return null;
      });
      if (!redirectResult) {
        continue;
      }
      const isRedirect =
        Number.isInteger(redirectResult.status) &&
        redirectResult.status >= 300 &&
        redirectResult.status < 400;
      if (!isRedirect || !redirectResult.location) {
        failures.push(`/download/latest did not return a redirect for ${label}.`);
        continue;
      }
      const resolvedLatest = await fetchResolvedUrl(latestUrl, timeoutMs).catch((error) => {
        failures.push(`Failed to resolve final /download/latest URL for ${label}: ${error.message}`);
        return null;
      });
      if (!resolvedLatest?.ok) {
        failures.push(`/download/latest is not reachable for ${label}.`);
        continue;
      }
      if (normalizeComparableUrl(resolvedLatest.url) !== normalizeComparableUrl(expected.url)) {
        failures.push(`/download/latest redirect mismatch for ${label}.`);
        continue;
      }
      printPass(`/download/latest redirect matches update feed for ${label}`);
    }
  };

  await verifyPlatformManifests("darwin", archs, "zip");
  await verifyPlatformManifests("win32", winArchs, "exe");

  process.stdout.write("\n");
  for (const warning of warnings) {
    printWarn(warning);
  }
  for (const failure of failures) {
    printFail(failure);
  }

  if (failures.length > 0) {
    process.stderr.write(`\nGo/No-Go checks failed: ${failures.length} error(s)\n`);
    process.exit(1);
  }

  process.stdout.write(
    `Go/No-Go checks passed (${archs.length + winArchs.length} arch, ${artifacts.length} artifact checks)\n`
  );
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
