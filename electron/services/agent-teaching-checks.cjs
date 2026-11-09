/**
 * Deterministic checks for teaching material and Japanese typesetting.
 *
 * TeX64's documents are mostly Japanese study material: problem sets, exams,
 * worksheets and lecture notes, typeset with LuaLaTeX + luatexja / jlreq.
 * Two things go wrong there that a compiler never reports:
 *
 * - the teaching structure: a problem without its solution, 問1 問2 問4,
 *   sub-questions (1)(2)(4), points that no longer add up to the stated total;
 * - Japanese text conventions: mixed 、。 and ，．, full-width letters and
 *   digits, Japanese words set as math, italic units, \verb under jlreq.
 *
 * Both checks read the files the document map found, with comments removed
 * and literal spans (\verb, verbatim, \texttt, \url) set aside, and return
 * file:line locations. They never call a model.
 */

"use strict";

const MAX_ISSUES = 40;

// ---------------------------------------------------------------------------
// Character classes

const JAPANESE_CHAR = /[぀-ヿ㐀-䶿一-鿿豈-﫿々〆〇〻]/;
const JAPANESE_CHAR_G = /[぀-ヿ㐀-䶿一-鿿豈-﫿々〆〇〻]/g;
const FULLWIDTH_ALNUM = /[０-９Ａ-Ｚａ-ｚ]+/g;
const HALFWIDTH_KANA = /[｡-ﾟ]+/g;

const toHalfWidthDigits = (value) =>
  String(value).replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));

const KANJI_DIGITS = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const parseNumber = (raw) => {
  if (raw === undefined || raw === null) return null;
  const text = toHalfWidthDigits(String(raw)).trim();
  if (/^\d+$/.test(text)) return Number(text);
  if (/^[一二三四五六七八九十]+$/.test(text)) {
    if (text === "十") return 10;
    if (text.length === 1) return KANJI_DIGITS[text];
    if (text.length === 2 && text[0] === "十") return 10 + KANJI_DIGITS[text[1]];
    if (text.length === 2 && text[1] === "十") return KANJI_DIGITS[text[0]] * 10;
    if (text.length === 3 && text[1] === "十") return KANJI_DIGITS[text[0]] * 10 + KANJI_DIGITS[text[2]];
  }
  return null;
};

// ---------------------------------------------------------------------------
// Source preparation

/** Replace comments with spaces, keeping every character position. */
const blankComments = (content) => {
  const out = [];
  const lines = String(content).split(/\r?\n/);
  for (const line of lines) {
    let cut = line.length;
    for (let i = 0; i < line.length; i += 1) {
      if (line[i] === "\\") { i += 1; continue; }
      if (line[i] === "%") { cut = i; break; }
    }
    out.push(line.slice(0, cut) + " ".repeat(line.length - cut));
  }
  return out;
};

const MATH_ENVS = new Set([
  "equation", "align", "gather", "multline", "eqnarray", "flalign", "alignat", "math", "displaymath",
  "equation*", "align*", "gather*", "multline*", "eqnarray*", "flalign*", "alignat*",
]);
const LITERAL_ENVS = new Set([
  "verbatim", "verbatim*", "Verbatim", "lstlisting", "minted", "comment", "tcblisting", "filecontents",
  "filecontents*", "LVerbatim", "BVerbatim", "alltt",
  // TikZ coordinates use ($…$) for calc, which is not math.
  "tikzpicture", "pgfpicture", "circuitikz",
]);
const LITERAL_ARG_COMMANDS = new Set(["texttt", "url", "path", "href", "lstinline", "mintinline", "detokenize", "label", "ref", "eqref", "cite", "includegraphics", "input", "include", "usepackage", "graphicspath"]);
const TEXT_IN_MATH_COMMANDS = new Set([
  "text", "mbox", "textrm", "textup", "textnormal", "textbf", "textit", "textsf", "hbox", "intertext",
  "shortintertext", "textgt", "textmc", "mathrm", "operatorname", "label", "tag", "ce", "si", "SI", "qty", "unit",
]);

/**
 * Classify every character of the body as text, math, math-text (\text{} in
 * math) or other (commands, literal spans, preamble). Returns per-line masks
 * of the same length as the source lines: text characters kept in `text`,
 * math characters kept in `math`, everything else blanked.
 */
