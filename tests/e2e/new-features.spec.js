import { test, expect, _electron as electron } from "@playwright/test";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs/promises";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");
const templateWorkspace = path.join(repoRoot, "test-workspace");

test.describe.configure({ mode: "serial" });

const copyWorkspace = async (targetPath) => {
  await fs.rm(targetPath, { recursive: true, force: true });
  await fs.mkdir(targetPath, { recursive: true });
  await fs.cp(templateWorkspace, targetPath, {
    recursive: true,
    filter: (src) => !src.split(path.sep).includes("__e2e__"),
  });
};

const launchApp = async (testInfo) => {
  const workspacePath = testInfo.outputPath("workspace");
  const userDataPath = testInfo.outputPath("userdata");
  await copyWorkspace(workspacePath);
  await fs.mkdir(userDataPath, { recursive: true });

  const env = {
    ...process.env,
    TEX180_E2E: "1",
    TEX180_E2E_WORKSPACE: workspacePath,
    TEX180_E2E_USERDATA: userDataPath,
  };
  delete env.ELECTRON_RUN_AS_NODE;

  const app = await electron.launch({
    executablePath: electronPath,
    args: [repoRoot],
    cwd: repoRoot,
    env,
  });
  const page = await app.firstWindow();
  await page.waitForSelector("#file-tree .file-item");
  await page.waitForFunction(() => window.__tex64Editor);
  return { app, page, workspacePath };
};

const focusEditor = async (page) => {
  await page.evaluate(() => {
    const editor = window.__tex64Editor;
    if (!editor) return;
    const model = editor.getModel?.();
    if (model) {
      const line = model.getLineCount();
      const column = model.getLineMaxColumn(line);
      editor.setPosition?.({ lineNumber: line, column });
    }
    editor.focus?.();
  });
};

const openMainTex = async (page) => {
  await page.click('.file-item[data-path="main.tex"]');
  await page.waitForFunction(() => {
    const editor = window.__tex64Editor;
    return Boolean(editor && editor.getValue?.().includes("\\documentclass"));
  });
};

const getEditorValue = async (page) =>
  page.evaluate(() => window.__tex64Editor?.getValue?.() ?? "");

const setClipboardHtml = async (app, html, text) => {
  await app.evaluate(
    ({ clipboard }, payload) => {
      clipboard.write({ html: payload.html, text: payload.text });
    },
    { html, text }
  );
};

const setClipboardImage = async (app, dataUrl) => {
  await app.evaluate(
    ({ clipboard, nativeImage }, payload) => {
      const image = nativeImage.createFromDataURL(payload.dataUrl);
      clipboard.writeImage(image);
    },
    { dataUrl }
  );
};

const setClipboardPdf = async (app, buffer) => {
  await app.evaluate(
    ({ clipboard }, payload) => {
      const pdfBuffer = Buffer.from(payload.buffer);
      clipboard.writeBuffer("application/pdf", pdfBuffer);
      clipboard.writeBuffer("public.pdf", pdfBuffer);
    },
    { buffer: Array.from(buffer) }
  );
};

const pasteFromClipboard = async (page) => {
  await focusEditor(page);
  const pasteKey = process.platform === "darwin" ? "Meta+V" : "Control+V";
  await page.keyboard.press(pasteKey);
};

const requestClipboardRead = async (page) => {
  await page.evaluate(() => {
    window.tex64Bridge?.postMessage({ type: "alchemy:clipboard:read" });
  });
};

