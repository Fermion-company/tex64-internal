/**
 * Hands-on E2E for the Packages screen.
 *
 * Reads the real tlmgr catalogue on this machine and drives the search, the
 * filters and the row detail the way a person does. It deliberately never
 * clicks Install, Remove or Update: those mutate a real TeX Live (and on a
 * system installation would raise an administrator prompt), so the test asserts
 * that the controls are present and correctly labelled instead.
 *
 * Run:
 *   TEX64_E2E=1 node --test tests/e2e/packages-flow.test.cjs
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const ELECTRON_BIN = require("electron");

const closeElectronApp = async (electronApp) => {
  if (!electronApp) return;
  const child = typeof electronApp.process === "function" ? electronApp.process() : null;
  await Promise.race([
    electronApp.close().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
  if (child && !child.killed && child.exitCode == null) child.kill("SIGKILL");
};

const WORKSPACE = path.join(PROJECT_ROOT, "test-workspace");

// The launcher covers the whole app until a project is open, so the settings
// tab is not reachable before this.
const openPackagesPage = async () => {
  const { _electron: electron } = require("playwright");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-packages-e2e-"));
  const workspace = path.join(tmpDir, "workspace");
  fs.cpSync(WORKSPACE, workspace, { recursive: true });
  const electronApp = await electron.launch({
    executablePath: ELECTRON_BIN,
    args: [PROJECT_ROOT],
    env: {
      ...process.env,
      PATH: `/Library/TeX/texbin:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ""}`,
      TEX64_E2E: "1",
      TEX64_E2E_USERDATA: tmpDir,
      TEX64_E2E_FORCE_HEADLESS: "1",
      TEX64_E2E_OPEN_WORKSPACE_PATH: workspace,
      NODE_ENV: "test",
    },
    timeout: 60_000,
  });
  const page = await electronApp.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(4000);
  await page.evaluate(() => document.getElementById("announcement-modal-close")?.click());
  await page.waitForTimeout(600);
  await page.click("#launcher-open");
  await page.waitForTimeout(4000);
  await page.evaluate(() => document.getElementById("settings-close")?.click());
  await page.waitForTimeout(600);
  await page.click("#settings-tab");
  await page.waitForTimeout(600);
  await page.click('[data-settings-target="packages"]');
  // Reading ~5000 packages out of tlmgr takes a moment on first open.
  await page.waitForFunction(
    () => (document.querySelectorAll("#pkg-list .pkg-row").length ?? 0) > 0,
    null,
    { timeout: 90_000 }
  );
  return { electronApp, page, tmpDir };
};

const rows = (page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll("#pkg-list .pkg-row")).map((row) => ({
      name: row.querySelector(".pkg-name")?.textContent?.trim() ?? "",
      installed: row.classList.contains("is-installed"),
      state: row.querySelector(".pkg-state")?.textContent?.trim() ?? "",
      size: row.querySelector(".pkg-size")?.textContent?.trim() ?? "",
      // Install stays a labelled button; remove is a small red icon, so its
      // name lives in the accessible label.
      action:
        row.querySelector(".pkg-action")?.textContent?.trim() ||
        row.querySelector(".pkg-icon-action.is-remove")?.getAttribute("aria-label") ||
        "",
      actionKind: row.querySelector(".pkg-action.is-install")
        ? "install"
        : row.querySelector(".pkg-icon-action.is-remove")
          ? "remove"
          : "",
      hasDoc: Boolean(row.querySelector(".pkg-icon-action.is-doc")),
    }))
  );

// Subtests share one window, so each search starts from the same state: the
// filter chips persist otherwise and silently change what the next assertion
// is looking at.
const search = async (page, term) => {
  await page.click('[data-pkg-filter="all"]');
  await page.fill("#pkg-search", term);
  await page.waitForTimeout(400);
};

test("Packages screen", async (t) => {
  const { electronApp, page, tmpDir } = await openPackagesPage();
  try {
    await t.test("the catalogue loads and says which TeX it is managing", async () => {
    const scope = await page.evaluate(
      () => document.getElementById("pkg-scope")?.textContent?.trim() ?? ""
    );
    assert.ok(scope.length > 0, "the screen must say whose TeX it is about to change");
    assert.match(scope, /TeX/);

    const counts = await page.evaluate(() => ({
      all: document.querySelector('[data-pkg-count="all"]')?.textContent ?? "",
      installed: document.querySelector('[data-pkg-count="installed"]')?.textContent ?? "",
      available: document.querySelector('[data-pkg-count="available"]')?.textContent ?? "",
    }));
    assert.ok(Number(counts.all) > 1000, `expected a real catalogue, got ${counts.all}`);
      assert.equal(Number(counts.installed) + Number(counts.available), Number(counts.all));
    });

    await t.test("searching is instant and puts the obvious match first", async () => {
    await search(page, "tikz-cd");
    const found = await rows(page);
    assert.equal(found[0].name, "tikz-cd", `got ${found.slice(0, 3).map((r) => r.name).join(", ")}`);

    await search(page, "commutative diagrams");
    const byDescription = await rows(page);
    assert.ok(
      byDescription.some((row) => row.name === "tikz-cd"),
      "a description search should find the package you cannot name"
    );
    });

    await t.test("installed and not-installed are distinguishable without reading the label", async () => {
    await search(page, "tikz");
    const found = await rows(page);
    assert.ok(found.length > 1);
    for (const row of found) {
      // The row class, the state word and the button all agree — the dot and the
      // name weight hang off that same class in CSS.
      assert.equal(
        row.installed,
        row.actionKind === "remove",
        `${row.name}: state and action disagree`
      );
      assert.ok(row.state.length > 0, `${row.name} has no state label`);
    }
    const dots = await page.evaluate(() => {
      const installed = document.querySelector("#pkg-list .pkg-row.is-installed .pkg-dot");
      const notInstalled = document.querySelector(
        "#pkg-list .pkg-row:not(.is-installed) .pkg-dot"
      );
      const read = (el) => (el ? getComputedStyle(el).backgroundColor : null);
      return { installed: read(installed), notInstalled: read(notInstalled) };
    });
    if (dots.installed && dots.notInstalled) {
      assert.notEqual(
        dots.installed,
        dots.notInstalled,
        "the state dot must actually look different"
      );
    }
    });

    await t.test("the filters narrow the same list rather than sending you elsewhere", async () => {
    await search(page, "tikz");
    const all = await rows(page);
    assert.ok(all.some((row) => row.installed) || all.some((row) => !row.installed));

    await page.click('[data-pkg-filter="installed"]');
    await page.waitForTimeout(300);
    const installed = await rows(page);
    assert.equal(installed.every((row) => row.installed), true);

    await page.click('[data-pkg-filter="available"]');
    await page.waitForTimeout(300);
    const available = await rows(page);
    assert.equal(available.every((row) => !row.installed), true);
    assert.equal(available.every((row) => row.action.length > 0), true);
    });

    await t.test("opening a row shows the files that package actually contains", async () => {
    await search(page, "tikz-cd");
    await page.click('#pkg-list .pkg-row[data-name="tikz-cd"]');
    await page.waitForFunction(
      () => {
        const files = document.querySelector(
          '#pkg-list .pkg-row[data-name="tikz-cd"] .pkg-files'
        );
        return Boolean(files && /\.sty/.test(files.textContent ?? ""));
      },
      null,
      { timeout: 30_000 }
    );
    const files = await page.evaluate(
      () =>
        document.querySelector('#pkg-list .pkg-row[data-name="tikz-cd"] .pkg-files')
          ?.textContent ?? ""
    );
    assert.match(files, /tikz-cd\.sty/);
    });

    await t.test("a file name finds the package that owns it", async () => {
    // "tikzlibrarycd" is a file inside tikz-cd, not a package name and not in
    // any description — only the file search can find it.
    await search(page, "tikzlibrarycd");
    await page.waitForFunction(
      () =>
        Array.from(document.querySelectorAll("#pkg-extra .pkg-name")).some(
          (el) => el.textContent?.trim() === "tikz-cd"
        ),
      null,
      { timeout: 30_000 }
    );
    const section = await page.evaluate(
      () => document.querySelector("#pkg-extra .pkg-section")?.textContent?.trim() ?? ""
    );
    assert.match(section, /file|ファイル/i);
    });

    await t.test("the CTAN escape hatch reaches the network and reports back", async () => {
    await search(page, "commutative diagram");
    await page.click("#pkg-ctan");
    await page.waitForFunction(
      () => {
        const note = document.getElementById("pkg-note")?.textContent ?? "";
        const section = Array.from(document.querySelectorAll("#pkg-extra .pkg-section")).map(
          (el) => el.textContent ?? ""
        );
        return section.some((text) => /CTAN/i.test(text)) || /CTAN/i.test(note);
      },
      null,
      { timeout: 60_000 }
    );
    });

    await t.test("the destructive controls are present and honestly labelled, and are not clicked here", async () => {
    const update = await page.evaluate(() => {
      const button = document.getElementById("pkg-update");
      return { text: button?.textContent?.trim() ?? "", disabled: Boolean(button?.disabled) };
    });
    assert.ok(update.text.length > 0, "the one-tap update needs a label");
    assert.equal(update.disabled, false);

    await search(page, "siunitx");
    const found = await rows(page);
    const target = found.find((row) => row.name === "siunitx");
    assert.ok(target);
    assert.ok(target.action.length > 0);
    assert.equal(target.actionKind, target.installed ? "remove" : "install");
    // Documentation is only on disk for what is installed.
    assert.equal(target.hasDoc, target.installed);
    });

    // Clicking the documentation button hands the file to the OS viewer, so the
    // suite stops at asserting the button is there for installed packages only.
    // The path resolution itself is covered in tests/tex-package-manager.test.cjs.
  } finally {
    await closeElectronApp(electronApp);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
