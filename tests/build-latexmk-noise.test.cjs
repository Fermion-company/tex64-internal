const assert = require("node:assert/strict");
const test = require("node:test");

const { BuildService } = require("../electron/services/build.cjs");

// latexmk narrates its own run around the real compiler output.
const noisyLog = String.raw`(./main.tex
LaTeX Warning: Reference ` + "`sec:nowhere'" + String.raw` on page 1 undefined on input line 10.
./main.tex:18: Package luatex.def Error: File ` + "`no-such-image.png'" + String.raw` not found.
Latexmk: Missing input file 'no-such-image.png' message in .log file:
  LaTeX Warning: File ` + "`no-such-image.png'" + String.raw` not found on input line 18.
Latexmk: Summary of warnings from last run of *latex:
Latexmk: Errors, so I did not complete making targets
`;

test("latexmk's own narration never becomes an issue card", () => {
  const issues = new BuildService().parseIssues(noisyLog, "/tmp/workspace");
  const fromLatexmk = issues.filter((issue) => /^\s*latexmk:/i.test(issue.message));
  assert.deepEqual(
    fromLatexmk,
    [],
    `latexmk meta lines leaked into the panel: ${JSON.stringify(fromLatexmk, null, 2)}`
  );
});

test("filtering the narration does not swallow the real issues under it", () => {
  const issues = new BuildService().parseIssues(noisyLog, "/tmp/workspace");
  assert.ok(
    issues.some((issue) => /Reference/.test(issue.message)),
    "the undefined reference went missing"
  );
  assert.ok(
    issues.some((issue) => /no-such-image\.png/.test(issue.message)),
    "the missing image went missing"
  );
});

test("a summary line on its own produces no issues at all", () => {
  const issues = new BuildService().parseIssues(
    "Latexmk: Summary of warnings from last run of *latex:\n",
    "/tmp/workspace"
  );
  assert.deepEqual(issues, []);
});

// -file-line-error prefixes every error with "./file:line:", and TeX names
// distribution files constantly while loading packages. Both used to send the
// panel somewhere useless.
const prefixedLog = String.raw`(./main.tex (/usr/local/texlive/2026/texmf-dist/tex/generic/xkeyval/keyval.tex
LaTeX Warning: Reference ` + "`sec:nowhere'" + String.raw` on page 1 undefined on input line 23.
./main.tex:31: Package luatex.def Error: File ` + "`no-such-image.png'" + String.raw` not found.
`;

test("an error arriving with the -file-line-error prefix is still an error", () => {
  const issues = new BuildService().parseIssues(prefixedLog, "/tmp/workspace");
  const packageError = issues.find((issue) => /luatex\.def Error/.test(issue.message));
  assert.ok(packageError, "the prefixed package error was not detected at all");
  assert.equal(packageError.severity, "error", "a fatal package error was downgraded");
  assert.equal(packageError.path, "main.tex");
  assert.equal(packageError.line, 31);
});

test("issues are never attributed to a TeX Live file the user cannot fix", () => {
  const issues = new BuildService().parseIssues(prefixedLog, "/tmp/workspace");
  for (const issue of issues) {
    assert.ok(
      !issue.path || !/texlive|texmf-dist|^\.\./.test(issue.path),
      `an issue points outside the workspace: ${issue.path}`
    );
  }
  const reference = issues.find((issue) => /Reference/.test(issue.message));
  assert.equal(reference.path, "main.tex", "the warning lost its real file");
});
