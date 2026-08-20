import test from "node:test";
import assert from "node:assert/strict";
import { cleanIssueMessage, diagnoseIssue } from "../Resources/web/app/issue-diagnosis.js";

const error = (message) => ({ severity: "error", message });
const warning = (message) => ({ severity: "warning", message });

// Real latexmk/LuaTeX log lines, as parseIssues hands them to the panel.
const corpus = [
  [error("! LaTeX Error: File `l3backend-luatex.def' not found."), "Missing file", /l3backend-luatex\.def/, /Settings > Environment/],
  [error("! LaTeX Error: File `tikz.sty' not found."), "Missing file", /tikz\.sty/, /Settings > Environment/],
  [error("! LaTeX Error: File `figures/plot.png' not found."), "Missing file", /figures\/plot\.png/, /where the document expects/],
  [error("! Undefined control sequence."), "Unknown command", /does not know/, /usepackage/],
  [error("! Missing $ inserted."), "Math mode needed", /only works inside math/, /\$ \.\.\. \$/],
  [error("! Missing } inserted."), "Braces do not match", /\{ and \}/, /closing/],
  [error("! Extra }, or forgotten $."), "Braces do not match", /\{ and \}/, /closing/],
  [error("! Too many }'s."), "Braces do not match", /\{ and \}/, /closing/],
  [error("! LaTeX Error: \\begin{itemize} on input line 12 ended by \\end{enumerate}."), "Environment does not close", /\\begin\{itemize\}[\s\S]*\\end\{enumerate\}/, /nesting/],
  [error("! LaTeX Error: Environment tikzpicture undefined."), "Unknown environment", /tikzpicture/, /usepackage/],
  [error("! LaTeX Error: Option clash for package xcolor."), "Conflicting package options", /xcolor is loaded twice/, /one place/],
  [error("! LaTeX Error: Command \\vec already defined."), "Name already taken", /\\vec is already defined/, /renewcommand/],
  [error("! LaTeX Error: Missing \\begin{document}."), "Text before the document starts", /begin\{document\}/, /below/],
  [error("Runaway argument?"), "Argument never closes", /left open/, /blank line/],
  [error("! Paragraph ended before \\textbf was complete."), "Argument never closes", /left open/, /blank line/],
  [error("! File ended while scanning use of \\frac ."), "Argument never closes", /left open/, /blank line/],
  [error("! Missing number, treated as zero."), "A number was expected", /needs a number/, /10pt/],
  [error("! LaTeX Error: There's no line here to end."), "Stray line break", /no line to break/, /blank line/],
  [error("! Emergency stop."), "Build gave up", /earlier error/, /first error/],
  [error("! Package inputenc Error: Unicode character 日 (U+65E5) not set up for use with LaTeX."), "Character not supported", /cannot typeset this character/, /luatexja/],
  [error("! Package tikz Error: Giving up on this path. Did you forget a semicolon?"), "Error from the tikz package", /forget a semicolon/, /how tikz is used/],
  [error("! Class revtex4-2 Error: No type size specified."), "Error from the revtex4-2 class", /No type size specified/, /documentclass\{revtex4-2\}/],
  [warning("LaTeX Warning: Citation `knuth1984' on page 1 undefined on input line 30."), "Citation not resolved", /knuth1984/, /\.bib/],
  [warning("LaTeX Warning: Reference `sec:intro' on page 2 undefined on input line 55."), "Cross-reference not resolved", /sec:intro/, /label/i],
  [warning("LaTeX Warning: Label `fig:a' multiply defined."), "Duplicate label", /fig:a/, /unique/],
  [warning("Overfull \\hbox (12.3pt too wide) in paragraph at lines 10--12"), "Text runs past the margin", /wider than the text area/, /ignore/],
  [warning("Underfull \\hbox (badness 10000) in paragraph at lines 3--5"), "Loose spacing", /stretched/, /ignore/],
];

test("every catalogued log line gets a plain-language kind, summary and fix", () => {
  for (const [issue, kind, summary, fix] of corpus) {
    const diagnosis = diagnoseIssue(issue);
    assert.equal(diagnosis.kind, kind, `wrong kind for: ${issue.message}`);
    assert.match(diagnosis.summary, summary, `wrong summary for: ${issue.message}`);
    assert.match(diagnosis.fix, fix, `wrong fix for: ${issue.message}`);
  }
});

test("nothing a reader sees is raw log punctuation", () => {
  for (const [issue] of corpus) {
    const { kind, summary, fix } = diagnoseIssue(issue);
    for (const [label, text] of [["kind", kind], ["summary", summary], ["fix", fix]]) {
      assert.ok(text.trim().length > 0, `empty ${label} for: ${issue.message}`);
      assert.ok(!text.startsWith("!"), `${label} still starts with the log's "!": ${text}`);
      assert.ok(
        !/^(LaTeX|pdfTeX|LuaTeX) (Error|Warning):/.test(text),
        `${label} still carries the log prefix: ${text}`
      );
    }
  }
});

test("the missing-glyph message the build service writes is classified, not echoed blindly", () => {
  const diagnosis = diagnoseIssue(
    error("The PDF cannot display the character 日 (U+65E5). The current font lmroman10-regular has no glyph for it.")
  );
  assert.equal(diagnosis.kind, "Font has no such character");
  assert.match(diagnosis.summary, /日 \(U\+65E5\)/, "the summary lost the character it is about");
  assert.match(diagnosis.summary, /lmroman10-regular/, "the summary lost the font name");
  assert.ok(
    !/Use a Unicode-aware/.test(diagnosis.summary),
    `the advice tail belongs in fix, not summary: ${diagnosis.summary}`
  );
  assert.match(diagnosis.fix, /document class or font/);
});

test("unrecognized issues fall back to the app-level resolution rather than nothing", () => {
  const diagnosis = diagnoseIssue(error("latexmk was not found on this machine."));
  assert.equal(diagnosis.kind, "Build error");
  assert.match(diagnosis.summary, /latexmk/);
  assert.match(diagnosis.fix, /Settings > Environment/);
});

test("a warning with no matching rule still reads as advice", () => {
  const diagnosis = diagnoseIssue(warning("Something the parser has never seen."));
  assert.equal(diagnosis.kind, "Warning");
  assert.ok(diagnosis.fix.length > 0);
});

test("cleanIssueMessage strips the log's own punctuation", () => {
  assert.equal(cleanIssueMessage("!  LaTeX Error: Environment foo undefined."), "Environment foo undefined.");
  assert.equal(cleanIssueMessage("LaTeX Warning: Citation `a' undefined."), "Citation `a' undefined.");
  assert.equal(cleanIssueMessage("  Overfull \\hbox  "), "Overfull \\hbox");
});
