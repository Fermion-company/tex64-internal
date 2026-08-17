/**
 * Hands-on E2E for Pro mode.
 *
 * Drives the real Electron app the way a person does — real mouse clicks and
 * drags at real coordinates, real key presses — through every Pro affordance:
 * the mode switch, both split layouts, pane collapse/expand, the splitter, the
 * structure drawer, the live-preview toggle, the whole figure canvas (each
 * drawing tool, undo/redo, the plot card, the More menu), TikZ insertion, the
 * figure gallery, the stash tray and region capture.
 *
 * It also guards two things that hands-on runs kept breaking:
 *   - the canvas must render in the app's locale. The i18n source language is
 *     English and initI18n() defaults every fresh profile to "en", so a
 *     hard-coded Japanese literal is untranslatable AND wrong for the default.
 *   - the stash tray must not start expanded on top of the editor.
 *
 * Run:
 *   TEX64_E2E=1 node --test tests/e2e/pro-mode-flow.test.cjs
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const WORKSPACE = path.join(PROJECT_ROOT, "test-workspace");
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

/**
 * Launch the app, clear the first-run overlays and open test-workspace with a
 * .tex file in the editor. Everything after this is Pro mode proper.
 */
const launchIntoWorkspace = async () => {
  const { _electron: electron } = require("playwright");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-pro-e2e-"));
  // Inserting a figure writes to the document, so work on a copy: the run must
  // not leave the repo's test-workspace dirty.
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
      // A real window: the canvas is driven by pointer coordinates, so it has
      // to lay out at a real size.
      TEX64_E2E_FORCE_HEADLESS: "0",
      TEX64_E2E_OPEN_WORKSPACE_PATH: workspace,
      NODE_ENV: "test",
    },
    timeout: 60_000,
  });

  const page = await electronApp.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(4000);

  // The announcement modal and the first-run environment check both cover the app.
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
  assert.ok(opened, "test-workspace did not open with a main.tex in the tree");
  await page.waitForTimeout(2500);

  return { electronApp, page, tmpDir };
};

const surfaceBox = (page) => page.locator("svg.pro-canvas-svg").boundingBox();
const objectCount = (page) =>
  page.evaluate(() => document.querySelectorAll("svg.pro-canvas-svg [data-id]:not(.pro-canvas-hit)").length);

const pickTool = async (page, tool) => {
  await page.click(`[data-tool="${tool}"]`);
  await page.waitForTimeout(300);
};

