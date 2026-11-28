"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { isPathWithinRoot } = require("./build/utils.cjs");

function originalInput(aliases, name) {
  if (aliases) {
    for (const [alias, directory] of aliases) {
      if (isPathWithinRoot(alias, name)) return path.join(directory, path.relative(alias, name));
    }
  }
  return name;
}

// Kpathsea expands braces, variables and path separators even inside a single
// directory name. Give it a literal search entry without copying project files.
async function previewSearchPaths(sandbox, stage, cwd, root, rootFile) {
  const entries = [];
  const aliases = new Map();
  for (const directory of new Set([cwd, path.dirname(rootFile), stage, root])) {
    let entry = directory;
    const withoutDrive = process.platform === "win32" ? directory.replace(/^[A-Za-z]:/, "") : directory;
    if (/[{};$:~]/.test(withoutDrive)) {
      if (directory === cwd || directory === stage) {
        entry = path.relative(cwd, directory) || ".";
      } else {
        const alias = path.join(sandbox, "input-" + entries.length);
        await fs.symlink(directory, alias, process.platform === "win32" ? "junction" : "dir");
        aliases.set(alias, directory);
        aliases.set(path.join(await fs.realpath(sandbox), path.basename(alias)), directory);
        entry = path.relative(cwd, alias);
      }
    }
    entries.push(entry.split(path.sep).join("/"));
  }
  return { entries, aliases };
}

const SOURCE_EXTENSION = /\.(?:tex|bib|sty|cls|bst|bbx|cbx|cfg|clo|def|fd|ldf|lbx|ltx|dtx|ins)$/i;
function recordedProjectPath(map, recorded) {
  const name = originalInput(map.aliases, recorded);
  const base = [map.temp, map.realTemp, map.root, map.realRoot].find(base => isPathWithinRoot(base, name));
  return base && SOURCE_EXTENSION.test(name) ? path.join(map.root, path.relative(base, name)) : null;
}
module.exports = { previewSearchPaths, originalInput, recordedProjectPath, SOURCE_EXTENSION };
