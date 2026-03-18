const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const ELECTRON_BIN = path.join(PROJECT_ROOT, "node_modules", ".bin", "electron");
// Pass the project root dir (not main.cjs) so Electron reads `main` from package.json
// and app.getAppPath() correctly resolves to the project root.
const APP_DIR = PROJECT_ROOT;

async function main() {
  const { _electron: electron } = require("playwright");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-e2e-"));
  console.log("tmpDir:", tmpDir);
  console.log("Launching Electron...");

  const app = await electron.launch({
    executablePath: ELECTRON_BIN,
    args: [APP_DIR],
    env: {
      ...process.env,
      PATH: "/opt/homebrew/bin:" + (process.env.PATH || ""),
      TEX64_E2E: "1",
      TEX64_E2E_USERDATA: tmpDir,
      TEX64_E2E_FORCE_HEADLESS: "1",
      NODE_ENV: "test",
    },
    timeout: 30000,
  });
  console.log("App launched");

  const page = await app.firstWindow();
  console.log("Got first window");
  await page.waitForLoadState("domcontentloaded");
  console.log("DOM loaded");
  await page.waitForTimeout(5000);

  const url = await page.url();
  console.log("URL:", url);

  const title = await page.title();
  console.log("Title:", title);

  const bodyHTML = await page.evaluate(() => document.body ? document.body.innerHTML.substring(0, 500) : "NO BODY");
  console.log("Body HTML:", bodyHTML);

  const headHTML = await page.evaluate(() => document.head ? document.head.innerHTML.substring(0, 300) : "NO HEAD");
  console.log("Head HTML:", headHTML);

  const bodyClasses = await page.evaluate(() => document.body.className);
  console.log("Body classes:", bodyClasses);

  const launcherState = await page.evaluate(() => {
    const l = document.getElementById("launcher");
    if (!l) return "NOT FOUND";
    return { ariaHidden: l.getAttribute("aria-hidden"), display: getComputedStyle(l).display };
  });
  console.log("Launcher:", JSON.stringify(launcherState));

  const mathContainer = await page.evaluate(() => {
    const c = document.getElementById("block-math-input-container");
    if (!c) return "NOT FOUND";
    return {
      html: c.innerHTML.substring(0, 300),
      display: getComputedStyle(c).display,
      children: c.children.length,
      parentDisplay: c.parentElement ? getComputedStyle(c.parentElement).display : null,
    };
  });
  console.log("Math container:", JSON.stringify(mathContainer, null, 2));

  const mathLiveState = await page.evaluate(() => ({
    hasMathLive: !!window.MathLive,
    hasMFElement: !!(window.MathLive && window.MathLive.MathfieldElement),
    customElement: !!customElements.get("math-field"),
    loadError: window.MATHLIVE_LOAD_ERROR || null,
  }));
  console.log("MathLive:", JSON.stringify(mathLiveState));

  const mathElements = await page.evaluate(() => ({
    mathField: !!document.querySelector("math-field"),
    textarea: !!document.querySelector("textarea#block-math-input"),
    anyBlockInput: !!document.querySelector("#block-math-input"),
  }));
  console.log("Math elements:", JSON.stringify(mathElements));

  // Check sidebar / blocks panel
  const sidebarInfo = await page.evaluate(() => {
    const sidebar = document.querySelector(".sidebar");
    const blocksPanel = document.querySelector('[data-panel="blocks"]');
    const mathForm = document.querySelector('[data-form="math"]');
    return {
      sidebar: sidebar ? getComputedStyle(sidebar).display : "NOT FOUND",
      blocksPanel: blocksPanel ? { display: getComputedStyle(blocksPanel).display, classes: blocksPanel.className } : "NOT FOUND",
      mathForm: mathForm ? { display: getComputedStyle(mathForm).display, classes: mathForm.className } : "NOT FOUND",
    };
  });
  console.log("Sidebar info:", JSON.stringify(sidebarInfo, null, 2));

  await app.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
