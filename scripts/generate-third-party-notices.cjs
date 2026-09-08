#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);

const readArgs = (name) => {
  const values = [];
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] === `--${name}`) {
      const value = String(args[index + 1] || "").trim();
      if (value) values.push(value);
      index += 1;
    }
  }
  return values;
};

const readArg = (name, fallback = "") => {
  return readArgs(name)[0] || fallback;
};

const lockPaths = readArgs("lock");
if (lockPaths.length === 0) lockPaths.push("package-lock.json");
const outPath = readArg("out", "NOTICE.md");
const projectName = readArg("project", "Project");

const lockFiles = lockPaths.map((lockPath) => path.resolve(process.cwd(), lockPath));
const outputFile = path.resolve(process.cwd(), outPath);

for (const lockFile of lockFiles) {
  if (!fs.existsSync(lockFile)) {
    console.error(`lock file not found: ${lockFile}`);
    process.exit(1);
  }
}

const normalizeRepository = (value) => {
  if (!value) {
    return "";
  }
  if (typeof value === "string") {
    return value.trim();
  }
  if (value && typeof value === "object" && typeof value.url === "string") {
    return value.url.trim();
  }
  return "";
};

const normalizeLicense = (value) => {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        if (typeof entry === "string") {
          return entry.trim();
        }
        if (entry && typeof entry === "object" && typeof entry.type === "string") {
          return entry.type.trim();
        }
        return "";
      })
      .filter(Boolean)
      .join(", ");
  }
  if (value && typeof value === "object" && typeof value.type === "string") {
    return value.type.trim();
  }
  return "";
};

const toPackageName = (packagePath) => {
  const normalized = String(packagePath || "").replaceAll("\\", "/");
  const marker = "/node_modules/";
  const index = normalized.lastIndexOf(marker);
  if (index >= 0) {
    return normalized.slice(index + marker.length).trim();
  }
  if (normalized.startsWith("node_modules/")) {
    return normalized.slice("node_modules/".length).trim();
  }
  return normalized.trim();
};

const rows = new Map();
for (const lockFile of lockFiles) {
  const lock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
  const packages = lock && typeof lock === "object" && lock.packages ? lock.packages : {};
  for (const [packagePath, meta] of Object.entries(packages)) {
    if (!packagePath || packagePath === "") {
      continue;
    }
    if (!packagePath.startsWith("node_modules/") && !packagePath.includes("/node_modules/")) {
      continue;
    }
    if (!meta || typeof meta !== "object") {
      continue;
    }
    const name = toPackageName(packagePath);
    const version = typeof meta.version === "string" && meta.version.trim() ? meta.version.trim() : "";
    const license = normalizeLicense(meta.license) || "UNKNOWN";
    const homepage = typeof meta.homepage === "string" ? meta.homepage.trim() : "";
    const repository = normalizeRepository(meta.repository);
    if (!name || !version) {
      continue;
    }
    const key = `${name}@${version}`;
    const existing = rows.get(key);
    if (!existing) {
      rows.set(key, {
        name,
        version,
        license,
        homepage,
        repository,
      });
      continue;
    }
    // A dependency can be present in both lockfiles. Keep one row while
    // preferring whichever lock supplied richer metadata.
    if (existing.license === "UNKNOWN" && license !== "UNKNOWN") {
      existing.license = license;
    }
    if (!existing.homepage && homepage) existing.homepage = homepage;
    if (!existing.repository && repository) existing.repository = repository;
  }
}

const sorted = Array.from(rows.values()).sort((a, b) => {
  const byName = a.name.localeCompare(b.name);
  if (byName !== 0) {
    return byName;
  }
  return a.version.localeCompare(b.version);
});

const now = new Date().toISOString();
const displayLockPaths = lockFiles.map((lockFile) => {
  const relative = path.relative(process.cwd(), lockFile);
  return (relative || path.basename(lockFile)).replaceAll(path.sep, "/");
});
const lines = [
  `# Third-Party Notices (${projectName})`,
  "",
  `Generated: ${now}`,
  "Sources:",
  ...displayLockPaths.map((lockPath) => `- \`${lockPath}\``),
  `Package count: ${sorted.length}`,
  "",
  "This file lists package metadata (name/version/license) collected from the lockfiles.",
  "For full license texts, see each package's LICENSE file in node_modules or upstream repository.",
  "",
  "| Package | Version | License | Homepage | Repository |",
  "| --- | --- | --- | --- | --- |",
];

for (const row of sorted) {
  const homepage = row.homepage || "";
  const repository = row.repository || "";
  const escapePipe = (value) => String(value || "").replaceAll("|", "\\|");
  lines.push(
    `| ${escapePipe(row.name)} | ${escapePipe(row.version)} | ${escapePipe(
      row.license
    )} | ${escapePipe(homepage)} | ${escapePipe(repository)} |`
  );
}

// Bundled binaries that are not npm packages (and therefore not in the
// lockfile) but are shipped in the distributable. texlab is GPL-3.0; we invoke
// it as a separate process (no linking), and convey the unmodified upstream
// binary, so we provide its license and a pointer to the corresponding source.
const BUNDLED_BINARIES = [
  {
    name: "Git / dugite-native",
    version: "Git 2.53.0; dugite-native v2.53.0-4",
    license: "GPL-2.0-only (Git; see bundled COPYING for component exceptions)",
    source: "https://github.com/desktop/dugite-native/releases/tag/v2.53.0-4",
    note: "Executed as a separate program. Resources/git-runtime/legal contains " +
      "Git COPYING, the corresponding Git v2.53.0 source archive (commit " +
      "67ad42147a7acc2af6074753ebd03d904476118f), and dugite-native build scripts. " +
      "The original archive is SHA-256 pinned; application packaging applies code signatures.",
  },
  {
    name: "Git Credential Manager / .NET / Git LFS",
    version: "GCM 2.9.0; .NET 10.0.9; Git LFS 3.7.1",
    license: "MIT (plus bundled component notices)",
    source: "https://github.com/git-ecosystem/git-credential-manager/tree/v2.9.0",
    note: "Self-contained GCM is conveyed within the pinned dugite-native runtime. " +
      "Its upstream NOTICE is retained at Resources/git-runtime/<platform>-<arch>/libexec/git-core/NOTICE. " +
      "GCM, .NET, and Git LFS license texts ship in Resources/git-runtime/legal. " +
      "Bundling Git LFS does not enable unsupported LFS workflows in TeX64.",
  },
  {
    name: "texlab",
    version: "v5.25.1",
    license: "GPL-3.0-only",
    source: "https://github.com/latex-lsp/texlab",
    note:
      "Invoked as a separate language-server process (not linked). The bundled " +
      "binary is the unmodified upstream release; corresponding source for tag " +
      "v5.25.1 is available at the source URL above. A copy of the GNU General " +
      "Public License v3.0 ships at Resources/texlab/LICENSE-GPL-3.0.txt.",
  },
];

lines.push("", "## Bundled binaries (not from npm)", "");
for (const bin of BUNDLED_BINARIES) {
  lines.push(
    `### ${bin.name}`,
    "",
    `- Version: ${bin.version}`,
    `- License: ${bin.license}`,
    `- Source: ${bin.source}`,
    `- ${bin.note}`,
    ""
  );
}

fs.writeFileSync(outputFile, `${lines.join("\n")}\n`, "utf8");
console.log(
  `wrote ${outputFile} (${sorted.length} packages from ${lockFiles.length} lockfiles)`,
);
