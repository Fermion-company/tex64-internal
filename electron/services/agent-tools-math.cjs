/**
 * Math-region location for the LaTeX editing agent.
 *
 * `findMathRegion` locates the math construct that encloses a given 1-based
 * line: a math *container* environment (equation / align / gather / ...), a
 * display block (\[ \] or $$ $$), or inline math ($ $ or \( \)). It returns the
 * exact line range and the verbatim content so the agent can read the whole
 * formula and then edit precisely that range (e.g. to fill in derivation
 * steps) instead of guessing line numbers.
 *
 * Pure text analysis — no filesystem access; `handleFindMathRegion` adds the
 * file read on top so it can be wired as an agent tool.
 */

"use strict";

// Outermost math *container* environments. Inner-only environments such as
// cases / aligned / split / array / matrix are intentionally NOT listed: we
// want to return the whole displayed block, not a sub-part of it.
const MATH_ENV_NAMES = new Set([
  "equation",
  "align",
  "alignat",
  "flalign",
  "gather",
  "multline",
  "eqnarray",
  "displaymath",
  "math",
  "IEEEeqnarray",
  "dmath",
  "dgroup",
]);

const isMathEnvName = (name) => {
  if (typeof name !== "string") return false;
  return MATH_ENV_NAMES.has(name.replace(/\*$/, "").trim());
};

const splitLines = (content) => String(content ?? "").split(/\r\n|\r|\n/);

const sliceContent = (lines, startLine, endLine) =>
  lines.slice(startLine - 1, endLine).join("\n");

// --- environments: \begin{env} ... \end{env} (handles nesting) ---
const findEnvRegion = (lines, line) => {
  const stack = [];
  const spans = [];
  for (let idx = 0; idx < lines.length; idx++) {
    const text = lines[idx];
    const lineNo = idx + 1;
    const re = /\\(begin|end)\s*\{([^}]*)\}/g;
    let m;
    while ((m = re.exec(text))) {
      if (m[1] === "begin") {
        stack.push({ name: m[2], startLine: lineNo });
      } else {
        for (let i = stack.length - 1; i >= 0; i--) {
          if (stack[i].name === m[2]) {
            spans.push({ name: m[2], startLine: stack[i].startLine, endLine: lineNo });
            stack.splice(i, 1);
            break;
          }
        }
      }
    }
  }
  const containing = spans.filter(
    (s) => isMathEnvName(s.name) && s.startLine <= line && line <= s.endLine,
  );
  if (!containing.length) return null;
  // Outermost math container: smallest start, then largest end.
  containing.sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine);
  const best = containing[0];
  return {
    found: true,
    kind: "environment",
    environment: best.name,
    startLine: best.startLine,
    endLine: best.endLine,
    content: sliceContent(lines, best.startLine, best.endLine),
  };
};

// --- display \[ ... \] ---
const findBracketDisplay = (lines, line) => {
  let open = null;
  for (let idx = 0; idx < lines.length; idx++) {
    const re = /\\(\[|\])/g;
    let m;
    while ((m = re.exec(lines[idx]))) {
      const isOpen = m[1] === "[";
      const lineNo = idx + 1;
      if (isOpen) {
        if (!open) open = lineNo;
      } else if (open) {
        if (open <= line && line <= lineNo) {
          return {
            found: true,
            kind: "display",
            environment: "\\[ \\]",
            startLine: open,
            endLine: lineNo,
            content: sliceContent(lines, open, lineNo),
          };
        }
        open = null;
      }
    }
  }
  return null;
};

// --- display $$ ... $$ (toggle pairs) ---
const findDoubleDollar = (lines, line) => {
  const toks = [];
  for (let idx = 0; idx < lines.length; idx++) {
    const re = /\$\$/g;
    let m;
    while ((m = re.exec(lines[idx]))) toks.push(idx + 1);
  }
  for (let i = 0; i + 1 < toks.length; i += 2) {
    if (toks[i] <= line && line <= toks[i + 1]) {
      return {
        found: true,
        kind: "display",
        environment: "$$",
        startLine: toks[i],
        endLine: toks[i + 1],
        content: sliceContent(lines, toks[i], toks[i + 1]),
      };
    }
  }
  return null;
};

// --- inline $ ... $ and \( ... \) on a single line (best effort) ---
const findInline = (lines, line, column) => {
  const idx = line - 1;
  if (idx < 0 || idx >= lines.length) return null;
  const text = lines[idx];
  const regions = [];
  let re = /\\\((.*?)\\\)/g;
  let m;
  while ((m = re.exec(text))) {
    regions.push({ start: m.index, end: m.index + m[0].length, env: "\\( \\)" });
  }
  // Single $...$ that is not part of $$, and not an escaped \$.
  re = /(?<![\\$])\$(?!\$)((?:\\.|[^$\\])*?)(?<!\\)\$(?!\$)/g;
  while ((m = re.exec(text))) {
    regions.push({ start: m.index, end: m.index + m[0].length, env: "$ $" });
  }
  if (!regions.length) return null;
  let chosen = regions[0];
  if (Number.isFinite(column)) {
    const hit = regions.find((r) => column - 1 >= r.start && column - 1 <= r.end);
    if (hit) chosen = hit;
  }
  return {
    found: true,
    kind: "inline",
    environment: chosen.env,
    startLine: line,
    endLine: line,
    startColumn: chosen.start + 1,
    endColumn: chosen.end + 1,
    content: text.slice(chosen.start, chosen.end),
  };
};

const findMathRegion = (content, line, column) => {
  const lines = splitLines(content);
  if (!Number.isInteger(line) || line < 1 || line > lines.length) {
    return {
      found: false,
      error: `line ${line} is out of range (file has ${lines.length} lines).`,
    };
  }
  const region =
    findEnvRegion(lines, line) ||
    findBracketDisplay(lines, line) ||
    findDoubleDollar(lines, line) ||
    findInline(lines, line, column);
  if (!region) {
    return {
      found: false,
      message:
        `No math region found at line ${line}; the cursor may be in regular text. ` +
        `Pass the exact line of an equation, or use read_file / list_sections instead.`,
    };
  }
  const span =
    region.startLine === region.endLine
      ? `line ${region.startLine}`
      : `lines ${region.startLine}–${region.endLine}`;
  return { ...region, summary: `Found ${region.environment} (${span})` };
};

const handleFindMathRegion = async (service, args, policy, conversationId) => {
  const { handleReadFile } = require("./agent-tools-file.cjs");
  const path = typeof args?.path === "string" ? args.path.trim() : "";
  if (!path) return { found: false, error: "path is required." };
  const line = Number.parseInt(args?.line, 10);
  if (!Number.isInteger(line) || line < 1) {
    return { found: false, error: "line (1-based integer) is required." };
  }
  const columnRaw = Number(args?.column);
  const column = Number.isFinite(columnRaw) ? columnRaw : undefined;
  const read = await handleReadFile(service, { path }, policy, conversationId);
  if (read && read.error) return { found: false, error: read.error };
  const content = typeof read?.content === "string" ? read.content : "";
  return { path, ...findMathRegion(content, line, column) };
};

module.exports = {
  MATH_ENV_NAMES,
  isMathEnvName,
  findMathRegion,
  handleFindMathRegion,
};
