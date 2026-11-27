"use strict";

// Vendors the TDOM real-time preview engine (sibling repo, default
// ~/tdom-engine) into Resources/tdom-engine so packaged builds are
// self-contained. The app uses the synced copy by default in development and
// packaged builds. Run `npm run tdom:sync` after engine changes, or explicitly
// set TDOM_ENGINE_DIR to use a live checkout during development.
//
// Source dir override: TDOM_ENGINE_DIR. TEX64_TDOM_ENGINE_DIR remains a
// compatibility alias for older development environments.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");
const destination = path.join(repoRoot, "Resources", "tdom-engine");

function canonicalPath(target) {
  if (fs.existsSync(target)) return fs.realpathSync(target);
  return path.join(canonicalPath(path.dirname(target)), path.basename(target));
}

function contains(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}

async function syncTdomEngine({ sourceDir, destinationDir = destination, arch } = {}) {
  const envDir = sourceDir || (process.env.TDOM_ENGINE_DIR || process.env.TEX64_TDOM_ENGINE_DIR || "").trim();
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
    throw new Error("tdom-engine checkout not found");
  }

  const sourcePath = fs.realpathSync(source);
  const targetPath = canonicalPath(path.resolve(destinationDir));
  if (contains(sourcePath, targetPath) || contains(targetPath, sourcePath)) {
    throw new Error("TDOM source and destination directories must be separate");
  }
  const previous = fs.lstatSync(destinationDir, { throwIfNoEntry: false });
  if (previous && (!previous.isDirectory() || (
    fs.readdirSync(destinationDir).length > 0 &&
    !fs.existsSync(path.join(destinationDir, "VENDOR.json"))
  ))) {
    throw new Error(`Refusing to replace an existing directory without a generated TDOM bundle: ${destinationDir}`);
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
    const to = path.join(destinationDir, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  };

  fs.rmSync(destinationDir, { recursive: true, force: true });
  fs.mkdirSync(destinationDir, { recursive: true });
  for (const rel of INCLUDE) copyEntry(rel);

  let commit = null;
  try {
    commit = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    /* not a git checkout — record the path only */
  }
  fs.writeFileSync(
    path.join(destinationDir, "VENDOR.json"),
    `${JSON.stringify({ source, commit, syncedAt: new Date().toISOString() }, null, 2)}\n`
  );

  await require("./prepare-tdom-shim.cjs").prepareTdomShim({ engineDir: destinationDir, arch });

  console.log(`Synced tdom engine: ${source} -> ${destinationDir}${commit ? ` (${commit.slice(0, 10)})` : ""}`);

  return destinationDir;
}

module.exports = { syncTdomEngine };
if (require.main === module) {
  syncTdomEngine().catch(error => { console.error(error); process.exitCode = 1; });
}