const classify = (content) => {
  const lines = blankComments(content);
  const joined = lines.join("\n");
  const n = joined.length;
  const kind = new Uint8Array(n); // 0 other, 1 text, 2 math, 3 text-in-math
  const region = new Uint8Array(n); // 1 inside a math region (delimiters excluded)
  let mathStart = -1;
  const openMath = (close, at) => { mathClose = close; mathStart = at; };
  const closeMath = (at) => { if (mathStart >= 0) region.fill(1, mathStart, at); mathClose = null; mathStart = -1; };
  const beginDoc = joined.search(/\\begin\s*\{document\}/);
  let i = beginDoc >= 0 ? beginDoc : 0;
  const hasDocument = beginDoc >= 0;
  const stack = []; // { mode: 'math', close: string|RegExp-like } ; text groups inside math: { mode: 'mtext', depth }
  let mathClose = null; // string that closes math, or {env}
  let mathTextDepth = 0; // brace depth of an open \text{ inside math (0 = none)
  let braceDepth = 0;

  const skipGroup = (start) => {
    // start at '{'; return index after the matching '}'
    let depth = 0;
    for (let j = start; j < n; j += 1) {
      const ch = joined[j];
      if (ch === "\\") { j += 1; continue; }
      if (ch === "{") depth += 1;
      else if (ch === "}") { depth -= 1; if (depth === 0) return j + 1; }
    }
    return n;
  };

  while (i < n) {
    const ch = joined[i];
    if (ch === "\\") {
      // \verb<d>…<d>
      const verb = /^\\verb\*?(.)/.exec(joined.slice(i, i + 8));
      if (verb && !/[a-zA-Z]/.test(verb[1])) {
        const end = joined.indexOf(verb[1], i + verb[0].length);
        i = end < 0 ? n : end + 1;
        continue;
      }
      const env = /^\\(begin|end)\s*\{([^}]+)\}/.exec(joined.slice(i, i + 60));
      if (env) {
        const [whole, which, name] = env;
        if (which === "begin" && LITERAL_ENVS.has(name)) {
          const endTag = new RegExp(`\\\\end\\s*\\{${name.replace(/\*/g, "\\*")}\\}`, "g");
          endTag.lastIndex = i + whole.length;
          const m = endTag.exec(joined);
          i = m ? m.index + m[0].length : n;
          continue;
        }
        if (!mathClose && which === "begin" && MATH_ENVS.has(name)) {
          openMath({ env: name }, i + whole.length);
          i += whole.length;
          continue;
        }
        if (mathClose && mathClose.env === name && which === "end") {
          closeMath(i);
          mathTextDepth = 0;
          i += whole.length;
          continue;
        }
        i += whole.length;
        continue;
      }
      if (!mathClose && joined.startsWith("\\[", i)) { openMath("\\]", i + 2); i += 2; continue; }
      if (!mathClose && joined.startsWith("\\(", i)) { openMath("\\)", i + 2); i += 2; continue; }
      if (mathClose && typeof mathClose === "string" && mathClose.startsWith("\\") && joined.startsWith(mathClose, i) && mathTextDepth === 0) {
        closeMath(i); i += 2; continue;
      }
      const cmd = /^\\([a-zA-Z@]+)\*?/.exec(joined.slice(i, i + 40));
      if (cmd) {
        const name = cmd[1];
        let j = i + cmd[0].length;
        if (!mathClose && LITERAL_ARG_COMMANDS.has(name)) {
          while (joined[j] === " ") j += 1;
          if (joined[j] === "{") { i = skipGroup(j); continue; }
        }
        if (mathClose && mathTextDepth === 0 && TEXT_IN_MATH_COMMANDS.has(name)) {
          while (joined[j] === " ") j += 1;
          if (joined[j] === "{") {
            const end = skipGroup(j);
            for (let k = j + 1; k < end - 1; k += 1) kind[k] = 3;
            i = end;
            continue;
          }
        }
        i = j;
        continue;
      }
      i += 2; // escaped character such as \$ \% \{ \,
      continue;
    }
    if (ch === "$") {
      if (!mathClose) {
        if (joined[i + 1] === "$") { openMath("$$", i + 2); i += 2; continue; }
        openMath("$", i + 1); i += 1; continue;
      }
      if (mathClose === "$$" && joined[i + 1] === "$") { closeMath(i); i += 2; continue; }
      if (mathClose === "$") { closeMath(i); i += 1; continue; }
    }
    if (ch === "{" ) braceDepth += 1;
    if (ch === "}") braceDepth = Math.max(0, braceDepth - 1);
    if (ch !== "\n") kind[i] = mathClose ? 2 : (hasDocument || beginDoc < 0 ? 1 : 0);
    i += 1;
  }

  const text = [];
  const math = [];
  let offset = 0;
  for (const line of lines) {
    let t = "";
    let m = "";
    for (let k = 0; k < line.length; k += 1) {
      const kk = kind[offset + k];
      t += kk === 1 ? line[k] : " ";
      // Outside math is \u0002, so a pattern never joins two separate formulas.
      m += kk === 2 ? line[k] : kk === 3 ? "\u0001" : region[offset + k] ? " " : "\u0002";
    }
    text.push(t);
    math.push(m);
    offset += line.length + 1;
  }
  return { lines, text, math, beginDocLine: hasDocument ? joined.slice(0, beginDoc).split("\n").length : 0 };
};

// ---------------------------------------------------------------------------
// Document profile (cheap, used by the document map)

const JAPANESE_CLASSES = /^(?:ltjs\w*|ltj\w*|jlreq|jlreq-\w+|bxjs\w*|js\w*|j\w*article|j\w*book|j\w*report|u\w*article|u\w*book|tarticle|tbook|treport|ujarticle|ujbook|ujreport)$/i;
const JAPANESE_PACKAGES = /\\usepackage\s*(?:\[[^\]]*\])?\s*\{[^}]*\b(?:luatexja|luatexja-preset|luatexja-fontspec|xeCJK|zxjatype|CJK|CJKutf8|bxjalipsum|pxjahyper)\b[^}]*\}/;

