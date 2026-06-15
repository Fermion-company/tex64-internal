const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const resourcePath = (...parts) => path.join(root, "Resources", "web", ...parts);

const assertFileExists = async (filePath) => {
  const stats = await fs.stat(filePath);
  assert.equal(stats.isFile(), true, `${filePath} should be a file`);
};

test("PDF.js language, standard font, and decoder assets are bundled", async () => {
  for (const file of [
    "pdfjs/cmaps/Adobe-Japan1-UCS2.bcmap",
    "pdfjs/cmaps/Adobe-GB1-UCS2.bcmap",
    "pdfjs/cmaps/Adobe-CNS1-UCS2.bcmap",
    "pdfjs/cmaps/Adobe-Korea1-UCS2.bcmap",
    "pdfjs/standard_fonts/LiberationSans-Regular.ttf",
    "pdfjs/standard_fonts/FoxitSymbol.pfb",
    "pdfjs/wasm/openjpeg.wasm",
    "pdfjs/wasm/jbig2.wasm",
  ]) {
    await assertFileExists(resourcePath(file));
  }
});

test("PDF rendering paths configure bundled PDF.js assets", async () => {
  const files = [
    resourcePath("pdf-viewer.js"),
    resourcePath("app", "ai-chat-attachments.js"),
  ];
  for (const file of files) {
    const source = await fs.readFile(file, "utf8");
    assert.match(source, /cMapUrl:/);
    assert.match(source, /cMapPacked:\s*true/);
    assert.match(source, /standardFontDataUrl:/);
    assert.match(source, /wasmUrl:/);
    assert.match(source, /useSystemFonts:\s*true/);
  }
});

test("PDF CJK font fallback aliases are loaded by both app documents", async () => {
  for (const file of ["index.html", "pdf-viewer.html"]) {
    const source = await fs.readFile(resourcePath(file), "utf8");
    assert.match(source, /pdf-font-fallbacks\.css/);
  }

  const css = await fs.readFile(resourcePath("pdf-font-fallbacks.css"), "utf8");
  for (const fontName of [
    "Ryumin",
    "GothicBBB",
    "KozMinPr6N",
    "KozGoPr6N",
    "SimSun",
    "SimHei",
    "MingLiU",
    "Kaiti",
    "Batang",
    "Dotum",
  ]) {
    assert.match(css, new RegExp(`font-family:\\s*"${fontName}"`));
  }
});
