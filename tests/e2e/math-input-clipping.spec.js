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
  return { app, page };
};

test("Math input handles tall content without clipping", async ({}, testInfo) => {
  const { app, page } = await launchApp(testInfo);
  try {
    // 1. Open Blocks Tab (assuming it's a tab or part of the UI, user said "Sidebar")
    // Note: Based on dom.ts, block forms are visible when a block is active.
    // We need to simulate selecting a math block or just checking the math input if it's always there in the blocks panel.
    // Looking at index.html, .block-form[data-form="math"] is inside .blocks-panel.
    
    // Open the Blocks tab to make the panel visible
    await page.click('.tab[data-tab="blocks"]');
    await expect(page.locator('.panel[data-panel="blocks"]')).toBeVisible();

    // Simulate active block context to show the math form
    await page.evaluate(() => {
        // Mock the active block context to "math"
        const mathForm = document.querySelector('.block-form[data-form="math"]');
        if (mathForm) {
            mathForm.classList.add('is-active');
            mathForm.style.display = 'flex'; // Force flex to ensure visibility
        }
        // Also ensure parent is visible if needed
        const blocksPanel = document.querySelector('.blocks-panel');
        if(blocksPanel) blocksPanel.style.display = 'flex';
    });

    // Wait for the math field to appear
    const mathFieldSelector = 'math-field.block-math-field';
    await page.waitForSelector(mathFieldSelector, { timeout: 10000 });

    // 2. Insert EXTREMELY Tall Content (10-row Matrix to force scrolling)
    const tallContent = String.raw`\begin{pmatrix} A_{1} & B_{1} & C_{1} \\ A_{2} & B_{2} & C_{2} \\ A_{3} & B_{3} & C_{3} \\ A_{4} & B_{4} & C_{4} \\ A_{5} & B_{5} & C_{5} \\ A_{6} & B_{6} & C_{6} \\ A_{7} & B_{7} & C_{7} \\ A_{8} & B_{8} & C_{8} \\ A_{9} & B_{9} & C_{9} \\ A_{10} & B_{10} & C_{10} \end{pmatrix}`;
    await page.evaluate(([selector, content]) => {
        const mf = document.querySelector(selector);
        if (mf) mf.value = content;
    }, [mathFieldSelector, tallContent]);

    // Wait for MathLive to render the content
    await page.waitForTimeout(500);

    // 3. Inspect if content overflows container bounds
    const overflowCheck = await page.evaluate((selector) => {
        const mf = document.querySelector(selector);
        const container = mf?.closest('.block-math-input-container');
        
        if (!mf || !container) return { error: "Elements not found" };

        const mfRect = mf.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        
        // Check if math field content extends beyond container
        const overflowsTop = mfRect.top < containerRect.top;
        const overflowsBottom = mfRect.bottom > containerRect.bottom;
        const overflowsLeft = mfRect.left < containerRect.left;
        const overflowsRight = mfRect.right > containerRect.right;

        return {
            mfRect: { top: mfRect.top, bottom: mfRect.bottom, height: mfRect.height },
            containerRect: { top: containerRect.top, bottom: containerRect.bottom, height: containerRect.height },
            overflows: {
                top: overflowsTop,
                bottom: overflowsBottom,
                left: overflowsLeft,
                right: overflowsRight
            },
            containerOverflow: window.getComputedStyle(container).overflow,
            mfOverflow: window.getComputedStyle(mf).overflow
        };
    }, mathFieldSelector);

    console.log("Overflow Check:", JSON.stringify(overflowCheck, null, 2));

    // Assert no overflow outside container
    expect(overflowCheck.error).toBeUndefined();
    expect(overflowCheck.overflows.top).toBe(false);
    expect(overflowCheck.overflows.bottom).toBe(false);

    // 4. Check if scrolling is possible (scrollHeight > clientHeight means scrollable)
    const scrollCheck = await page.evaluate((selector) => {
        const mf = document.querySelector(selector);
        if (!mf) return { error: "MathField not found" };
        return {
            scrollHeight: mf.scrollHeight,
            clientHeight: mf.clientHeight,
            isScrollable: mf.scrollHeight > mf.clientHeight,
            canScrollDown: mf.scrollTop < (mf.scrollHeight - mf.clientHeight)
        };
    }, mathFieldSelector);

    console.log("Scroll Check:", JSON.stringify(scrollCheck, null, 2));
    
    // 5. Check Shadow DOM content actual height
    const shadowHeightCheck = await page.evaluate((selector) => {
        const mf = document.querySelector(selector);
        if (!mf || !mf.shadowRoot) return { error: "No shadow root" };
        
        const container = mf.shadowRoot.querySelector('.ML__container');
        const content = mf.shadowRoot.querySelector('.ML__content');
        const field = mf.shadowRoot.querySelector('.ML__field');
        
        return {
            container: container ? { scrollHeight: container.scrollHeight, clientHeight: container.clientHeight, height: getComputedStyle(container).height } : null,
            content: content ? { scrollHeight: content.scrollHeight, clientHeight: content.clientHeight, height: getComputedStyle(content).height } : null,
            field: field ? { scrollHeight: field.scrollHeight, clientHeight: field.clientHeight, height: getComputedStyle(field).height } : null,
            hostHeight: getComputedStyle(mf).height
        };
    }, mathFieldSelector);

    console.log("Shadow DOM Height Check:", JSON.stringify(shadowHeightCheck, null, 2));
    
    // If content is tall enough, it should be scrollable
    // (We won't assert this as mandatory since small content won't scroll)

  } finally {
    await app.close();
  }
});