const LOCAL_STYLE_JAPANESE = /\\(?:RequirePackage|usepackage)\s*(?:\[[^\]]*\])?\s*\{[^}]*\b(?:luatexja|luatexja-preset|luatexja-fontspec|xeCJK)\b|\\LoadClass\s*(?:\[[^\]]*\])?\s*\{(?:ltjs|ltj|jlreq|bxjs)/;

/** Names of packages and the class the preamble loads (for finding the project's own .sty/.cls). */
const loadedStyleNames = (content) => {
  const preamble = String(content).split(/\\begin\s*\{document\}/)[0];
  const names = new Set();
  for (const m of preamble.matchAll(/\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g)) {
    m[1].split(",").map((name) => name.trim()).filter(Boolean).forEach((name) => names.add(`${name}.sty`));
  }
  const cls = documentClassOf(content);
  if (cls) names.add(`${cls}.cls`);
  return [...names];
};

// Packages and classes TeX Live ships that never set up Japanese by themselves.
const STANDARD_STYLES = new Set((
  "article report book letter amsart amsbook beamer exam memoir scrartcl scrreprt scrbook standalone "
  + "amsmath amssymb amsthm amsfonts mathtools mathrsfs bm physics siunitx mhchem chemfig graphicx graphics xcolor color "
  + "tikz pgf pgfplots tikz-cd circuitikz geometry hyperref url fancyhdr titlesec tocloft tcolorbox mdframed framed "
  + "enumitem enumerate booktabs array tabularx tabularray longtable multirow multicol float caption subcaption wrapfig "
  + "listings minted verbatim fancyvrb fontspec inputenc fontenc babel polyglossia lmodern microtype setspace "
  + "xparse etoolbox ifthen calc keyval kvoptions iftex ifluatex everypage eso-pic atbegshi lastpage "
  + "cleveref varioref natbib biblatex cite footmisc ulem soul comment xspace needspace paracol "
  + "emoji unicode-math newtxmath newtxtext stix2 libertinus").split(" "));

const documentClassOf = (content) => {
  const m = /\\documentclass\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/.exec(String(content));
  return m ? m[1].trim() : "";
};

// ---------------------------------------------------------------------------
// Teaching units

const PROBLEM_NAME = /^(?:problem|prob|exercise|exer|question|ques|mondai|toi|reidai|enshu|ensyu|renshu|practice|kadai|task|drill|toibox|mondaibox|problembox|exercisebox|questionbox)\*?$/i;
const SOLUTION_NAME = /^(?:solution|sol|answer|ans|kaitou|kaito|kaisetsu|kaisetu|kotae|answerbox|solutionbox|kaitoubox)\*?$/i;
const PROBLEM_TITLE = /(?:問題|設問|大問|例題|演習|練習|課題|^問$|Problem|Exercise|Question)/i;
const SOLUTION_TITLE = /(?:解答|解説|略解|答え|^解$|Solution|Answer)/i;

const ENV_DEFINITION =
  /\\(?:newtheorem\*?|newtcbtheorem|newtcolorbox|renewtcolorbox|NewTColorBox|DeclareTColorBox|RenewTColorBox|newenvironment|renewenvironment|NewDocumentEnvironment|DeclareDocumentEnvironment|newmdtheoremenv|declaretheorem)\s*(?:\[[^\]]*\])?\s*\{([A-Za-z@*]+)\}([^\n]*)/g;

/** Environment names that the document defines as problems or solutions. */
const collectUnitEnvironments = (sources) => {
  const problems = new Set();
  const solutions = new Set();
  for (const { content } of sources) {
    const clean = blankComments(content).join("\n");
    for (const m of clean.matchAll(ENV_DEFINITION)) {
      const name = m[1];
      const rest = m[2] || "";
      const title = (/^\s*(?:\[[^\]]*\]\s*)?\{([^}]*)\}/.exec(rest)?.[1] || /title\s*=\s*\{?([^,}\]]*)/.exec(rest)?.[1] || "").trim();
      if (SOLUTION_NAME.test(name) || (title && SOLUTION_TITLE.test(title))) solutions.add(name);
      else if (PROBLEM_NAME.test(name) || (title && PROBLEM_TITLE.test(title) && !/定理|定義|命題|補題|系|証明|Theorem|Definition|Lemma|Proof/i.test(title))) problems.add(name);
    }
  }
  return { problems, solutions };
};

