import { expect } from "@playwright/test";
import { _electron as electron } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const repoRoot = path.resolve(__dirname, "..", "..");
export const workspaceRoot = path.join(repoRoot, "test-workspace");

const escapePdfString = (value) => value.replace(/[()\\]/g, "\\$&");

export const buildPdfContent = ({
  width = 200,
  height = 200,
  pages = 1,
  textPrefix = "HELLO-PDF",
} = {}) => {
  const resolvedWidth = Math.max(1, Math.floor(width));
  const resolvedHeight = Math.max(1, Math.floor(height));
  const pageCount = Math.max(1, Math.floor(pages));
  const header = "%PDF-1.4\n";
  const objects = [];

  const pageIds = Array.from({ length: pageCount }, (_, index) => 3 + index);
  const contentIds = Array.from(
    { length: pageCount },
    (_, index) => 3 + pageCount + index
  );
  const fontId = 3 + pageCount * 2;
  const kids = pageIds.map((id) => `${id} 0 R`).join(" ");

  objects[1] = "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n";
  objects[2] = `2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>\nendobj\n`;

  pageIds.forEach((pageId, index) => {
    const contentId = contentIds[index];
    const label =
      pageCount > 1 ? `${textPrefix}-${index + 1}` : textPrefix;
    const text = escapePdfString(label);
    const y = Math.max(24, resolvedHeight - 80);
    const stream = `BT /F1 24 Tf 72 ${y} Td (${text}) Tj ET`;
    const streamLength = Buffer.byteLength(stream, "utf8");
    objects[pageId] =
      `${pageId} 0 obj\n` +
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${resolvedWidth} ${resolvedHeight}] ` +
      `/Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>\n` +
      "endobj\n";
    objects[contentId] =
      `${contentId} 0 obj\n<< /Length ${streamLength} >>\nstream\n${stream}\nendstream\nendobj\n`;
  });

  objects[fontId] =
    `${fontId} 0 obj\n` +
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n";

  let offset = Buffer.byteLength(header, "utf8");
  let body = "";
  const offsets = [0];
  for (let id = 1; id <= fontId; id += 1) {
    const chunk = objects[id];
    offsets[id] = offset;
    body += chunk;
    offset += Buffer.byteLength(chunk, "utf8");
  }

  const xrefOffset = offset;
  const lines = [];
  lines.push(`xref\n0 ${fontId + 1}\n`);
  lines.push("0000000000 65535 f \n");
  for (let id = 1; id <= fontId; id += 1) {
    lines.push(`${String(offsets[id]).padStart(10, "0")} 00000 n \n`);
  }
  const xref = lines.join("");
  const trailer =
    `trailer\n<< /Size ${fontId + 1} /Root 1 0 R >>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`;

  return header + body + xref + trailer;
};

export const writeTestPdf = async (filePath, options = {}) => {
  const content = buildPdfContent(options);
  await fs.writeFile(filePath, content, "utf8");
};

export const launchApp = async (extraEnv = {}) => {
  const env = {
    ...process.env,
    TEX180_E2E: "1",
    TEX180_E2E_WORKSPACE: workspaceRoot,
    ...extraEnv,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  return electron.launch({ args: ["."], cwd: repoRoot, env });
};

export const openWorkspaceApp = async (extraEnv = {}) => {
  const electronApp = await launchApp(extraEnv);
  const page = await electronApp.firstWindow();
  await page.waitForSelector("#file-tree");
  await page.waitForSelector('button.file-item[data-path="main.tex"]');
  await page.waitForFunction(() => window.__tex180Editor);
  return { electronApp, page };
};

export const openEditor = async () => {
  const { electronApp, page } = await openWorkspaceApp();
  await page.click('button.file-item[data-path="main.tex"]');
  await page.waitForSelector('button.file-item[data-path="main.tex"].is-active');
  await page.waitForFunction(() => window.__tex180Editor && window.__tex180Editor.getModel);
  await page.click('.tab[data-tab="blocks"]');
  await page.waitForSelector('.panel[data-panel="blocks"].is-active');
  await page.waitForFunction(() => document.querySelector("math-field"));
  await page.waitForFunction(() => typeof window.__tex180SetMathInputFallback === "function");
  return { electronApp, page };
};

export const setEditorContent = async (page, content) => {
  await page.evaluate((text) => {
    const editor = window.__tex180Editor;
    editor.setValue(text);
    editor.focus();
  }, content);
};

export const moveCursorTo = async (page, needle) => {
  await page.evaluate((target) => {
    const editor = window.__tex180Editor;
    const text = editor.getValue();
    const index = text.indexOf(target);
    if (index < 0) {
      throw new Error(`Needle not found: ${target}`);
    }
    const position = editor.getModel().getPositionAt(index + 1);
    editor.setPosition(position);
    editor.focus();
  }, needle);
};

export const waitForAutoDetected = async (page, expected, label) => {
  try {
    await page.waitForFunction(
      (value) => {
        const panel = document.querySelector(".blocks-panel");
        const detected = panel?.classList.contains("is-auto-detected") ?? false;
        return detected === value;
      },
      expected,
      { timeout: 8000 }
    );
  } catch (error) {
    const prefix = expected ? "auto-detect on" : "auto-detect off";
    throw new Error(`${prefix} timed out${label ? `: ${label}` : ""}`);
  }
};

export const waitForMathValueIncludes = async (page, expected, label) => {
  try {
    await page.waitForFunction(
      (value) => {
        const field = document.querySelector("math-field");
        if (!field) return false;
        const current =
          typeof field.getValue === "function" ? field.getValue("latex") : field.value;
        return typeof current === "string" && current.includes(value);
      },
      expected,
      { timeout: 8000 }
    );
  } catch (error) {
    throw new Error(`math value "${expected}" timed out${label ? `: ${label}` : ""}`);
  }
};

export const getDiffEditorValues = async (page) =>
  page.evaluate(() => {
    const diff = window.__tex180DiffEditor;
    if (!diff || typeof diff.getModel !== "function") {
      return null;
    }
    const model = diff.getModel();
    const original =
      model?.original && typeof model.original.getValue === "function"
        ? model.original.getValue()
        : null;
    const modified =
      model?.modified && typeof model.modified.getValue === "function"
        ? model.modified.getValue()
        : null;
    return { original, modified };
  });

export const toggleEnvRegistry = async (page, name, kind, enable) => {
  const selector = `[data-env-action="toggle"][data-env-name="${name}"][data-env-kind="${kind}"]`;
  await page.waitForSelector(selector);
  const isOn = await page.$eval(selector, (node) =>
    node.classList.contains("is-on")
  );
  if (enable !== isOn) {
    await page.click(selector);
  }
};

export const setMathFieldValue = async (page, value) => {
  await page.evaluate((nextValue) => {
    const field = document.querySelector("math-field");
    if (!field) return;
    if (typeof field.setValue === "function") {
      field.setValue(nextValue);
    } else if ("value" in field) {
      field.value = nextValue;
    }
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
};

export const applyMathEdit = async (page, options) => {
  const { needle, replaceWith, label, verify } = options;
  await moveCursorTo(page, needle);
  await waitForAutoDetected(page, true, label ?? needle);
  const original = await page.evaluate(() => window.__tex180GetMathInputValue?.());
  if (typeof original !== "string") {
    throw new Error(`math input missing: ${label ?? needle}`);
  }
  if (!original.includes(needle)) {
    throw new Error(`math input does not include "${needle}": ${label ?? needle}`);
  }
  const nextValue = original.replace(needle, replaceWith);
  if (nextValue === original) {
    throw new Error(`math input unchanged for "${needle}": ${label ?? needle}`);
  }
  await setMathFieldValue(page, nextValue);
  await page.waitForFunction(
    (expected) => {
      const field = document.querySelector("math-field");
      if (!field) return false;
      const current =
        typeof field.getValue === "function" ? field.getValue("latex") : field.value;
      return typeof current === "string" && current.includes(expected);
    },
    replaceWith,
    { timeout: 8000 }
  );
  await page.click("#block-insert-button");
  await page.waitForSelector("#diff-modal.is-open");
  const lastDraft = await page.evaluate(() => window.__tex180LastDraft);
  expect(lastDraft?.formula ?? "").toContain(replaceWith);
  expect(lastDraft?.snippet ?? "").toContain(replaceWith);
  await page.waitForFunction(
    (expected) => window.__tex180LastDiff?.modified?.includes(expected),
    replaceWith,
    { timeout: 8000 }
  );
  const lastDiff = await page.evaluate(() => window.__tex180LastDiff);
  expect(lastDiff?.modified ?? "").toContain(replaceWith);
  expect(lastDiff?.original ?? "").toContain(needle);
  const diffValues = await getDiffEditorValues(page);
  expect(diffValues?.modified ?? "").toContain(replaceWith);
  expect(diffValues?.original ?? "").toContain(needle);
  await page.click("#diff-modal-submit");
  await page.waitForFunction(
    () => !document.getElementById("diff-modal")?.classList.contains("is-open")
  );
  const updated = await page.evaluate(() => window.__tex180Editor.getValue());
  expect(updated).toContain(replaceWith);
  (verify ?? []).forEach((text) => {
    expect(updated).toContain(text);
  });
};
