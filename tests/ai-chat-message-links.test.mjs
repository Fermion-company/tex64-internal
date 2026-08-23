import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

/** Load the vendored marked UMD bundle the renderer actually ships. */
const loadMarked = () => {
  const source = readFileSync(path.join(repoRoot, "Resources/web/vendor/marked.umd.js"), "utf8");
  const sandbox = { globalThis: undefined, module: undefined, exports: undefined, self: {} };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox.marked ?? sandbox.self.marked;
};

globalThis.marked = loadMarked();
globalThis.katex = {
  renderToString: (expression) => `<span class="katex">${expression}</span>`,
};

const { renderMarkdownHtml } = await import(
  path.join(repoRoot, "Resources/web/app/ai-chat-message.js")
);

test("renders a workspace file link as an openable chip, not a navigation target", () => {
  const html = renderMarkdownHtml("Wrote [main.tex](tex64-file:main.tex).");
  assert.match(html, /data-open-file="main\.tex"/);
  assert.match(html, /class="ai-file-link"/);
  assert.doesNotMatch(html, /<a [^>]*href="tex64-file:/);
});

test("decodes escaped characters in the file target", () => {
  const html = renderMarkdownHtml("[my paper.tex](tex64-file:my%20paper.tex)");
  assert.match(html, /data-open-file="my paper\.tex"/);
});

test("routes web links through the shell instead of navigating the renderer", () => {
  const html = renderMarkdownHtml("See [docs](https://tex64.com/docs).");
  assert.match(html, /data-open-url="https:\/\/tex64\.com\/docs"/);
  assert.doesNotMatch(html, /href="https:\/\/tex64\.com\/docs"/);
});

test("drops non-web, non-file link targets to plain text", () => {
  for (const href of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,<b>x</b>"]) {
    const html = renderMarkdownHtml(`[click](${href})`);
    assert.doesNotMatch(html, /<a /, `${href} must not become a link`);
    assert.doesNotMatch(html, /data-open-(file|url)/, `${href} must not become an action`);
    assert.match(html, /click/);
  }
});

test("escapes raw HTML in model output instead of executing it", () => {
  const html = renderMarkdownHtml('Careful: <img src=x onerror="alert(1)"> and <script>alert(2)</script>');
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /<script/);
  assert.match(html, /&lt;img/);
});

test("strips a raw Codex file citation down to the file name", () => {
  const html = renderMarkdownHtml(
    'Done. :codex-file-citation{path="/private/tmp/x9/main.pdf" purpose="output"}',
  );
  assert.doesNotMatch(html, /codex-file-citation/);
  assert.doesNotMatch(html, /private\/tmp/);
  assert.match(html, /main\.pdf/);
});

test("still renders ordinary markdown and math", () => {
  const html = renderMarkdownHtml("**bold** and `code` and $x^2$");
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /ai-inline-code/);
  assert.match(html, /katex/);
});

test("round-trips a file name containing brackets and parentheses", () => {
  const html = renderMarkdownHtml(
    "[draft (v2) \\[final\\].tex](tex64-file:draft%20%28v2%29%20%5Bfinal%5D.tex)",
  );
  assert.match(html, /data-open-file="draft \(v2\) \[final\]\.tex"/);
});
