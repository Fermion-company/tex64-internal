"use strict";

// Pure helpers behind "which document does this .tex belong to?".
//
// The build button used to compile the workspace's designated root no matter
// which file was open, so a project holding a second document in a subfolder
// (root/main.tex plus root/sub/main.tex) always produced the root's PDF — the
// bug reported in issue #38. Deciding the target needs two questions answered
// about file contents, and both are pure string work, so they live here where
// node:test can cover them without a workspace on disk.

// A preamble comment can legally sit before \documentclass, and \begin{document}
// can be far down the file, so both markers are searched over the whole text.
// Commented-out lines must not count: a chapter file that documents its parent
// with "% \documentclass{book}" is still a child.
const stripTexComments = (content) =>
  String(content ?? "")
    .split(/\r?\n/)
    .map((line) => {
      let out = "";
      for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];
        if (ch === "\\") {
          out += line.slice(i, i + 2);
          i += 1;
          continue;
        }
        if (ch === "%") {
          break;
        }
        out += ch;
      }
      return out;
    })
    .join("\n");

// A file that carries its own class and document body compiles on its own —
// that is what makes root/sub/main.tex a build target rather than an include.
const isStandaloneDocument = (content) => {
  const text = stripTexComments(content);
  if (!/\\documentclass\s*(\[[^\]]*\])?\s*\{/.test(text) && !/\\documentstyle\s*(\[[^\]]*\])?\s*\{/.test(text)) {
    return false;
  }
  return /\\begin\s*\{document\}/.test(text);
};

// \input / \include / \subfile / \subfileinclude take one path argument;
// \import / \subimport / \subincludefrom take a directory and then a file.
const SINGLE_ARG_INCLUDES = /\\(?:input|include|subfile|subfileinclude)\s*\{([^}]*)\}/g;
const TWO_ARG_INCLUDES = /\\(?:sub)?(?:import|includefrom|inputfrom)\s*\*?\s*\{([^}]*)\}\s*\{([^}]*)\}/g;
// TeX also accepts \input without braces: "\input chapters/intro".
const BARE_INPUT = /\\input\s+([^\s{}\\%]+)/g;

// Returns include targets as written, relative to the including file's own
// directory (TeX resolves them that way for \import, and latexmk's -cd makes
// the plain forms behave the same in this app's builds).
const parseTexIncludes = (content) => {
  const text = stripTexComments(content);
  const results = [];
  const push = (value) => {
    const trimmed = String(value ?? "").trim();
    if (trimmed && !results.includes(trimmed)) {
      results.push(trimmed);
    }
  };
  for (const match of text.matchAll(SINGLE_ARG_INCLUDES)) {
    push(match[1]);
  }
  for (const match of text.matchAll(TWO_ARG_INCLUDES)) {
    const dir = String(match[1] ?? "").trim();
    const file = String(match[2] ?? "").trim();
    if (!file) {
      continue;
    }
    push(dir ? `${dir.replace(/\/+$/, "")}/${file}` : file);
  }
  for (const match of text.matchAll(BARE_INPUT)) {
    push(match[1]);
  }
  return results;
};

module.exports = {
  isStandaloneDocument,
  parseTexIncludes,
  stripTexComments,
};