const NUMBER_IN_TITLE = /(?:第\s*([0-9０-９一二三四五六七八九十]+)\s*問|(?:問題|設問|大問|例題|演習|練習|課題|問|解答|解説|略解|Problem|Exercise|Question|Solution|Answer|Q)\s*[.．:：]?\s*([0-9０-９]+|[一二三四五六七八九十]+)(?![0-9０-９]))/i;
const POINTS_PATTERN = /[（(［\[【]\s*(?:配点\s*[:：]?\s*)?([0-9０-９]+)\s*点\s*[）)］\]】]/;
const STATED_TOTAL_PATTERN = /(?:([0-9０-９]+)\s*点\s*満点|満点\s*[:：]?\s*([0-9０-９]+)\s*点?|配点\s*(?:の\s*)?(?:合計|総計|計)\s*[:：]?\s*([0-9０-９]+)\s*点)/;
const PROBLEM_MARKER =
  /^\s*(?:\\(?:section|subsection|subsubsection|paragraph|subparagraph)\*?\s*\{|\\(?:noindent|par|medskip|bigskip|smallskip)\s*)*(?:\\textbf\s*\{|\\textgt\s*\{|\\large\s*|\\bfseries\s*|[【［\[]\s*)*(第\s*[0-9０-９一二三四五六七八九十]+\s*問|問題?\s*[0-9０-９]+|(?:例題|演習|練習|設問)\s*[0-9０-９]+|(?:Problem|Exercise|Question)\s+[0-9]+)(?=\s|$|[}】］\].．:：　)）(（\\])/;
const SOLUTION_MARKER =
  /^\s*(?:\\(?:section|subsection|subsubsection|paragraph|subparagraph)\*?\s*\{|\\(?:noindent|par|medskip|bigskip|smallskip)\s*)*(?:\\textbf\s*\{|\\textgt\s*\{|\\large\s*|\\bfseries\s*|[【［\[]\s*)*((?:解答|解説|略解|答え|Solution|Answer)(?:\s*[0-9０-９]+)?)\s*(?:[】］\]}]|$|[ 　:：．.])/;
const SUBQUESTION_PATTERN = /^\s*(?:\\item\s*(?:\[\s*)?)?[（(]\s*([0-9０-９]+)\s*[)）]/;

/**
 * Teaching units in document order across all files: problems and solutions,
 * with their explicit number (if any), points, and body range.
 */
const collectUnits = (sources) => {
  const envs = collectUnitEnvironments(sources);
  // Fallback names that packages and common classes provide.
  ["problem", "exercise", "question", "mondai", "toi", "reidai", "enshu", "practice"].forEach((name) => {
    if (!envs.solutions.has(name)) envs.problems.add(name);
  });
  ["solution", "answer", "kaitou", "kaisetsu"].forEach((name) => envs.solutions.add(name));
  const units = [];
  const statedTotals = [];
  let examQuestions = 0;
  for (const source of sources) {
    const { lines } = classify(source.content);
    lines.forEach((line, index) => {
      const lineNumber = index + 1;
      const total = STATED_TOTAL_PATTERN.exec(line);
      if (total) {
        const value = parseNumber(total[1] || total[2] || total[3]);
        if (value) statedTotals.push({ value, file: source.path, line: lineNumber });
      }
      for (const m of line.matchAll(/\\begin\s*\{([A-Za-z@*]+)\}\s*(\[[^\]]*\]|\{[^}]*\})?/g)) {
        const name = m[1];
        const title = (m[2] || "").slice(1, -1);
        const kindOf = envs.solutions.has(name) || (name === "proof" && SOLUTION_TITLE.test(title))
          ? "solution"
          : envs.problems.has(name) ? "problem" : null;
        if (!kindOf) continue;
        const num = NUMBER_IN_TITLE.exec(title);
        const points = POINTS_PATTERN.exec(title + line.slice(m.index + m[0].length));
        units.push({
          kind: kindOf, via: `\\begin{${name}}`, env: name, title: title.trim(), file: source.path, line: lineNumber,
          number: num ? parseNumber(num[1] || num[2]) : null, points: points ? parseNumber(points[1]) : null,
        });
      }
      // exam class: \question[10]
      const q = /\\question\s*(?:\[\s*([0-9]+)\s*\])?/.exec(line);
      if (q && /\\question\b/.test(line)) {
        examQuestions += 1;
        units.push({ kind: "problem", via: "\\question", file: source.path, line: lineNumber, number: null, points: q[1] ? Number(q[1]) : null, title: "" });
      }
    });
  }
  // Without environments, look for heading or bold markers such as 問1 / 【解答】.
  const envUnits = units.length;
  if (envUnits === 0) {
    for (const source of sources) {
      const { lines } = classify(source.content);
      lines.forEach((line, index) => {
        const lineNumber = index + 1;
        const p = PROBLEM_MARKER.exec(line);
        const s = !p && SOLUTION_MARKER.exec(line);
        if (p) {
          const num = NUMBER_IN_TITLE.exec(p[1]);
          const points = POINTS_PATTERN.exec(line);
          units.push({ kind: "problem", via: "marker", title: p[1].trim(), file: source.path, line: lineNumber, number: num ? parseNumber(num[1] || num[2]) : null, points: points ? parseNumber(points[1]) : null });
        } else if (s) {
          const num = NUMBER_IN_TITLE.exec(s[1]);
          units.push({ kind: "solution", via: "marker", title: s[1].trim(), file: source.path, line: lineNumber, number: num ? parseNumber(num[1] || num[2]) : null, points: null });
        }
      });
    }
  }
  // A bare 解答 heading over numbered 解答1, 解答2… is the solutions part, not a solution.
  const numberedMarkerSolutions = units.some((u) => u.via === "marker" && u.kind === "solution" && u.number !== null);
  const kept = numberedMarkerSolutions ? units.filter((u) => !(u.via === "marker" && u.kind === "solution" && u.number === null)) : units;
  return { units: kept, statedTotals, examQuestions, environments: { problems: [...envs.problems], solutions: [...envs.solutions] } };
};

/** Lines between a unit and the next unit (same file), used for sub-questions and empty bodies. */
const unitBodies = (sources, units) => {
  const byFile = new Map(sources.map((s) => [s.path, classify(s.content).lines]));
  return units.map((unit, i) => {
    const lines = byFile.get(unit.file) || [];
    const next = units.slice(i + 1).find((u) => u.file === unit.file);
    const endLine = next ? next.line - 1 : lines.length;
    return { unit, lines: lines.slice(unit.line - 1, endLine), startLine: unit.line };
  });
};

const pushIssue = (issues, issue) => {
  issues.push(issue);
};

const checkSequence = (items, label, issues) => {
  // items: [{ number, file, line }] with numbers; runs restart when a 1 follows a larger number.
  const runs = [];
  let current = [];
  for (const item of items) {
    if (current.length && item.number === 1 && current[current.length - 1].number >= 1) {
      runs.push(current);
      current = [];
    }
    current.push(item);
  }
  if (current.length) runs.push(current);
  for (const run of runs) {
    let expected = run[0].number;
    if (expected !== 1 && runs.length === 1) {
      pushIssue(issues, { rule: "numbering-start", severity: "warning", file: run[0].file, line: run[0].line, message: `${label} numbering starts at ${run[0].number}, not 1.` });
    }
    const seen = new Set();
    for (const item of run) {
      if (seen.has(item.number)) {
        pushIssue(issues, { rule: "numbering-duplicate", severity: "warning", file: item.file, line: item.line, message: `${label} ${item.number} appears twice.` });
        continue;
      }
      if (item.number > expected) {
        const missing = [];
        for (let k = expected; k < item.number && missing.length < 5; k += 1) missing.push(k);
        pushIssue(issues, { rule: "numbering-gap", severity: "warning", file: item.file, line: item.line, message: `${label} ${missing.join(", ")} missing before ${label} ${item.number}.` });
      } else if (item.number < expected) {
        pushIssue(issues, { rule: "numbering-order", severity: "warning", file: item.file, line: item.line, message: `${label} ${item.number} comes after ${label} ${expected - 1}.` });
      }
      seen.add(item.number);
      expected = Math.max(expected, item.number + 1);
    }
  }
};

/**
 * Problem/solution structure. sources: [{ path, content }] in document order.
 */
const checkExercisesInSources = (sources) => {
  const { units, statedTotals, environments } = collectUnits(sources);
  const issues = [];
  const problems = units.filter((u) => u.kind === "problem");
  const solutions = units.filter((u) => u.kind === "solution");
  if (problems.length === 0) {
    return {
      problems: 0, solutions: solutions.length, layout: "none", issues: [],
      note: "No problems found (looked for problem/exercise/question-like environments, \\question, and 問1 / 第1問 / 例題1 / Problem 1 markers).",
      environments,
    };
  }

  // Layout: interleaved (problem, solution, problem, solution…) or grouped (all solutions after the problems).
  const firstSolutionIndex = units.findIndex((u) => u.kind === "solution");
  const lastProblemIndex = units.map((u) => u.kind).lastIndexOf("problem");
  let layout = "none";
  if (solutions.length > 0) layout = firstSolutionIndex > lastProblemIndex ? "grouped" : "interleaved";

  if (layout === "interleaved") {
    units.forEach((unit, i) => {
      if (unit.kind !== "problem") return;
      const next = units[i + 1];
      if (!next || next.kind === "problem") {
        pushIssue(issues, { rule: "problem-without-solution", severity: "warning", file: unit.file, line: unit.line, message: `${unit.title || unit.via} has no solution before ${next ? "the next problem" : "the end of the document"}.` });
      }
    });
    units.forEach((unit, i) => {
      if (unit.kind === "solution" && i > 0 && units[i - 1].kind === "solution") {
        pushIssue(issues, { rule: "solution-without-problem", severity: "warning", file: unit.file, line: unit.line, message: `${unit.title || unit.via} follows another solution, not a problem.` });
      }
    });
  } else if (layout === "grouped" && problems.length !== solutions.length) {
    pushIssue(issues, {
      rule: "count-mismatch", severity: "warning", file: solutions[0].file, line: solutions[0].line,
      message: `${problems.length} problems but ${solutions.length} solutions in the solutions part.`,
    });
  }

  // Explicit numbers.
  const numberedProblems = problems.filter((u) => u.number !== null);
  if (numberedProblems.length >= 2) checkSequence(numberedProblems, "Problem", issues);
  const numberedSolutions = solutions.filter((u) => u.number !== null);
  if (numberedSolutions.length >= 2) checkSequence(numberedSolutions, "Solution", issues);
  if (numberedProblems.length && numberedSolutions.length) {
    const problemSet = new Set(numberedProblems.map((u) => u.number));
    for (const s of numberedSolutions) {
      if (!problemSet.has(s.number)) {
        pushIssue(issues, { rule: "solution-number-mismatch", severity: "warning", file: s.file, line: s.line, message: `Solution ${s.number} has no problem with that number.` });
      }
    }
  }

  // Sub-questions (1)(2)(3) inside each problem, and empty solutions.
  for (const { unit, lines, startLine } of unitBodies(sources, units)) {
    if (unit.kind === "problem") {
      const subs = [];
      lines.forEach((line, k) => {
        const m = SUBQUESTION_PATTERN.exec(line);
        if (m) subs.push({ number: parseNumber(m[1]), file: unit.file, line: startLine + k });
      });
      if (subs.length >= 2) checkSequence(subs, `Sub-question in ${unit.title || `the problem at line ${unit.line}`}`, issues);
    } else {
      const body = lines.slice(1).join("\n").replace(/\\end\s*\{[^}]+\}/g, "").replace(/<[^>]*ここに[^>]*>|TODO|\\ldots|…/g, "").trim();
      const sameLineBody = lines[0].replace(/^.*?\\begin\s*\{[^}]+\}\s*(\[[^\]]*\])?/, "").replace(/\\end\s*\{[^}]+\}.*/, "").trim();
      if (!body && !sameLineBody && unit.via.startsWith("\\begin")) {
        pushIssue(issues, { rule: "empty-solution", severity: "warning", file: unit.file, line: unit.line, message: `${unit.title || unit.via} is empty.` });
      }
    }
  }

  // Points.
  const pointed = problems.filter((u) => u.points !== null);
  let points = null;
  if (pointed.length > 0) {
    const sum = pointed.reduce((acc, u) => acc + u.points, 0);
    points = { sum, perProblem: pointed.map((u) => ({ line: u.line, file: u.file, points: u.points })) };
    if (pointed.length < problems.length) {
      pushIssue(issues, { rule: "points-missing", severity: "warning", file: problems.find((u) => u.points === null).file, line: problems.find((u) => u.points === null).line, message: `${problems.length - pointed.length} of ${problems.length} problems have no points while the others do.`, fix: "Ask for the missing points; do not invent them." });
    }
    const stated = statedTotals[0];
    if (stated) {
      points.stated = stated.value;
      if (stated.value !== sum) {
        pushIssue(issues, {
          rule: "points-total", severity: "warning", file: stated.file, line: stated.line,
          message: `Points add up to ${sum}, but the document states ${stated.value}.`,
          fix: "Points are the teacher's decision: do not change any value to make them add up. Finish the fixes that need no decision first, then report the mismatch or ask (ask_user) which problem's points to change.",
        });
      }
    }
  }

  return {
    problems: problems.length,
    solutions: solutions.length,
    layout,
    issues: issues.slice(0, MAX_ISSUES),
    truncated: issues.length > MAX_ISSUES,
    points,
    units: units.slice(0, 60).map((u) => ({ kind: u.kind, file: u.file, line: u.line, ...(u.number !== null ? { number: u.number } : {}), ...(u.points !== null ? { points: u.points } : {}), ...(u.title ? { title: u.title.slice(0, 40) } : {}) })),
    environments,
  };
};

