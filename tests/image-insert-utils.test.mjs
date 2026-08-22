import test from "node:test";
import assert from "node:assert/strict";
import {
  buildIncludeGraphicsSnippet,
  chooseImageDirectory,
} from "../Resources/web/app/image-insert-utils.js";

test("image export uses an existing conventional directory", () => {
  assert.equal(chooseImageDirectory(["src/main.tex", "figures/plot.pdf"]), "figures");
  assert.equal(chooseImageDirectory(["main.tex"]), "assets");
});

test("image export produces a plain or figure include", () => {
  assert.equal(
    buildIncludeGraphicsSnippet("assets/a.png", false),
    "\\includegraphics[width=0.8\\linewidth]{assets/a.png}\n"
  );
  assert.match(
    buildIncludeGraphicsSnippet("figures/a.png", true),
    /\\begin\{figure\}[\s\S]*\\centering[\s\S]*\\end\{figure\}/
  );
});