const buildPdfBuffer = (texts) => {
  const objects = [];
  const offsets = [];
  let content = "%PDF-1.4\n";
  const addObject = (id, body) => {
    offsets[id] = Buffer.byteLength(content, "utf8");
    content += `${id} 0 obj\n${body}\nendobj\n`;
  };
  const pageCount = texts.length;
  const pageStart = 3;
  const contentStart = pageStart + pageCount;
  const fontId = contentStart + pageCount;
  addObject(1, "<< /Type /Catalog /Pages 2 0 R >>");
  addObject(
    2,
    `<< /Type /Pages /Count ${pageCount} /Kids [${texts
      .map((_, i) => `${pageStart + i} 0 R`)
      .join(" ")}] >>`
  );
  texts.forEach((text, index) => {
    const pageId = pageStart + index;
    const contentId = contentStart + index;
    addObject(
      pageId,
      [
        "<< /Type /Page",
        "/Parent 2 0 R",
        "/MediaBox [0 0 612 792]",
        `/Contents ${contentId} 0 R`,
        `/Resources << /Font << /F1 ${fontId} 0 R >> >>`,
        ">>",
      ].join(" ")
    );
  });
  texts.forEach((text, index) => {
    const contentId = contentStart + index;
    const safe = text.replace(/[()\\]/g, "\\$&");
    const stream = `BT /F1 24 Tf 72 72 Td (${safe}) Tj ET`;
    const length = Buffer.byteLength(stream, "utf8");
    addObject(contentId, `<< /Length ${length} >>\nstream\n${stream}\nendstream`);
  });
  addObject(fontId, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const xrefOffset = Buffer.byteLength(content, "utf8");
  content += `xref\n0 ${fontId + 1}\n`;
  content += "0000000000 65535 f \n";
  for (let i = 1; i <= fontId; i += 1) {
    const offset = offsets[i] ?? 0;
    content += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  content += `trailer\n<< /Size ${fontId + 1} /Root 1 0 R >>\n`;
  content += `startxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(content, "utf8");
};

test("Paste Alchemy: HTMLを取り込み、設定と挿入形式を反映", async ({}, testInfo) => {
  const { app, page } = await launchApp(testInfo);
  try {
    await openMainTex(page);
    const html = `
      <table>
        <tr><th>H1</th><th>H2</th></tr>
        <tr><td>A</td><td>B</td></tr>
      </table>
      <p>Hello <strong>world</strong>.</p>
    `;
    await setClipboardHtml(app, html, "Hello world.");
    await requestClipboardRead(page);

    const panel = page.locator("#alchemy-panel");
    await expect(panel).toHaveClass(/is-open/);
    await expect(page.locator('.tab[data-tab="alchemy"]')).toHaveClass(/is-active/);
    const items = page.locator("#alchemy-list .alchemy-item");
    await expect(items).toHaveCount(2);
    await expect(page.locator('.alchemy-item[data-kind="table"]')).toHaveCount(1);
    await expect(page.locator('.alchemy-item[data-kind="text"]')).toHaveCount(1);
    await expect(
      page.locator('.alchemy-item[data-kind="text"] [data-preview="text"]')
    ).toContainText("Hello world");

    await page.click("#alchemy-settings-button");
    await page.selectOption("#alchemy-default-table", "longtable");
    await page.selectOption("#alchemy-default-figure", "figure");
    await page.selectOption("#alchemy-default-math", "display");
    await page.selectOption("#alchemy-ocr-language", "eng");

    await page.click("#alchemy-apply-all");
    await expect.poll(() => getEditorValue(page)).toContain("\\begin{longtable}");
    await expect.poll(() => getEditorValue(page)).toContain("\\textbf{world}");
  } finally {
    await app.close();
  }
});

test("Paste Alchemy: 画像を図として保存・挿入する", async ({}, testInfo) => {
  const { app, page } = await launchApp(testInfo);
  try {
    await openMainTex(page);
    const pngDataUrl =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==";
    await setClipboardImage(app, pngDataUrl);
    await requestClipboardRead(page);

    const items = page.locator("#alchemy-list .alchemy-item");
    await expect(items).toHaveCount(1);
    await expect(page.locator('.alchemy-item[data-kind="figure"]')).toHaveCount(1);

    await page.click("#alchemy-settings-button");
    await page.selectOption("#alchemy-default-figure", "figure");
    await page.click("#alchemy-apply-all");

    await expect.poll(() => getEditorValue(page)).toContain("\\includegraphics");
    await expect.poll(() => getEditorValue(page)).toContain("images/");
  } finally {
    await app.close();
  }
});

test("Paste Alchemy: PDF全ページ取り込みとOCR切替", async ({}, testInfo) => {
  const { app, page } = await launchApp(testInfo);
  try {
    await openMainTex(page);
    const pdfBuffer = buildPdfBuffer(["Alpha", "Beta"]);
    await setClipboardPdf(app, pdfBuffer);
    await requestClipboardRead(page);

    const items = page.locator("#alchemy-list .alchemy-item");
    await expect(items).toHaveCount(2);

    const firstItem = items.nth(0);
    await firstItem.locator("select[data-role='mode']").selectOption("PDFテキスト");
    await expect(firstItem.locator('[data-preview="text"]')).toContainText("Alpha");

    await page.click("#alchemy-apply-all");
    await expect.poll(() => getEditorValue(page)).toContain("Alpha");
    await expect.poll(() => getEditorValue(page)).toContain("Beta");
  } finally {
    await app.close();
  }
});

test("Magic Capture: ウィンドウ選択→切り取り→図として挿入", async ({}, testInfo) => {
  const { app, page } = await launchApp(testInfo);
  try {
    await openMainTex(page);
    await page.click('.tab[data-tab="alchemy"]');
    await expect(page.locator('.tab[data-tab="alchemy"]')).toHaveClass(/is-active/);

    await page.click("#alchemy-capture-button");
    await page.waitForSelector("#capture-window-modal.is-open");

    const windowItems = page.locator("#capture-window-grid .capture-window-item");
    await expect(windowItems).not.toHaveCount(0);
    await windowItems.first().click();

    await page.waitForSelector("#capture-crop-modal.is-open");
    await page.click("#capture-crop-apply");

    await expect(page.locator('#alchemy-list .alchemy-item[data-kind="figure"]')).toHaveCount(
      1
    );
    await page.click("#alchemy-apply-all");
    await expect.poll(() => getEditorValue(page)).toContain("\\includegraphics");
  } finally {
    await app.close();
  }
});
