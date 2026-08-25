/**
 * Hands-on E2E for the first-run TeX gate.
 *
 * The whole promise of this screen is: a machine with TeX goes straight to the
 * app, and a machine without it answers one question and watches one gauge. Both
 * halves are driven here against the real Electron app — the missing-TeX case
 * via the TEX64_E2E_FORCE_MISSING_TOOLS seam, so no gigabyte is ever downloaded.
 *
 * Progress is injected from the main process on the real IPC channel rather than
 * by starting an install, which exercises the same wiring an install would.
 *
 * Run:
 *   TEX64_E2E=1 node --test tests/e2e/onboarding-flow.test.cjs
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const ELECTRON_BIN = require("electron");

const ALL_TEX_TOOLS = "lualatex,pdflatex,xelatex,uplatex,latexmk,synctex,latexindent";

const closeElectronApp = async (electronApp) => {
  if (!electronApp) return;
  const child = typeof electronApp.process === "function" ? electronApp.process() : null;
  await Promise.race([
    electronApp.close().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
  if (child && !child.killed && child.exitCode == null) child.kill("SIGKILL");
};

const launch = async ({ missingTools }) => {
  const { _electron: electron } = require("playwright");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-onboarding-e2e-"));
  const env = {
    ...process.env,
    PATH: `/Library/TeX/texbin:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ""}`,
    TEX64_E2E: "1",
    TEX64_E2E_USERDATA: tmpDir,
    TEX64_E2E_FORCE_HEADLESS: "1",
    NODE_ENV: "test",
  };
  if (missingTools) {
    env.TEX64_E2E_FORCE_MISSING_TOOLS = ALL_TEX_TOOLS;
    env.TEX64_E2E_IGNORE_SYSTEM_TEX = "1";
  }
  const electronApp = await electron.launch({
    executablePath: ELECTRON_BIN,
    args: [PROJECT_ROOT],
    env,
    timeout: 60_000,
  });
  const page = await electronApp.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(4000);
  await page.evaluate(() => document.getElementById("announcement-modal-close")?.click());
  await page.waitForTimeout(1200);
  return { electronApp, page, tmpDir };
};

const gateState = (page) =>
  page.evaluate(() => {
    const root = document.getElementById("onboarding");
    const text = (id) => document.getElementById(id)?.textContent?.trim() ?? "";
    const card = (id) => {
      const el = document.getElementById(id);
      if (!el) return null;
      const part = (cls) => el.querySelector(cls)?.textContent?.trim() ?? "";
      return {
        title: part(".env-choice-title"),
        detail: part(".env-choice-detail"),
        size: part(".env-choice-size"),
        badge: part(".env-choice-badge"),
      };
    };
    return {
      visible: Boolean(root?.classList.contains("is-visible")),
      bodyGated: document.body.classList.contains("has-onboarding"),
      choiceShown: !document.getElementById("onboarding-choice")?.classList.contains("is-hidden"),
      progressShown: !document
        .getElementById("onboarding-progress")
        ?.classList.contains("is-hidden"),
      light: card("onboarding-choice-light"),
      percent: text("onboarding-percent"),
      eta: text("onboarding-eta"),
      phase: text("onboarding-phase"),
      fillWidth: document.getElementById("onboarding-gauge-fill")?.style.width ?? "",
      launcherVisible: Boolean(
        document.getElementById("launcher")?.classList.contains("is-visible")
      ),
    };
  });

const sendFromMain = (electronApp, type, payload) =>
  electronApp.evaluate(
    ({ BrowserWindow }, message) => {
      const win = BrowserWindow.getAllWindows()[0];
      win?.webContents.send("tex64:message", message);
    },
    { type, payload }
  );

test("a machine with TeX never sees the gate", async () => {
  const { electronApp, page, tmpDir } = await launch({ missingTools: false });
  try {
    await page.waitForTimeout(3000);
    const state = await gateState(page);
    assert.equal(state.visible, false, "the gate must stay down when TeX is present");
    assert.equal(state.bodyGated, false);
    assert.equal(state.launcherVisible, true, "the launcher should be reachable straight away");
  } finally {
    await closeElectronApp(electronApp);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("a machine without TeX gets one quick lightweight-install action", async () => {
  const { electronApp, page, tmpDir } = await launch({ missingTools: true });
  try {
    await page.waitForSelector("#onboarding.is-visible", { timeout: 20_000 });
    const state = await gateState(page);
    assert.equal(state.choiceShown, true);
    assert.equal(state.progressShown, false);
    assert.equal(state.bodyGated, true, "the launcher must not show through the gate");

    assert.match(state.light.size, /\d/, `light card has no size: ${JSON.stringify(state.light)}`);
    assert.match(state.light.size, /MB/);
    assert.match(state.light.size, /300/);
    assert.match(state.light.detail, /TinyTeX-1/);
    assert.match(state.light.badge, /Recommended|おすすめ/);
    assert.equal(
      await page.locator("#onboarding-choice .env-choice-card").count(),
      1,
      "first run should have one clear setup action"
    );
  } finally {
    await closeElectronApp(electronApp);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

const TEX_COMMANDS = [
  "lualatex",
  "pdflatex",
  "xelatex",
  "uplatex",
  "latexmk",
  "latexindent",
  "synctex",
];

// Pretend, from the main process, that this machine has no TeX. Used to open the
// gate on a developer box that does have it, so the *handover* can be observed
// for real: the app's own re-detection then finds the actual TeX and must close
// the gate for good.
const injectMissingTex = async (electronApp) => {
  for (const command of TEX_COMMANDS) {
    await sendFromMain(electronApp, "env:checkResult", { command, available: false });
  }
  await sendFromMain(electronApp, "env:detectResult", {
    report: {
      hasEngine: false,
      source: "none",
      ready: false,
      distribution: { kind: "unknown", name: "", year: "", root: "", isTinytex: false },
      managedVariant: null,
      engines: {},
      tools: {},
      coverage: {
        level: "unknown",
        missingCore: [],
        missingRecommended: [],
        missingFull: [],
        probed: 0,
        found: 0,
      },
      recommendation: { action: "install", reason: "no-tex" },
      checkedAt: new Date().toISOString(),
    },
  });
};

test("the gauge shows progress and a remaining time, then hands over to the app", async () => {
  // TeX is really present here; the gate is opened by pretending it is not, so
  // that the install-finished handover runs against a genuine re-detection.
  const { electronApp, page, tmpDir } = await launch({ missingTools: false });
  try {
    await injectMissingTex(electronApp);
    await page.waitForSelector("#onboarding.is-visible", { timeout: 20_000 });

    // Same events a real install emits, without the download.
    await sendFromMain(electronApp, "env:installStart", { target: "basictex", variant: "light" });
    await page.waitForTimeout(400);
    let state = await gateState(page);
    assert.equal(state.progressShown, true, "starting an install should show the gauge");
    assert.equal(state.choiceShown, false);

    await sendFromMain(electronApp, "env:installProgress", {
      phase: "texlive",
      percent: 40,
      current: 80,
      total: 200,
    });
    await page.waitForTimeout(500);
    state = await gateState(page);
    assert.equal(state.percent, "40%");
    assert.equal(state.fillWidth, "40%");
    assert.match(state.eta, /\d|almost|まもなく/, `no remaining time shown: ${state.eta}`);
    assert.match(state.phase, /\(80\/200\)/, `phase should carry the count: ${state.phase}`);

    // A finished install hands straight over — no extra click — and the app's own
    // re-detection keeps it closed.
    await sendFromMain(electronApp, "env:installResult", {
      target: "basictex",
      variant: "light",
      success: true,
      message: "ready",
    });
    await page.waitForTimeout(4000);
    state = await gateState(page);
    assert.equal(state.visible, false, "the gate must close itself when the install finishes");
    assert.equal(state.bodyGated, false);
    assert.equal(state.launcherVisible, true, "the app should be there once TeX is");
  } finally {
    await closeElectronApp(electronApp);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("an install that leaves no usable TeX puts the user back in front of the choice", async () => {
  // The seam keeps TeX missing, so "success" is a lie here — the gate must not
  // hand over into an editor that cannot build.
  const { electronApp, page, tmpDir } = await launch({ missingTools: true });
  try {
    await page.waitForSelector("#onboarding.is-visible", { timeout: 20_000 });
    await sendFromMain(electronApp, "env:installStart", { target: "basictex", variant: "light" });
    await page.waitForTimeout(300);
    await sendFromMain(electronApp, "env:installResult", {
      target: "basictex",
      variant: "light",
      success: true,
      message: "ready",
    });
    await page.waitForTimeout(4000);
    const state = await gateState(page);
    assert.equal(state.visible, true, "TeX is still missing, so the gate must come back");
    assert.equal(state.choiceShown, true);
  } finally {
    await closeElectronApp(electronApp);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("a failed install says so and offers the choice again", async () => {
  const { electronApp, page, tmpDir } = await launch({ missingTools: true });
  try {
    await page.waitForSelector("#onboarding.is-visible", { timeout: 20_000 });
    await sendFromMain(electronApp, "env:installStart", { target: "basictex", variant: "light" });
    await page.waitForTimeout(400);
    await sendFromMain(electronApp, "env:installResult", {
      target: "basictex",
      success: false,
      message: "Download failed.",
    });
    await page.waitForTimeout(800);
    const state = await gateState(page);
    assert.equal(state.visible, true, "a failure must not drop the user into a broken app");
    assert.equal(state.choiceShown, true);
    const note = await page.evaluate(
      () => document.getElementById("onboarding-note")?.textContent?.trim() ?? ""
    );
    assert.match(note, /Download failed/);
  } finally {
    await closeElectronApp(electronApp);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
