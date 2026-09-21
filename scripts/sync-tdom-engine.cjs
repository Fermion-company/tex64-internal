"use strict";

// Vendors the TDOM real-time preview engine (sibling repo, default
// ~/tdom-engine) into Resources/tdom-engine so packaged builds are
// self-contained. Development never needs this: tdom-engine.cjs resolves a
// live checkout first, so engine changes are picked up simply by restarting
// the preview. Run `npm run tdom:sync` before packaging a build that should
// ship the engine, or after engine changes you want in the next .dmg.
//
// Source dir override: TDOM_ENGINE_DIR. TEX64_TDOM_ENGINE_DIR remains a
// compatibility alias for older development environments.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");
const destination = path.join(repoRoot, "Resources", "tdom-engine");

const envDir = (process.env.TDOM_ENGINE_DIR || process.env.TEX64_TDOM_ENGINE_DIR || "").trim();
const candidates = envDir
  ? [envDir]
  : [
      path.join(os.homedir(), "Developer", "tdom-engine"),
      path.join(os.homedir(), "tdom-engine"),
      path.join(os.homedir(), "Desktop", "tdom-engine"),
      path.join(os.homedir(), "Developer", "tdom-core"),
      path.join(os.homedir(), "tdom-core"),
      path.join(os.homedir(), "Desktop", "tdom-core"),
    ];
const source = candidates.find((dir) => fs.existsSync(path.join(dir, "server.js")));
if (!source) {
  console.error(
    `tdom-engine checkout not found (tried: ${candidates.join(", ")}). ` +
      "Set TDOM_ENGINE_DIR to the checkout."
  );
  process.exit(1);
}

// The minimal runnable engine: everything else in the repo (corpus, paper,
// tests, tools, web/pdfjs, output) stays behind.
const INCLUDE = [
  "package.json",
  "server.js",
  "LICENSE",
  "engine",
  "host",
  "vendor",
  "templates",
  "samples",
  "web",
];
const SKIP = new Set(["web/pdfjs", "web/compare.html", "web/compare.js", "samples/uploads"]);

const copyEntry = (rel) => {
  const from = path.join(source, rel);
  if (!fs.existsSync(from)) return;
  const stat = fs.statSync(from);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(from)) {
      const childRel = path.posix.join(rel, entry);
      if (SKIP.has(childRel)) continue;
      copyEntry(childRel);
    }
    return;
  }
  const to = path.join(destination, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
};

fs.rmSync(destination, { recursive: true, force: true });
fs.mkdirSync(destination, { recursive: true });
for (const rel of INCLUDE) copyEntry(rel);

let commit = null;
try {
  commit = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
} catch {
  /* not a git checkout — record the path only */
}
fs.writeFileSync(
  path.join(destination, "VENDOR.json"),
  `${JSON.stringify({ source, commit, syncedAt: new Date().toISOString() }, null, 2)}\n`
);

console.log(`Synced tdom engine: ${source} -> ${destination}${commit ? ` (${commit.slice(0, 10)})` : ""}`);
