const path = require("node:path");
const fs = require("node:fs/promises");
const { parseLatexStructure } = require("../../services/agent-tools-latex.cjs");

// Only the sources actually recorded for this PDF can contribute a heading.
// A project may contain several roots, or unrelated files with the same name.
const readPaperOutline = async (workspace, synctex, pdfFile, mainFile) => {
  if (typeof pdfFile !== "string" || !/\.pdf$/i.test(pdfFile)) return [];
  const pdfPath = workspace.resolvePath(pdfFile);
  const source = workspace.resolvePath(mainFile);
  const syncPath = synctex.findSynctexOutputPath(pdfPath);
  const index = syncPath && synctex.loadForwardIndex(syncPath);
  if (!index?.inputs.size) return [];
  const root = await fs.realpath(workspace.getRootPath());
  const documentSource = await fs.realpath(source);
  const firstTag = Math.min(...index.inputs.keys());
  const compiledRoot = await fs.realpath(index.inputs.get(firstTag)).catch(() => null);
  if (compiledRoot !== documentSource) return [];

  const headings = [];
  const seen = new Set();
  for (const input of index.inputs.values()) {
    if (!/\.(?:tex|ltx)$/i.test(input)) continue;
    const absolute = await fs.realpath(input).catch(() => null);
    if (!absolute || seen.has(absolute)) continue;
    seen.add(absolute);
    const relative = path.relative(root, absolute);
    if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
    const text = await fs.readFile(absolute, "utf8").catch(() => null);
    if (!text) continue;
    const nodes = parseLatexStructure(text).nodes.filter((node) => node.title && node.headerLine && node.level < 100);
    if (!nodes.length) continue;
    const { results } = synctex.forwardLinesQuick({ sourcePath: absolute, pdfPath, lines: nodes.map((node) => node.headerLine) });
    const positions = new Map((results ?? []).filter((hit) => hit.found && hit.matchedLine === hit.line).map((hit) => [hit.line, hit]));
    for (const node of nodes) {
      const hit = positions.get(node.headerLine);
      if (hit && Number.isFinite(hit.y)) headings.push({
        title: node.title, path: relative.split(path.sep).join("/"), line: node.headerLine, level: node.level, page: hit.page, y: hit.y,
      });
    }
  }
  return headings.sort((a, b) => a.page - b.page || a.y - b.y);
};

module.exports = { readPaperOutline };