const dragOnCanvas = async (page, x1, y1, x2, y2) => {
  const b = await surfaceBox(page);
  await page.mouse.move(b.x + x1, b.y + y1);
  await page.mouse.down();
  await page.mouse.move(b.x + (x1 + x2) / 2, b.y + (y1 + y2) / 2, { steps: 6 });
  await page.mouse.move(b.x + x2, b.y + y2, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(500);
};

test("Pro mode: every affordance responds to real input", { timeout: 420_000 }, async (t) => {
  const { electronApp, page } = await launchIntoWorkspace();
  t.after(() => closeElectronApp(electronApp));

  await t.test("switching to Pro reveals the Pro controls", async () => {
    await page.click("#mode-tab-pro");
    await page.waitForTimeout(1200);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.proMode), "true");
    const visible = await page.evaluate(() => {
      const shown = (id) => {
        const el = document.getElementById(id);
        return !!el && !el.hidden && getComputedStyle(el).display !== "none";
      };
      return { draw: shown("pro-canvas-open"), figures: shown("pro-canvas-gallery"), split: shown("pro-layout-trigger") };
    });
    assert.deepEqual(visible, { draw: true, figures: true, split: true });
  });

  await t.test("layout 1 shows the preview pane, and it collapses and reopens", async () => {
    const box = await page.locator("#pro-preview-pane").boundingBox();
    assert.ok(box && box.width > 100, `preview pane not laid out: ${JSON.stringify(box)}`);

    await page.click('[data-pro-collapse="preview"]');
    await page.waitForTimeout(500);
    assert.ok(
      await page.evaluate(() => document.getElementById("editor-groups").classList.contains("is-preview-collapsed")),
      "preview pane did not collapse"
    );

    // A collapsed pane is a thin strip; clicking it reopens the pane.
    const strip = await page.locator("#pro-preview-pane").boundingBox();
    await page.mouse.click(strip.x + strip.width / 2, strip.y + strip.height / 2);
    await page.waitForTimeout(500);
    assert.ok(
      await page.evaluate(() => !document.getElementById("editor-groups").classList.contains("is-preview-collapsed")),
      "clicking the collapsed strip did not reopen the pane"
    );
  });

  await t.test("dragging the splitter resizes the panes", async () => {
    const ratio = () =>
      page.evaluate(() => getComputedStyle(document.getElementById("editor-groups")).getPropertyValue("--pro-pane-a"));
    const before = await ratio();
    const s = await page.locator("#pro-splitter-primary").boundingBox();
    await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2);
    await page.mouse.down();
    await page.mouse.move(s.x + 200, s.y + s.height / 2, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    assert.notEqual((await ratio()).trim(), before.trim(), "splitter drag left the ratio unchanged");
  });

  await t.test("layout 2 shows the reference pane, and layout 1 comes back", async () => {
    await page.hover("#pro-layout-trigger");
    await page.waitForTimeout(250);
    await page.click('[data-pro-layout="source-reference-code"]');
    await page.waitForTimeout(900);
    const ref = await page.locator("#pro-reference-pane").boundingBox();
    assert.ok(ref && ref.width > 100, `reference pane not laid out: ${JSON.stringify(ref)}`);
    assert.equal(await page.evaluate(() => document.getElementById("editor-groups").dataset.proLayout), "source-reference-code");

    await page.hover("#pro-layout-trigger");
    await page.waitForTimeout(250);
    await page.click('[data-pro-layout="preview-source"]');
    await page.waitForTimeout(800);
    assert.equal(await page.evaluate(() => document.getElementById("editor-groups").dataset.proLayout), "preview-source");
  });

  await t.test("the structure drawer lists the document and Esc closes it", async () => {
    await page.click("#pro-structure-button");
    await page.waitForTimeout(1200);
    const entries = await page.evaluate(() =>
      Array.from(document.querySelectorAll("#pro-structure-drawer [data-line], #pro-structure-drawer button, #pro-structure-drawer li"))
        .map((n) => (n.textContent || "").trim())
        .filter(Boolean));
    assert.ok(entries.length > 0, "structure drawer listed nothing");

    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    assert.equal(await page.evaluate(() => document.getElementById("pro-structure-drawer")?.hidden), true);
  });

  await t.test("the live-preview toggle answers a click", async () => {
    await page.click("#pro-preview-live-toggle");
    await page.waitForTimeout(2500);
    const state = await page.evaluate(() => ({
      pressed: document.getElementById("pro-preview-live-toggle")?.getAttribute("aria-pressed"),
      status: (document.getElementById("pro-preview-live-status")?.textContent || "").trim(),
    }));
    assert.ok(state.pressed === "true" || state.status.length > 0, `no feedback from the Live toggle: ${JSON.stringify(state)}`);
    await page.click("#pro-preview-live-toggle");
    await page.waitForTimeout(600);
  });

  await t.test("the stash tray starts collapsed instead of covering the editor", async () => {
    const tray = await page.evaluate(() => {
      const el = document.querySelector(".pro-stash");
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        collapsed: el.classList.contains("is-collapsed"),
        width: Math.round(r.width),
        label: (el.querySelector("header strong")?.textContent || "").trim(),
      };
    });
    assert.ok(tray, "the stash tray is missing in Pro mode");
    assert.ok(tray.collapsed, `the stash tray starts expanded (${tray.width}px) over the editor`);
    assert.ok(tray.label, "the collapsed tray shows no name, so nobody can find it");
  });

  await t.test("the canvas opens with every drawing tool", async () => {
    await page.click("#pro-canvas-open");
    await page.waitForTimeout(1500);
    const box = await surfaceBox(page);
    assert.ok(box && box.width > 200, "the canvas surface did not lay out");
    const tools = await page.evaluate(() =>
      Array.from(document.querySelectorAll("[data-tool]")).map((n) => n.dataset.tool));
    for (const tool of ["select", "pen", "line", "rect", "ellipse", "node", "code", "plot"]) {
      assert.ok(tools.includes(tool), `the ${tool} tool is missing from the rail`);
    }
  });

  await t.test("the canvas UI renders in the app locale, not hard-coded Japanese", async () => {
    const japanese = await page.evaluate(() => {
      const JP = /[぀-ゟ゠-ヿ一-龯]/;
      const found = [];
      const root = document.querySelector(".pro-canvas-overlay");
      if (!root) return ["no canvas overlay"];
      const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walk.nextNode())) {
        const text = (node.textContent || "").trim();
        if (text && JP.test(text)) found.push(text.slice(0, 60));
      }
      root.querySelectorAll("[title],[aria-label],[placeholder]").forEach((el) => {
        for (const attr of ["title", "aria-label", "placeholder"]) {
          const value = el.getAttribute(attr);
          if (value && JP.test(value)) found.push(`@${attr}: ${value.slice(0, 60)}`);
        }
      });
      return [...new Set(found)];
    });
    assert.deepEqual(japanese, [], `hard-coded Japanese with locale=en: ${JSON.stringify(japanese.slice(0, 8))}`);
  });

  await t.test("each drawing tool adds an object", async () => {
    let count = await objectCount(page);
    for (const [tool, box] of [
      ["rect", [180, 160, 380, 300]],
      ["ellipse", [430, 160, 600, 290]],
      ["line", [180, 360, 420, 460]],
    ]) {
      await pickTool(page, tool);
      await dragOnCanvas(page, ...box);
      const next = await objectCount(page);
      assert.ok(next > count, `the ${tool} tool drew nothing (${count} -> ${next})`);
      count = next;
    }

    // The pen is click-to-place; Enter finishes the path.
    await pickTool(page, "pen");
    const b = await surfaceBox(page);
    for (const [x, y] of [[560, 380], [660, 460], [760, 360]]) {
      await page.mouse.click(b.x + x, b.y + y);
      await page.waitForTimeout(250);
    }
    await page.keyboard.press("Enter");
    await page.waitForTimeout(600);
    assert.ok(await objectCount(page) > count, "the pen drew nothing");
  });

  await t.test("clicking the start point closes the path", async () => {
    const before = await objectCount(page);
    await pickTool(page, "pen");
    const b = await surfaceBox(page);
    for (const [x, y] of [[150, 560], [250, 640], [350, 560]]) {
      await page.mouse.click(b.x + x, b.y + y);
      await page.waitForTimeout(250);
    }
    // Back onto the first point: within the 10-screen-px close radius.
    await page.mouse.click(b.x + 150, b.y + 560);
    await page.waitForTimeout(600);
    assert.equal(await objectCount(page), before + 1, "closing did not leave exactly one new object");
    const closed = await page.evaluate(() => {
      const nodes = document.querySelectorAll("svg.pro-canvas-svg path[data-id]:not(.pro-canvas-hit)");
      const last = nodes[nodes.length - 1];
      return last ? /Z\s*$/i.test(last.getAttribute("d") || "") : null;
    });
    assert.equal(closed, true, "the click on the start point did not close the path");
  });

  await t.test("pen follows the raw cursor and the rubber band never dies", async () => {
    await pickTool(page, "pen");
    const b = await surfaceBox(page);
    // Two anchors in an empty region (upper right, clear of everything drawn
    // so far). Sized relative to the surface: absolute pixels overflow the
    // svg on smaller windows.
    const p1 = { x: b.x + b.width * 0.74, y: b.y + b.height * 0.25 };
    const p2 = { x: b.x + b.width * 0.8, y: b.y + b.height * 0.3 };
    await page.mouse.click(p1.x, p1.y);
    await page.waitForTimeout(250);
    await page.mouse.click(p2.x, p2.y);
    await page.waitForTimeout(250);

    // The scene<->screen transform, read off the paper rect itself.
    const t2 = await page.evaluate(() => {
      const paper = document.querySelector("svg.pro-canvas-svg .pro-canvas-paper");
      const r = paper.getBoundingClientRect();
      const box = paper.getBBox();
      return { left: r.left, top: r.top, scale: r.width / box.width };
    });

    // Hover 0.6mm to the right of a 5mm grid line: with the old magnet
    // (capture range grid*0.25 = 1.25mm) the preview point would stick to the
    // line; now it must sit exactly under the cursor.
    const sceneY = (p2.y - t2.top) / t2.scale;
    const gx = Math.round(((b.x + b.width * 0.86 - t2.left) / t2.scale) / 5) * 5 + 0.6;
    await page.mouse.move(t2.left + gx * t2.scale, t2.top + sceneY * t2.scale);
    await page.waitForTimeout(300);
    const ghostX = await page.evaluate(() =>
      Number(document.querySelector("circle.pro-canvas-pen-ghost")?.getAttribute("cx")));
    assert.ok(Math.abs(ghostX - gx) < 0.15, `preview point detached from the cursor: cx=${ghostX}, cursor=${gx}`);

    // Inside the 8px finish zone the rubber band must keep stretching, and the
    // last anchor grows a ring to predict that a click finishes the stroke.
    await page.mouse.move(p2.x + 4, p2.y);
    await page.waitForTimeout(300);
    const zone = await page.evaluate(() => {
      const path = Array.from(document.querySelectorAll("svg.pro-canvas-svg path[data-id]:not(.pro-canvas-hit)")).pop();
      const d = path?.getAttribute("d") || "";
      const anchors = document.querySelectorAll("circle.pro-canvas-pen-anchor");
      return {
        drawnSegments: (d.match(/[CL]/g) || []).length,
        finishRing: !!document.querySelector("circle.pro-canvas-pen-anchor.is-close"),
        anchorCount: anchors.length,
      };
    });
    assert.equal(zone.drawnSegments, 2, `rubber band vanished in the finish zone (segments=${zone.drawnSegments})`);
    assert.ok(zone.finishRing, "no ring on the last anchor to predict that a click finishes");

    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);
  });

  await t.test("marquee selection fills the inspector", async () => {
    await pickTool(page, "select");
    await dragOnCanvas(page, 120, 120, 820, 500);
    const feedback = await page.evaluate(() => ({
      markers: document.querySelectorAll(".pro-canvas-selection, [data-selected='true'], .is-selected").length,
      inspector: (document.querySelector(".pro-canvas-style")?.textContent || "").trim().length,
    }));
    assert.ok(feedback.markers > 0 || feedback.inspector > 0, `selection produced no feedback: ${JSON.stringify(feedback)}`);
  });

  await t.test("undo removes the last object and redo restores it", async () => {
    const before = await objectCount(page);
    await page.click('[data-action="undo"]');
    await page.waitForTimeout(500);
    const undone = await objectCount(page);
    assert.ok(undone < before, `undo did nothing (${before} -> ${undone})`);
    await page.click('[data-action="redo"]');
    await page.waitForTimeout(500);
    assert.equal(await objectCount(page), before, "redo did not restore the object");
  });

  await t.test("a plot with an expression survives Esc; an empty one is discarded", async () => {
    const base = await objectCount(page);
    await pickTool(page, "plot");
    const b = await surfaceBox(page);
    await page.mouse.click(b.x + 640, b.y + 620);
    await page.waitForTimeout(1200);
    const placed = await objectCount(page);
    assert.ok(placed > base, `the graph tool placed nothing (${base} -> ${placed})`);

    const focused = await page.evaluate(() => {
      const field = document.querySelector(".pro-canvas-plot-card .pro-canvas-plot-expr");
      if (!field) return false;
      field.focus();
      return true;
    });
    assert.ok(focused, "the plot card has no expression field");
    await page.keyboard.type("sin(x)");
    await page.waitForTimeout(700);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(800);
    assert.equal(await objectCount(page), placed, "Esc destroyed a plot that had an expression");

    // Placing a plot and leaving it blank is a cancel, and must not leave debris.
    await pickTool(page, "plot");
    await page.mouse.click(b.x + 300, b.y + 640);
    await page.waitForTimeout(1200);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(800);
    assert.equal(await objectCount(page), placed, "discarding an empty plot did not restore the scene");
  });

  await t.test("the snap toggle and the More menu work", async () => {
    const label = () => page.evaluate(() => (document.querySelector('[data-action="snap"]')?.textContent || "").trim());
    const before = await label();
    await page.click('[data-action="snap"]');
    await page.waitForTimeout(300);
    assert.notEqual(await label(), before, `the snap toggle label never changed (${before})`);
    await page.click('[data-action="snap"]');
    await page.waitForTimeout(300);

    await page.click('[data-action="more"]');
    await page.waitForTimeout(400);
    const items = await page.evaluate(() =>
      Array.from(document.querySelectorAll(".pro-canvas-more-menu button"))
        .filter((b) => b.getBoundingClientRect().width > 0)
        .map((b) => (b.textContent || "").trim()));
    assert.ok(items.length >= 3, `the More menu showed ${items.length} item(s): ${JSON.stringify(items)}`);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  });

  await t.test("inserting TikZ writes the figure into the document and closes the canvas", async () => {
    await page.click('[data-action="tikz"]');
    await page.waitForTimeout(2500);
    const inserted = await page.evaluate(() => {
      const values = (window.monaco?.editor?.getModels?.() || []).map((m) => m.getValue());
      return {
        tikz: values.some((v) => v.includes("\\begin{tikzpicture}")),
        metadata: values.some((v) => v.includes("tex64-figure")),
      };
    });
    assert.ok(inserted.tikz, "no tikzpicture reached any editor model");
    assert.ok(inserted.metadata, "the %% tex64-figure metadata line is missing, so the figure cannot be reopened");
    assert.ok(await page.evaluate(() => !document.querySelector("svg.pro-canvas-svg")), "the canvas stayed open after inserting");
  });

  await t.test("the gallery lists the inserted figure and Esc closes it", async () => {
    await page.click("#pro-canvas-gallery");
    await page.waitForTimeout(3000);
    const rows = await page.evaluate(() =>
      Array.from(document.querySelectorAll(".pro-canvas-gallery-row .pro-canvas-gallery-label"))
        .map((n) => (n.textContent || "").trim()));
    assert.ok(rows.length > 0, "the gallery listed no figures right after an insert");

    await page.keyboard.press("Escape");
    await page.waitForTimeout(600);
    assert.equal(await page.evaluate(() => !!document.querySelector(".pro-canvas-gallery-modal")), false, "Esc did not close the gallery");
  });

  await t.test("the stash takes an editor selection and clears it", async () => {
    await page.click(".pro-stash [data-stash-toggle]");
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      const editor = window.monaco?.editor?.getEditors?.()[0];
      if (!editor) return;
      editor.focus();
      editor.setSelection(new window.monaco.Range(1, 1, 3, 1));
    });
    await page.waitForTimeout(300);
    await page.click("[data-stash-selection]");
    await page.waitForTimeout(800);
    assert.ok(
      await page.evaluate(() => document.querySelectorAll(".pro-stash-list > *").length) > 0,
      "the stash stayed empty after + Selection"
    );

    await page.click("[data-stash-clear]");
    await page.waitForTimeout(600);
    assert.equal(await page.evaluate(() => document.querySelectorAll(".pro-stash-list > *").length), 0);
  });

  await t.test("switching the app to Japanese renders the canvas in Japanese", async () => {
    await page.evaluate(() => {
      const select = document.getElementById("settings-ui-language");
      select.value = "ja";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.waitForTimeout(1200);

    // The static chrome is translated by the i18n MutationObserver, one text
    // node at a time — so a sentence broken up by inline markup silently stops
    // matching its dictionary key. Check a whole sentence, not just a word.
    const chrome = await page.evaluate(() => ({
      draw: (document.getElementById("pro-canvas-open")?.textContent || "").trim(),
      structure: (document.getElementById("pro-structure-button")?.textContent || "").trim(),
      previewEmpty: (document.querySelector("#pro-preview-viewer .editor-viewer-message p")?.textContent || "").trim(),
    }));
    const JP_RE = /[぀-ゟ゠-ヿ一-龯]/;
    for (const [key, value] of Object.entries(chrome)) {
      assert.ok(JP_RE.test(value), `Japanese locale did not reach ${key}: ${JSON.stringify(value)}`);
    }

    await page.click("#pro-canvas-open");
    await page.waitForTimeout(1500);
    const japanese = await page.evaluate(() => {
      const JP = /[぀-ゟ゠-ヿ一-龯]/;
      const labels = Array.from(document.querySelectorAll(".pro-canvas-overlay [data-tool] span"))
        .map((n) => (n.textContent || "").trim());
      return { labels, allJapanese: labels.length > 0 && labels.filter((l) => JP.test(l)).length >= labels.length - 1 };
    });
    assert.ok(japanese.allJapanese, `Japanese locale did not reach the tool rail: ${JSON.stringify(japanese.labels)}`);

    await page.click('[data-action="cancel"]');
    await page.waitForTimeout(800);
    await page.evaluate(() => {
      const select = document.getElementById("settings-ui-language");
      select.value = "en";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.waitForTimeout(1000);
  });

  await t.test("region capture opens a crop selection", async () => {
    await page.click('[data-pro-capture="preview"]');
    await page.waitForTimeout(900);
    const overlay = await page.evaluate(() =>
      Array.from(document.querySelectorAll("[class*='capture'], [class*='crop']"))
        .some((n) => n.getBoundingClientRect().width > 0));
    assert.ok(overlay, "⌖ Select produced no capture overlay");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
  });
});
