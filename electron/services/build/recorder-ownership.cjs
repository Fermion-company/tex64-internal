"use strict";

const { createHash } = require("node:crypto");
const { createReadStream } = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const { isStagingName } = require("../project-file-writes.cjs");

// The fallback tracks project names, including non-TeX optional inputs.
const BUILD_OUTPUT = /\.(?:aux|log|fls|fdb_latexmk|synctex(?:\.gz)?|pdf|dvi|xdv|toc|lof|lot|out|bbl|blg|bcf|run\.xml|idx|ind|ilg|glo|gls|acn|acr|ist|xdy|nav|snm|vrb|thm)$/i;

const digest = (entries) => createHash("sha256").update(JSON.stringify(entries.sort())).digest("hex");
const within = (root, file) => {
  const relative = path.relative(root, file);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

// A TeX .fls gives successful opens, not the set of Kpathsea misses. Compare
// a bounded inventory before and after Build and again before using its reads.
async function projectLookupInventory(root) {
  try {
    const pending = [""];
    const names = [];
    let count = 0;
    const deadline = Date.now() + 2500;
    while (pending.length) {
      const directory = pending.pop();
      const entries = await fs.readdir(path.join(root, directory), { withFileTypes: true });
      for (const entry of entries) {
        if (++count > 20_000 || Date.now() > deadline) return null;
        if (entry.name === ".git" || entry.name === ".tex64" || entry.name.startsWith(".tex64-build-") ||
            isStagingName(entry.name)) continue;
        const relative = path.join(directory, entry.name);
        // A recursive search through links can lead outside the observed tree.
        if (entry.isSymbolicLink()) return null;
        if (entry.isDirectory()) pending.push(relative);
        else if (!entry.isFile() || /^\.?latexmkrc$/i.test(entry.name)) return null;
        else if (!BUILD_OUTPUT.test(entry.name)) names.push(relative.split(path.sep).join("/"));
      }
    }
    return digest(names);
  } catch {
    return null;
  }
}

// External inputs do not belong in the preview cache's project manifest.
// Hash them separately for ownership. The recorder's own outputs (e.g. an
// .aux it opens for reading and rewrites) are products of this Build.
async function readOwnershipRecorder(recorder, root, startedAt = Infinity) {
  try {
    const stat = await fs.stat(recorder);
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) return null;
    const raw = await fs.readFile(recorder);
    const lines = raw.toString("utf8").split(/\r?\n/);
    const pwd = lines.find((line) => line.startsWith("PWD "))?.slice(4).trim();
    if (!pwd || !path.isAbsolute(pwd) || await fs.realpath(pwd) !== root) return null;
    const paths = (prefix) => new Set(lines.filter((line) => line.startsWith(prefix)).map((line) => line.slice(prefix.length).trim()));
    const outputs = new Set([...paths("OUTPUT ")].map((file) => path.resolve(pwd, file)));
    const entries = [];
    const project = new Set();
    let total = 0;
    for (const input of paths("INPUT ")) {
      if (!input || input.startsWith("|")) return null;
      const file = path.resolve(pwd, input);
      if (outputs.has(file)) {
        if (!BUILD_OUTPUT.test(file)) return null;
        continue;
      }
      if (within(root, file)) {
        const real = await fs.realpath(file);
        if (!within(root, real) || outputs.has(real)) return null;
        project.add(path.relative(root, real).split(path.sep).join("/"));
        continue;
      }
      const real = await fs.realpath(file);
      const before = await fs.stat(real);
      if (!before.isFile() || before.ctimeMs > startedAt || (total += before.size) > 256 * 1024 * 1024) return null;
      const hash = createHash("sha256");
      let bytes = 0;
      for await (const chunk of createReadStream(real)) {
        bytes += chunk.length;
        if (bytes > before.size) return null;
        hash.update(chunk);
      }
      const after = await fs.stat(real);
      if (bytes !== before.size || before.ctimeMs !== after.ctimeMs ||
          before.ino !== after.ino || before.dev !== after.dev) return null;
      entries.push(JSON.stringify([file, real, hash.digest("hex")]));
    }
    return { project, external: digest(entries), recorder: createHash("sha256").update(raw).digest("hex") };
  } catch {
    return null;
  }
}

module.exports = { projectLookupInventory, readOwnershipRecorder };
