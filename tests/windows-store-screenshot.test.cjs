const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  CAPTURE_METHOD,
  CAPTURE_SOURCE,
  CAPTURE_HEIGHT,
  CAPTURE_WIDTH,
  NATIVE_CAPTURE_TIMEOUT_MS,
  captureBrowserWindowPng,
  createDemoPdf,
  parseArgs,
  readPngSize,
  sanitizeLaunchEnv,
} = require("../scripts/capture-windows-store-screenshots.cjs");

test("Store screenshot size satisfies Partner Center's desktop minimum", () => {
  assert.equal(CAPTURE_WIDTH, 1600);
  assert.equal(CAPTURE_HEIGHT, 900);
  assert.ok(CAPTURE_WIDTH >= 1366);
  assert.ok(CAPTURE_HEIGHT >= 768);
});

test("Store screenshot uses Electron's native BrowserWindow capture", async () => {
  const expectedPng = Buffer.from("native-electron-png");
  let captureRect = null;
  let captureOptions = null;
  const electronApp = {
    evaluate: async (evaluateInElectron, options) =>
      evaluateInElectron(
        {
          BrowserWindow: {
            getAllWindows: () => [
              {
                isDestroyed: () => false,
                getContentSize: () => [CAPTURE_WIDTH, CAPTURE_HEIGHT],
                webContents: {
                  capturePage: async (rect, nativeOptions) => {
                    captureRect = rect;
                    captureOptions = nativeOptions;
                    return {
                      isEmpty: () => false,
                      getSize: () => ({ width: CAPTURE_WIDTH, height: CAPTURE_HEIGHT }),
                      toPNG: () => expectedPng,
                    };
                  },
                },
              },
            ],
          },
        },
        options
      ),
  };

  const png = await captureBrowserWindowPng(electronApp);
  assert.deepEqual(png, expectedPng);
  assert.deepEqual(captureRect, {
    x: 0,
    y: 0,
    width: CAPTURE_WIDTH,
    height: CAPTURE_HEIGHT,
  });
  assert.deepEqual(captureOptions, { stayHidden: true, stayAwake: true });
  assert.equal(NATIVE_CAPTURE_TIMEOUT_MS, 30_000);
  assert.equal(CAPTURE_SOURCE, "real Electron BrowserWindow content");
  assert.equal(CAPTURE_METHOD, "BrowserWindow.webContents.capturePage");
});

test("Store screenshot flow cannot regress to Playwright page.screenshot", () => {
  const script = fs.readFileSync(
    path.join(__dirname, "..", "scripts", "capture-windows-store-screenshots.cjs"),
    "utf8"
  );
  assert.match(script, /webContents\.capturePage\(/);
  assert.doesNotMatch(script, /\bpage\.screenshot\s*\(/);
});

test("capture CLI parses packaged Windows settings and locales", () => {
  const options = parseArgs([
    "--executable",
    "dist/win-unpacked/TeX64.exe",
    "--output",
    "dist/screens",
    "--locales",
    "ja,en,ja",
    "--require-packaged",
    "--require-platform",
    "win32",
  ]);
  assert.equal(options.executablePath, path.resolve("dist/win-unpacked/TeX64.exe"));
  assert.equal(options.outputDir, path.resolve("dist/screens"));
  assert.deepEqual(options.locales, ["ja", "en"]);
  assert.equal(options.requirePackaged, true);
  assert.equal(options.requirePlatform, "win32");
});

test("capture launch environment removes credential-shaped values", () => {
  const clean = sanitizeLaunchEnv({
    PATH: "/usr/bin",
    SYSTEMROOT: "C:\\Windows",
    GITHUB_TOKEN: "do-not-copy",
    TEX64_API_SECRET: "do-not-copy",
    ACCOUNT_PASSWORD: "do-not-copy",
    ELECTRON_RUN_AS_NODE: "1",
  });
  assert.deepEqual(clean, {
    PATH: "/usr/bin",
    SYSTEMROOT: "C:\\Windows",
  });
});

test("deterministic demo PDF has a valid cross-reference and no user data", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-demo-pdf-test-"));
  const pdfPath = path.join(tempRoot, "main.pdf");
  try {
    createDemoPdf(pdfPath);
    const pdf = fs.readFileSync(pdfPath);
    const text = pdf.toString("latin1");
    assert.ok(text.startsWith("%PDF-1.4"));
    assert.match(text, /\/Title \(Robust Optimization\)/);
    assert.match(text, /xref\n0 10\n/);
    assert.match(text, /startxref\n\d+\n%%EOF\n$/);
    assert.doesNotMatch(text, /@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("PNG dimension reader uses the IHDR dimensions", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-png-test-"));
  const pngPath = path.join(tempRoot, "header.png");
  try {
    const header = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header, 0);
    header.write("IHDR", 12, "ascii");
    header.writeUInt32BE(1600, 16);
    header.writeUInt32BE(900, 20);
    fs.writeFileSync(pngPath, header);
    assert.deepEqual(readPngSize(pngPath), { width: 1600, height: 900 });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
