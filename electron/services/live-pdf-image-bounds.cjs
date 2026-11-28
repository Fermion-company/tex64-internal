"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { isPathWithinRoot } = require("./build/utils.cjs");
const { readFileUpTo } = require("./bounded-file-read.cjs");
const { findTexCommand } = require("./texlive-paths.cjs");

// Keep the distribution's driver and its normal handling of author-supplied
// .xbb files. For a missing box, record the same file, PDF page and box the
// driver would pass to extractbb. A provisional size only lets TeX discover
// the rest of the figures in one pass. That PDF is never published.
const driverHook = String.raw`\newwrite\texpreviewbounds
\immediate\openout\texpreviewbounds=tex64-preview-bounds.req\relax
\let\texpreviewreadbounds\Gread@extractbb@aux
\def\Gread@extractbb@aux#1{%
  \ifeof\@inputcheck
    \edef\texpreviewkey{\pdfmdfivesum{{\Gin@base\Gin@ext}{\Gin@page}{\Gin@pagebox}}}%
    \immediate\write\texpreviewbounds{K \texpreviewkey}%
    \immediate\write\texpreviewbounds{F \Gin@base\Gin@ext}%
    \immediate\write\texpreviewbounds{P \Gin@page}%
    \immediate\write\texpreviewbounds{B \Gin@pagebox}%
    \immediate\openin\@inputcheck=tp-\texpreviewkey.xbb\relax
    \ifeof\@inputcheck
      \immediate\openin\@inputcheck=tp-pending.xbb\relax
    \fi
  \fi
  \texpreviewreadbounds{#1}}
`;

async function prepareImageBounds({ temp, cwd, root, env, run, previous }) {
  const lookup = findTexCommand("kpsewhich");
  if (!lookup) return null;
  const result = await run(lookup, ["--format=tex", "dvipdfmx.def"]);
  if (result.status !== 0) return null;
  const driver = path.resolve(cwd, result.output.trim());
  // Project/local drivers own their own graphics conventions.
  if (!/[\\/]tex[\\/]latex[\\/]graphics-def[\\/]dvipdfmx\.def$/i.test(driver) ||
      isPathWithinRoot(root, driver) || isPathWithinRoot(temp, driver)) return null;
  const standard = await readFileUpTo(driver, 512 * 1024).catch(() => null);
  if (!standard?.includes(Buffer.from("\\Gread@extractbb@aux"))) return null;
  const dir = await fs.mkdtemp(path.join(temp, "tex64-bounds-"));
  const original = path.basename(dir) + "-driver.def";
  await fs.writeFile(path.join(dir, original), standard);
  await fs.writeFile(path.join(dir, "dvipdfmx.def"), "\\@@input " + original + "\\relax\n" + driverHook);
  await fs.writeFile(path.join(dir, "tp-pending.xbb"), "%%BoundingBox: 0 0 72 72\n");
  const files = new Map(previous);
  for (const [key, box] of files) await fs.writeFile(path.join(dir, "tp-" + key + ".xbb"), box.contents);
  env.TEXINPUTS = path.relative(cwd, dir).split(path.sep).join("/") + path.delimiter + env.TEXINPUTS;
  return { dir, files, lookup, texTree: await fs.realpath(path.resolve(path.dirname(driver), "../../..")) };
}

const graphicFile = /\.(?:pdf|ai|png|jpe?g|jp2|jpf|bmp)$/i;
const boxLine = /^%%(?:HiRes)?BoundingBox:(?:\s+-?\d+(?:\.\d+)?){4}\s*$/;
async function resolveImageBounds({ bounds, root, temp, cwd, recorder, searchDirs, run, current }) {
  const requestFile = path.join(cwd, "tex64-preview-bounds.req");
  const stat = await fs.stat(requestFile).catch(() => null);
  if (!stat?.size) { bounds.files.clear(); return { ready: true }; }
  const data = await readFileUpTo(requestFile, 1024 * 1024);
  const log = await readFileUpTo(recorder, 8 * 1024 * 1024);
  if (!data || !log) return { error: "Could not read the graphics requested by upLaTeX." };
  const recorded = new Set(log.toString().split(/\r?\n/).filter(line => line.startsWith("INPUT ") && graphicFile.test(line))
    .map(line => path.resolve(cwd, line.slice(6))));
  const realRoot = await fs.realpath(root), realTemp = await fs.realpath(temp);
  const dirs = [...new Set([...searchDirs, ...await Promise.all(searchDirs.map(dir => fs.realpath(dir)))])];
  const wanted = new Map();
  const lines = data.toString().trimEnd().split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 4) {
    const key = /^K ([A-F0-9]{32})$/.exec(lines[i])?.[1];
    const name = /^F (.+)$/.exec(lines[i + 1])?.[1]?.replace(/"/g, "");
    const page = /^P\s*(\d*)$/.exec(lines[i + 2])?.[1];
    const boxMatch = /^B\s*(cropbox|mediabox|trimbox|bleedbox|artbox)?$/.exec(lines[i + 3]);
    if (!key || !name || page === undefined || !boxMatch) {
      return { error: "Invalid image dimensions request from upLaTeX." };
    }
    wanted.set(key, { name, page, box: boxMatch[1] ?? "" });
  }
  let ready = true;
  for (const [key, { name, page, box }] of wanted) {
    if (!current()) return { ready: false };
    let file = dirs.map(dir => path.resolve(dir, name)).find(file => recorded.has(file));
    if (!file) {
      // Class logos and the example-image figures can come from the
      // distribution. Confirm the lookup against this pass's recorder.
      const match = await run(bounds.lookup, ["--format=graphic/figure", "--", name]);
      const found = path.resolve(cwd, match.output.trim());
      if (match.status === 0 && recorded.has(found)) file = found;
    }
    const image = file && await fs.realpath(file).catch(() => null);
    if (!image || ![realRoot, realTemp, bounds.texTree].some(dir => isPathWithinRoot(dir, image))) {
      return { error: `Could not locate the figure used by upLaTeX: ${name}` };
    }
    const info = await fs.stat(image);
    const stamp = JSON.stringify([image, info.size, info.mtimeMs, info.ctimeMs, page, box]);
    if (bounds.files.get(key)?.stamp === stamp) continue;
    const extract = findTexCommand("extractbb");
    if (!extract) return { missing: "extractbb" };
    const result = await run(extract, [...(page ? ["-p", page] : []), ...(box ? ["-B", box] : []), "-O", image]);
    const metadata = result.output.split(/\r?\n/).filter(line => boxLine.test(line));
    if (result.status !== 0 || !metadata.some(line => line.startsWith("%%BoundingBox:"))) {
      return { error: `Could not read the dimensions of ${name}.` };
    }
    const contents = metadata.join("\n") + "\n";
    await fs.writeFile(path.join(bounds.dir, "tp-" + key + ".xbb"), contents);
    bounds.files.set(key, { stamp, contents });
    ready = false;
  }
  for (const key of bounds.files.keys()) if (!wanted.has(key)) bounds.files.delete(key);
  return { ready };
}
module.exports = { prepareImageBounds, resolveImageBounds };