// ---------------------------------------------------------------------------
// Japanese text

const UNIT_IN_MATH = /(?:^|[^\\a-zA-Z])(\d+(?:\.\d+)?)\s*(?:\\[,;:!]|~|\s)?\s*(km|cm|mm|nm|μm|kg|mg|mol|mL|ml|kHz|MHz|Hz|kPa|hPa|Pa|kJ|kW|kV|mA|mV|J|W|N|V|A|K|L|s|m|g)(?![a-zA-Z])/g;

/**
 * Japanese text conventions. options.localStyles: contents of the project's own
 * .sty/.cls files the preamble loads, so a house package that loads luatexja counts.
 */
const checkJapaneseInSources = (sources, options = {}) => {
  const issues = [];
  const counts = {};
  const add = (issue) => {
    counts[issue.rule] = (counts[issue.rule] || 0) + 1;
    issues.push(issue);
  };
  const main = sources[0];
  const docClass = main ? documentClassOf(main.content) : "";
  const preamble = main ? String(main.content).split(/\\begin\s*\{document\}/)[0] : "";
  const localStyleEntries = Array.isArray(options.localStyles) ? options.localStyles : [];
  const localStyles = localStyleEntries.map((entry) => (typeof entry === "string" ? entry : entry?.content || ""));
  const foundNames = new Set(localStyleEntries.map((entry) => (typeof entry === "string" ? "" : entry?.name || "")).filter(Boolean));
  const unresolved = main ? loadedStyleNames(main.content).filter((name) => !foundNames.has(name) && !STANDARD_STYLES.has(name.replace(/\.(?:sty|cls)$/, ""))) : [];
  const japaneseClass = JAPANESE_CLASSES.test(docClass) || JAPANESE_PACKAGES.test(preamble)
    || localStyles.some((style) => LOCAL_STYLE_JAPANESE.test(String(style)));
  // The \verb trap is jlreq's (luatexja + jlreq line layout); ltjs* classes are fine.
  const jlreqLike = /^jlreq/i.test(docClass) || localStyles.some((style) => /\\LoadClass\s*(?:\[[^\]]*\])?\s*\{jlreq/.test(String(style)));

  let japaneseChars = 0;
  const punct = { touten: [], kuten: [], fwComma: [], fwPeriod: [] };
  const perFile = sources.map((source) => ({ source, classified: classify(source.content) }));

  for (const { source, classified } of perFile) {
    classified.text.forEach((text, index) => {
      const line = index + 1;
      const raw = classified.lines[index];
      const jp = text.match(JAPANESE_CHAR_G);
      if (jp) japaneseChars += jp.length;
      for (const ch of text) {
        const at = { file: source.path, line, excerpt: raw.trim().slice(0, 30) };
        if (ch === "、") punct.touten.push(at);
        else if (ch === "。") punct.kuten.push(at);
        else if (ch === "，") punct.fwComma.push(at);
        else if (ch === "．") punct.fwPeriod.push(at);
      }
      // ASCII , or . right after Japanese text.
      for (const m of text.matchAll(/([぀-ヿ一-鿿）」』])([,.])(?=\s|$|[぀-ヿ一-鿿])/g)) {
        add({ rule: "ascii-punctuation", severity: "warning", file: source.path, line, excerpt: raw.slice(Math.max(0, m.index - 6), m.index + 4).trim(), fix: m[2] === "," ? "Use 、 (or ， if the document uses ，．)." : "Use 。 (or ． if the document uses ，．)." });
      }
      for (const m of text.matchAll(FULLWIDTH_ALNUM)) {
        add({ rule: "fullwidth-alnum", severity: "style", file: source.path, line, excerpt: m[0], fix: `Write half-width "${m[0].replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))}"; luatexja spaces it from Japanese automatically.` });
      }
      for (const m of text.matchAll(HALFWIDTH_KANA)) {
        add({ rule: "halfwidth-kana", severity: "warning", file: source.path, line, excerpt: m[0], fix: "Use full-width katakana." });
      }
      if (/^\s*　/.test(raw) && /　/.test(text)) {
        add({ rule: "fullwidth-space-indent", severity: "style", file: source.path, line, excerpt: raw.slice(0, 12), fix: "Remove the typed full-width space; paragraphs are indented by \\parindent (1zw)." });
      }
      if (/\.\.\./.test(text)) {
        add({ rule: "ascii-ellipsis", severity: "style", file: source.path, line, excerpt: text.trim().slice(0, 30), fix: "Use \\ldots in Latin text, …… (two U+2026) in Japanese text." });
      }
      for (const m of text.matchAll(/(?:"|``)([^"']*?[぀-ヿ一-鿿][^"']*?)(?:"|'')/g)) {
        add({ rule: "ascii-quotes", severity: "style", file: source.path, line, excerpt: m[0].slice(0, 30), fix: "Use 「…」 for Japanese quotations." });
      }
    });
    classified.math.forEach((math, index) => {
      const line = index + 1;
      const raw = classified.lines[index];
      if (JAPANESE_CHAR.test(math)) {
        const word = math.match(/[぀-ヿ㐀-鿿]+/)?.[0] || "";
        add({ rule: "japanese-in-math", severity: "style", file: source.path, line, excerpt: word, fix: `Wrap Japanese words in math with \\text{${word}} so they get text spacing and font.` });
      }
      for (const m of math.matchAll(UNIT_IN_MATH)) {
        // "2m" is as likely 2 times m as two metres; only a spaced single-letter unit counts.
        if (m[2].length === 1 && !/\s$/.test(m[0].slice(0, m[0].length - 1))) continue;
        add({ rule: "italic-unit", severity: "style", file: source.path, line, excerpt: `${m[1]} ${m[2]}`, fix: `Units are upright: ${m[1]}\\,\\mathrm{${m[2]}} (or \\qty{${m[1]}}{${m[2]}} with siunitx).` });
      }
      if (/\$\$/.test(raw.replace(/\\\$/g, ""))) {
        add({ rule: "display-dollars", severity: "warning", file: source.path, line, excerpt: "$$", fix: "Use \\[ … \\] (or equation*) instead of $$ … $$." });
      }
    });
    if (jlreqLike) {
      classified.lines.forEach((raw, index) => {
        if (index + 1 <= classified.beginDocLine) return;
        if (/\\verb\*?[^a-zA-Z\s]/.test(raw)) {
          add({ rule: "verb-with-jlreq", severity: "warning", file: source.path, line: index + 1, excerpt: raw.trim().slice(0, 30), fix: "\\verb disturbs jlreq's line layout near headings; use \\texttt{…} (escape \\_ \\# \\&)." });
        }
      });
    }
    // tcolorbox/theorem option values with a half-width comma or = in Japanese text.
    classified.lines.forEach((raw, index) => {
      for (const m of raw.matchAll(/title\s*=\s*([^{\]][^\]]*)/g)) {
        const value = m[1];
        const cut = value.search(/,\s*[a-z]+\s*=/i);
        const titleValue = cut >= 0 ? value.slice(0, cut) : value;
        if (JAPANESE_CHAR.test(titleValue) && /[,=]/.test(titleValue)) {
          add({ rule: "pgfkeys-comma", severity: "warning", file: source.path, line: index + 1, excerpt: titleValue.slice(0, 30), fix: "A half-width , or = in an unbraced title= value splits the key list (pgfkeys error); use 、 or wrap the value in {…}." });
        }
      }
    });
  }

  if (japaneseChars > 0 && !japaneseClass && unresolved.length > 0) {
    add({ rule: "class-not-japanese", severity: "warning", file: main?.path || "", line: 1, excerpt: docClass ? `\\documentclass{${docClass}}` : "", fix: `No Japanese setup is visible. Unless ${unresolved.slice(0, 4).join(", ")} (not in this project) loads luatexja, use ltjsarticle/jlreq with LuaLaTeX or \\usepackage{luatexja}; the log's "Missing character" lines decide.` });
  } else if (japaneseChars > 0 && !japaneseClass) {
    add({ rule: "class-not-japanese", severity: "error", file: main?.path || "", line: 1, excerpt: docClass ? `\\documentclass{${docClass}}` : "", fix: "Japanese text needs a Japanese-capable setup: \\documentclass{ltjsarticle} (or jlreq) with LuaLaTeX, or \\usepackage{luatexja}. Otherwise the characters are silently dropped (Missing character)." });
  }

  // Punctuation style: report the minority style.
  const japaneseStyle = punct.touten.length + punct.kuten.length;
  const westernStyle = punct.fwComma.length + punct.fwPeriod.length;
  let punctuationStyle = null;
  if (japaneseStyle || westernStyle) {
    punctuationStyle = westernStyle > japaneseStyle ? "，．" : "、。";
    const minority = punctuationStyle === "、。" ? [...punct.fwComma, ...punct.fwPeriod] : [...punct.touten, ...punct.kuten];
    // Mixed 、． or ，。 pairs are a style of their own (、． is common in science texts).
    const mixedPairStyle = (punct.touten.length && punct.fwPeriod.length && !punct.kuten.length && !punct.fwComma.length)
      || (punct.fwComma.length && punct.kuten.length && !punct.touten.length && !punct.fwPeriod.length);
    if (!mixedPairStyle) {
      for (const at of minority.slice(0, 10)) {
        add({ rule: "mixed-punctuation", severity: "warning", file: at.file, line: at.line, excerpt: at.excerpt, fix: `The document mostly uses ${punctuationStyle}; use it here too.` });
      }
      if (minority.length > 10) counts["mixed-punctuation"] = minority.length;
    } else {
      punctuationStyle = punct.touten.length ? "、．" : "，。";
    }
  }

  const severityRank = { error: 0, warning: 1, style: 2 };
  issues.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);
  return {
    japanese: japaneseChars > 0,
    documentClass: docClass,
    japaneseSetup: japaneseClass,
    punctuationStyle,
    counts,
    issues: issues.slice(0, MAX_ISSUES),
    truncated: issues.length > MAX_ISSUES,
  };
};

