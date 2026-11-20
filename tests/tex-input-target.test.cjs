const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { resolveInputLineTarget, firstContentLine } = require("../electron/services/tex-input-target.cjs");

const project = (files) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-input-target-"));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), text);
  }
  return root;
};

test("a Jump from an \\input line looks at the start of that file", () => {
  const root = project({
    "book.tex": "\\documentclass{book}\n\\begin{document}\n\\input{chapters/one}\n  \\include{chapters/two} % second\nText \\input{chapters/one} inline.\n\\input{missing}\n\\end{document}\n",
    "chapters/one.tex": "% chapter one\n\n\\chapter{One}\nBody.\n",
    "chapters/two.tex": "\\chapter{Two}\n",
  });
  try {
    assert.deepEqual(resolveInputLineTarget(root, "book.tex", 3), { path: "chapters/one.tex", line: 3 });
    assert.deepEqual(resolveInputLineTarget(root, "book.tex", 4), { path: "chapters/two.tex", line: 1 });
    assert.equal(resolveInputLineTarget(root, "book.tex", 5), null, "a line with text of its own is typeset where it stands");
    assert.equal(resolveInputLineTarget(root, "book.tex", 6), null, "a file that is not there");
    assert.equal(resolveInputLineTarget(root, "book.tex", 2), null);
    assert.equal(resolveInputLineTarget(root, "../outside.tex", 1), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("\\subfile is found from the file it is written in, and starts after \\begin{document}", () => {
  const root = project({
    "all.tex": "\\documentclass{book}\n\\usepackage{subfiles}\n\\begin{document}\n\\subfile{tex/part1}\n\\end{document}\n",
    "tex/part1.tex": "\\documentclass[../all]{subfiles}\n\\begin{document}\n\n% note\n\\chapter{Part one}\n\\subfile{sections/a}\n\\end{document}\n",
    "tex/sections/a.tex": "\\documentclass[../../all]{subfiles}\n\\begin{document}\nA.\n\\end{document}\n",
  });
  try {
    assert.deepEqual(resolveInputLineTarget(root, "all.tex", 4), { path: "tex/part1.tex", line: 5 });
    assert.deepEqual(resolveInputLineTarget(root, "tex/part1.tex", 6), { path: "tex/sections/a.tex", line: 3 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the first printed line skips blank lines and comments", () => {
  assert.equal(firstContentLine("\n% c\n  \nfirst\n"), 4);
  assert.equal(firstContentLine("\\begin{document} as an example in running text\nsecond\n"), 1);
  assert.equal(firstContentLine(""), 1);
});
