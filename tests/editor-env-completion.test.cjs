const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const load = () => import(pathToFileURL(path.join(__dirname, "../Resources/web/app/editor-ergonomics.js")).href);

test("#122: \\begin with an existing matching \\end below is not completed again", async () => {
  const { planEnvironmentCompletion } = await load();
  const doc = "\\begin{memo}\n本文\n\\end{memo}\n";
  assert.equal(planEnvironmentCompletion("\\begin{memo}", "", doc), null);
});

test("#122: an unclosed \\begin is still completed", async () => {
  const { planEnvironmentCompletion } = await load();
  const doc = "\\begin{memo}\n\\begin{memo}\n本文\n\\end{memo}\n";
  assert.ok(planEnvironmentCompletion("\\begin{memo}", "", doc));
  assert.ok(planEnvironmentCompletion("\\begin{memo}", "", "\\begin{memo}\n% \\end{memo}\n"));
});

test("#122: typing \\end over the completed one removes the duplicate", async () => {
  const { planDuplicateEndRemoval } = await load();
  const lines = ["\\begin{memo}", "  本文", "\\end{memo}", "\\end{memo}", "後"];
  assert.equal(planDuplicateEndRemoval("\\end{memo}", "", lines, 3, lines.join("\n")), 4);
  const ok = ["\\begin{memo}", "\\end{memo}", "後"];
  assert.equal(planDuplicateEndRemoval("\\end{memo}", "", ok, 2, ok.join("\n")), null);
});

test("#123: Enter does not accept suggestions", () => {
  const fs = require("node:fs");
  const src = fs.readFileSync(path.join(__dirname, "../web-src/app/monaco-setup.ts"), "utf8");
  assert.match(src, /acceptSuggestionOnEnter: "off"/);
});
