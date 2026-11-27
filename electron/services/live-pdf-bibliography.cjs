"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { createReadStream } = require("node:fs");
const { createInterface } = require("node:readline");
const { createHash } = require("node:crypto");
const { readFileUpTo } = require("./bounded-file-read.cjs");
const { findTexCommand } = require("./texlive-paths.cjs");
const { isPathWithinRoot } = require("./build/utils.cjs");

const MAX_BYTES = 8 * 1024 * 1024;
const read = file => readFileUpTo(file, MAX_BYTES).catch(() => null);
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

// Normal control files fit in a single read. For a large bibliography keep
// just the digest and the data source names from biblatex's XML records.
async function biberJob(file) {
  const names = new Set();
  let cited = false;
  const scan = xml => {
    cited ||= /<bcf:citekey[\s>]/.test(xml);
    for (const match of xml.matchAll(/<bcf:datasource\b[^>]*>([^<]+)<\/bcf:datasource>/g)) {
      names.add(match[1].trim().replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
    }
  };
  const info = await fs.stat(file).catch(() => null);
  if (!info?.isFile()) return null;
  const hash = createHash("sha256");
  if (info.size <= MAX_BYTES) {
    const bytes = await read(file);
    if (!bytes) return null;
    hash.update(bytes);
    scan(bytes.toString());
  } else {
    const stream = createReadStream(file);
    for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
      hash.update(line).update("\n");
      scan(line);
    }
  }
  return cited && names.size ? { tool: "biber", control: hash.digest("hex"), names } : null;
}

// Read the dependencies TeX actually requested. Citations inside an included
// chapter live in its .aux, even when the root contains no citation command.
async function bibliographyJob(cwd, stem, engine, references, temp) {
  const biber = await biberJob(path.join(cwd, stem + ".bcf"));
  if (biber) return biber;
  const control = createHash("sha256"), names = new Set();
  const pending = new Set([path.join(cwd, stem + ".aux")]);
  let hasData = false, hasCitations = false;
  const scan = (file, text) => {
    for (const m of text.matchAll(/^\\(citation|bibdata|bibstyle|@input)\{([^}\r\n]+)\}/gm)) {
      control.update(JSON.stringify([file, m[0]]));
      if (m[1] === "@input" && !references) {
        const child = path.resolve(cwd, m[2]);
        if (isPathWithinRoot(temp, child) && /\.aux$/i.test(child)) pending.add(child);
      }
      if (m[1] === "citation") hasCitations = true;
      if (m[1] === "bibdata") hasData = true;
      if (m[1] !== "bibstyle" && m[1] !== "bibdata") continue;
      const ext = m[1] === "bibstyle" ? ".bst" : ".bib";
      for (let name of m[2].split(",")) {
        name = name.trim();
        if (name) names.add(name.toLowerCase().endsWith(ext) ? name : name + ext);
      }
    }
  };
  if (references) {
    for (const [file, bytes] of references) {
      if (/\.aux$/i.test(file)) scan(file, bytes.toString());
    }
  } else {
    // The cross-reference cache has a memory cap. Larger books can still
    // run BibTeX from their real aux tree without caching all its bytes.
    for (const file of pending) {
      const handle = await fs.open(file, "r").catch(() => null);
      if (!handle) continue;
      try {
        const name = path.relative(temp, file);
        for await (const line of handle.readLines()) scan(name, line);
      } finally { await handle.close(); }
    }
  }
  return hasCitations && hasData ? {
    tool: engine === "uplatex" ? "upbibtex" : "bibtex", control: control.digest("hex"), names,
  } : null;
}

async function updateBibliography({ root, rootFile, temp, cwd, engine, references, buffers, previous, run, current, inputs, firstPaper }) {
  const stem = path.basename(rootFile, path.extname(rootFile));
  const job = await bibliographyJob(cwd, stem, engine, references, temp);
  if (!job) return null;
  // Biber may unpack its runtime on first use. Let the first TeX page open
  // and accept edits before starting it on the next pass.
  if (firstPaper && job.tool === "biber") return { pending: true };
  const signatures = [];
  let reusable = true;
  for (const name of new Set(job.names)) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(name) || /[*?]/.test(name)) { reusable = false; continue; }
    // Match TEXINPUTS/BIBINPUTS. Remember absent higher-priority copies as
    // well: creating one can change the bibliography without a source edit.
    for (const dir of new Set([path.dirname(rootFile), root])) {
      const file = path.resolve(dir, name);
      if (!isPathWithinRoot(root, file)) { reusable = false; break; }
      inputs.add(file);
      const relative = path.relative(root, file);
      const buffer = buffers.get(relative);
      if (typeof buffer === "string") { signatures.push([file, digest(buffer)]); break; }
      // biblatex's BibTeX backend generates a job-specific control database.
      const generated = path.join(temp, relative);
      const staged = await read(generated);
      if (staged) { signatures.push([relative, digest(staged)]); break; }
      const stat = await fs.stat(file, { bigint: true }).catch(() => null);
      if (stat?.isFile()) {
        signatures.push([file, String(stat.size), String(stat.ctimeNs), String(stat.mtimeNs), String(stat.ino)]);
        break;
      }
    }
  }
  const key = digest(JSON.stringify([job.tool, job.control, signatures]));
  if (!current()) return null;
  const target = path.join(cwd, stem + ".bbl");
  if (reusable && previous?.key === key && !previous.missingCommand && !previous.staged) return previous;
  const tool = findTexCommand(job.tool);
  if (!tool) return { key, warning: job.tool, missingCommand: job.tool };
  // A leading dash in the manuscript name is part of its filename.
  const result = await run(tool, ["./" + stem]);
  if (!current() || result.cancelled || result.cleanupFailed) return null;
  if (result.status === 0 && !result.timedOut) {
    const size = (await fs.stat(target).catch(() => null))?.size;
    if (size > MAX_BYTES) return { key, staged: true };
    const bytes = await read(target);
    if (bytes) return { key, bytes };
  }
  const warning = result.output?.split(/\r?\n/).find(line => /couldn't open|cannot find|not found|\bERROR\b|error message|expecting/i.test(line));
  return { key, warning: warning?.trim() || job.tool + " could not generate " + stem + ".bbl" };
}

module.exports = { updateBibliography };