// ---------------------------------------------------------------------------
// Map integration

/** Cheap per-file facts for the document map (no masks kept). */
const profileTexContent = (content) => {
  const text = String(content);
  const body = text.split(/\\begin\s*\{document\}/)[1] ?? text;
  const japaneseChars = (body.match(JAPANESE_CHAR_G) || []).length;
  return {
    documentClass: documentClassOf(text),
    japaneseChars,
    japaneseSetup: JAPANESE_CLASSES.test(documentClassOf(text)) || JAPANESE_PACKAGES.test(text.split(/\\begin\s*\{document\}/)[0] || ""),
  };
};

/** One line for the DOCUMENT MAP saying what kind of document this is. */
const describeProfile = (sources) => {
  if (!sources.length) return "";
  const main = profileTexContent(sources[0].content);
  const japaneseChars = sources.reduce((acc, s) => acc + profileTexContent(s.content).japaneseChars, 0);
  const { units } = collectUnits(sources);
  const problems = units.filter((u) => u.kind === "problem").length;
  const solutions = units.filter((u) => u.kind === "solution").length;
  const parts = [];
  if (japaneseChars > 0) parts.push(`Japanese text${main.documentClass ? ` (${main.documentClass}${main.japaneseSetup ? "" : ", no Japanese setup"})` : ""}`);
  if (problems > 0) parts.push(`teaching material: ${problems} problem${problems === 1 ? "" : "s"}, ${solutions} solution${solutions === 1 ? "" : "s"}`);
  if (!parts.length) return "";
  const tools = [problems > 0 ? "check_exercises" : "", japaneseChars > 0 ? "check_japanese_text" : ""].filter(Boolean).join(" / ");
  return `profile: ${parts.join("; ")}${tools ? ` — verify with ${tools}` : ""}`;
};

