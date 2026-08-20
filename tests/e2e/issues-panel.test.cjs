/**
 * Hands-on E2E for the Issues panel.
 *
 * Builds a document with a deliberate LaTeX error through the real toolchain,
 * then checks the contract the panel promises to a reader who has never opened
 * a TeX log:
 *   - the card explains what family of problem it is, what happened and what to
 *     change, in plain language;
 *   - the raw log is not on screen until the disclosure is opened;
 *   - a card with no location shows no location line;
 *   - clicking the card opens the offending file in the split pane at the line.
 *
 * Run:
 *   TEX64_E2E=1 node --test tests/e2e/issues-panel.test.cjs
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const ELECTRON_BIN = require("electron");

// One fatal error and one harmless warning, so the panel has both severities
// to render and the two can be told apart.
const BROKEN_DOCUMENT = `\\documentclass{article}
\\begin{document}
Hello, see \\ref{sec:nowhere}.
\\thiscommanddoesnotexist
\\end{document}
`;

const closeElectronApp = async (electronApp) => {
  if (!electronApp) return;
  const child = typeof electronApp.process === "function" ? electronApp.process() : null;
  await Promise.race([
    electronApp.close().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
  if (child && !child.killed && child.exitCode == null) child.kill("SIGKILL");
};

const launchWithBrokenDocument = async () => {
  const { _electron: electron } = require("playwright");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-issues-e2e-"));
  const workspace = path.join(tmpDir, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, "main.tex"), BROKEN_DOCUMENT, "utf8");

  const electronApp = await electron.launch({
    executablePath: ELECTRON_BIN,
    args: [PROJECT_ROOT],
    env: {
      ...process.env,
      PATH: `/Library/TeX/texbin:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ""}`,
      TEX64_E2E: "1",
      TEX64_E2E_USERDATA: tmpDir,
      TEX64_E2E_FORCE_HEADLESS: "0",
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
  await page.waitForTimeout(800);
  const opened = await page.evaluate(() => {
    const node = Array.from(document.querySelectorAll("#file-tree [data-path]"))
      .find((n) => /main\.tex$/.test(n.dataset.path || ""));
    node?.click();
    return node?.dataset.path ?? null;
  });
  assert.ok(opened, "the broken workspace did not open with a main.tex in the tree");
  await page.waitForTimeout(2500);
  return { electronApp, page };
};

test("Issues panel: a build error reads without the log", { timeout: 300_000 }, async (t) => {
  const { electronApp, page } = await launchWithBrokenDocument();
  t.after(() => closeElectronApp(electronApp));

  await t.test("building the broken document fills the Issues panel", async () => {
    await page.click("#build-button");
    // The first build starts the TeX engine, so give it real time.
    await page.waitForFunction(
      () => document.querySelectorAll("#issues-list .issue-item").length > 0,
      undefined,
      { timeout: 180_000 }
    );
    await page.click('[data-tab="issues"]');
    await page.waitForTimeout(600);
    const count = await page.evaluate(() => document.querySelectorAll("#issues-list .issue-item").length);
    assert.ok(count > 0, "the build reported no issues for a document that cannot compile");
  });

  await t.test("each card explains itself in plain language", async () => {
    const cards = await page.evaluate(() =>
      Array.from(document.querySelectorAll("#issues-list .issue-item")).map((card) => ({
        severity: card.dataset.severity,
        iconLabel: (card.querySelector(".issue-icon")?.getAttribute("aria-label") || "").trim(),
        iconShapes: card.querySelectorAll(".issue-icon svg *").length,
        kind: (card.querySelector(".issue-kind")?.textContent || "").trim(),
        summary: (card.querySelector(".issue-summary")?.textContent || "").trim(),
        fix: (card.querySelector(".issue-fix")?.textContent || "").trim(),
        jump: (card.querySelector(".issue-jump")?.textContent || "").trim(),
        hasDisclosure: !!card.querySelector(".issue-disclosure"),
      }))
    );
    for (const card of cards) {
      assert.ok(card.iconLabel, "a card's severity icon has no accessible label");
      assert.ok(card.iconShapes > 0, "a card's severity icon drew nothing");
      assert.ok(card.kind, `a card does not say what kind of problem it is: ${JSON.stringify(card)}`);
      assert.ok(card.summary, `a card has no summary: ${JSON.stringify(card)}`);
      assert.ok(card.fix, `a card offers no fix: ${JSON.stringify(card)}`);
      assert.ok(card.hasDisclosure, "a card has no way to reach its log");
      // The reader should never meet the log's own punctuation up front.
      assert.ok(!card.summary.startsWith("!"), `the summary is a raw log line: ${card.summary}`);
      assert.ok(!card.kind.startsWith("!"), `the kind is a raw log line: ${card.kind}`);
    }
    assert.ok(
      cards.some((card) => /Unknown command|知らないコマンド/.test(card.kind)),
      `the undefined command was not classified: ${JSON.stringify(cards.map((c) => c.kind))}`
    );
  });

  await t.test("the raw log stays hidden until the disclosure is opened", async () => {
    const before = await page.evaluate(() => {
      const card = document.querySelector("#issues-list .issue-item");
      const log = card.querySelector(".issue-log");
      return {
        hidden: log.hidden,
        painted: log.getBoundingClientRect().height > 0,
        expanded: card.querySelector(".issue-disclosure").getAttribute("aria-expanded"),
        logText: log.textContent.trim(),
      };
    });
    assert.equal(before.hidden, true, "the raw log is on screen before anyone asked for it");
    assert.equal(before.painted, false, "the raw log takes up space while hidden");
    assert.equal(before.expanded, "false", "the disclosure claims to be open while the log is hidden");
    assert.ok(before.logText.length > 0, "the disclosure would open an empty log");

    await page.click("#issues-list .issue-item .issue-disclosure");
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => {
      const card = document.querySelector("#issues-list .issue-item");
      const log = card.querySelector(".issue-log");
      return {
        hidden: log.hidden,
        painted: log.getBoundingClientRect().height > 0,
        expanded: card.querySelector(".issue-disclosure").getAttribute("aria-expanded"),
      };
    });
    assert.equal(after.hidden, false, "the disclosure did not reveal the log");
    assert.equal(after.painted, true, "the revealed log has no height");
    assert.equal(after.expanded, "true", "aria-expanded did not follow the disclosure");

    await page.click("#issues-list .issue-item .issue-disclosure");
    await page.waitForTimeout(300);
    assert.equal(
      await page.evaluate(() => document.querySelector("#issues-list .issue-item .issue-log").hidden),
      true,
      "the disclosure does not close again"
    );
  });

  await t.test("a card with no location shows no location line", async () => {
    const mismatched = await page.evaluate(() =>
      Array.from(document.querySelectorAll("#issues-list .issue-item")).filter((card) => {
        const jump = card.querySelector(".issue-jump");
        const log = (card.querySelector(".issue-log")?.textContent || "").trim();
        const hasLocation = /\.(tex|sty|cls|bib)(:\d+)?/.test(log.split("\n")[0] || "");
        return !hasLocation && jump && !/Settings|設定/.test(jump.textContent || "");
      }).length
    );
    assert.equal(mismatched, 0, "a card without a location still renders a location line");
  });

  await t.test("a warning does not look like an error", async () => {
    const tints = await page.evaluate(() => {
      const pick = (severity) => {
        const card = document.querySelector(`#issues-list .issue-item[data-severity="${severity}"]`);
        if (!card) return null;
        const icon = card.querySelector(".issue-icon");
        return {
          background: getComputedStyle(card).backgroundColor,
          border: getComputedStyle(card).borderTopColor,
          iconColor: getComputedStyle(icon).color,
          iconPaths: Array.from(icon.querySelectorAll("svg > *")).map((n) => n.tagName.toLowerCase()),
        };
      };
      return {
        error: pick("error"),
        warning: pick("warning"),
        seen: Array.from(document.querySelectorAll("#issues-list .issue-item")).map((card) => ({
          severity: card.dataset.severity,
          kind: (card.querySelector(".issue-kind")?.textContent || "").trim(),
        })),
      };
    });
    assert.ok(
      tints.error && tints.warning,
      `the build produced only one severity, so nothing to compare: ${JSON.stringify(tints.seen)}`
    );
    assert.notEqual(tints.error.background, tints.warning.background, "error and warning cards share a tint");
    assert.notEqual(tints.error.border, tints.warning.border, "error and warning cards share a border colour");
    assert.notEqual(tints.error.iconColor, tints.warning.iconColor, "the two severity icons share a colour");
    // Shape, not just colour: a disc for a stopped build, a triangle otherwise.
    assert.ok(tints.error.iconPaths.includes("circle"), `error icon is not a disc: ${tints.error.iconPaths}`);
    assert.ok(tints.warning.iconPaths.includes("path"), `warning icon is not a triangle: ${tints.warning.iconPaths}`);
    assert.notDeepEqual(tints.error.iconPaths, tints.warning.iconPaths, "both severities draw the same shape");
  });

  await t.test("clicking a card opens the error in the split pane", async () => {
    const target = await page.evaluate(() => {
      const card = Array.from(document.querySelectorAll("#issues-list .issue-item"))
        .find((item) => item.querySelector("button.issue-main .issue-jump"));
      if (!card) return null;
      card.querySelector("button.issue-main").click();
      return (card.querySelector(".issue-jump")?.textContent || "").trim();
    });
    assert.ok(target, "no card offered a jump target");
    await page.waitForTimeout(1500);
    const state = await page.evaluate(() => {
      const groups = document.getElementById("editor-groups");
      const secondary = document.querySelector('[data-editor-group="secondary"]');
      return {
        split: groups?.dataset.split,
        secondaryVisible: !!secondary && secondary.getBoundingClientRect().width > 0,
        highlighted: document.querySelectorAll(".issue-line-highlight, .issue-line-warning").length,
      };
    });
    assert.equal(state.split, "true", `clicking the issue did not turn on the split view (${JSON.stringify(state)})`);
    assert.ok(state.secondaryVisible, "the split pane did not lay out");
    assert.ok(state.highlighted > 0, "the error line was not highlighted in the editor");
  });
});