/** Read the map's .tex files in order. */
const readMapSources = async (service, map, readWorkspaceText) => {
  const sources = [];
  for (const file of map?.files || []) {
    const content = await readWorkspaceText(service, file.path);
    if (typeof content === "string") sources.push({ path: file.path, content });
  }
  return sources;
};

// ---------------------------------------------------------------------------
// Build issue hints: the causes of luatexja / jlreq / tcolorbox failures that
// the log names only indirectly (collected from TeX64's typesetting server).

const TYPESETTING_HINTS = [
  [/I do not know the key/i, "A half-width , or = inside an optional-argument value (tcolorbox or theorem title=…) splits the pgfkeys list. Write 、 instead, or wrap the whole value in {…}."],
  [/Missing character: There is no .+ in font nullfont/i, "Latin letters typeset in a box built inside tikzpicture (\\sbox/\\setbox) fall into nullfont. Build the box before \\begin{tikzpicture} and only \\usebox it inside."],
  [/Missing character: There is no/i, "The glyph was silently dropped from the PDF. Japanese needs ltjsarticle/jlreq with LuaLaTeX (or \\usepackage{luatexja}); emoji and rare kanji need a font that has them."],
  [/headheight is too small/i, "Give the header room (geometry headheight=17pt or larger); otherwise the text block shifts from page to page."],
  [/Token not allowed in a PDF string/i, "Harmless bookmark warning. Use \\texorpdfstring{<TeX>}{<plain text>} in the heading to silence it."],
  [/ISO B/i, "jlreq's b5 is ISO B5 (176×250 mm). For JIS B5 use paper={182mm,257mm}; the warning is otherwise harmless."],
  [/Environment ([A-Za-z@*]+) undefined/i, "Define the environment in the preamble (\\newtheorem, \\newtcolorbox) or load the package that provides it; keep the name the rest of the document uses."],
  [/File `([^']+)' not found/i, "The file or package is not available. For a package, use one TeX Live ships (check the name); for an included file, check the path relative to the main file."],
];

/** One-line cause for a build issue message, when it is a known trap. */
const typesettingHint = (message) => {
  const text = String(message || "");
  for (const [pattern, hint] of TYPESETTING_HINTS) {
    if (pattern.test(text)) return hint;
  }
  return "";
};

module.exports = {
  typesettingHint,
  loadedStyleNames,
  classify,
  collectUnits,
  checkExercisesInSources,
  checkJapaneseInSources,
  profileTexContent,
  describeProfile,
  readMapSources,
  parseNumber,
};
