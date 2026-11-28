"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const { chromium } = require("playwright");

const web = path.join(__dirname, "../Resources/web");
const styles = [...fs.readFileSync(path.join(web, "index.html"), "utf8")
  .matchAll(/<link rel="stylesheet" href="\.\/([^"]+)"/g)].map((match) => match[1]);

test("Monaco find close stays aligned and clickable across pane widths and themes", async (t) => {
  const browser = await chromium.launch({ headless: true,
    args: process.env.TEX64_TEST_CHROMIUM_SINGLE_PROCESS ? ["--single-process", "--disable-gpu"] : [],
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route("http://monaco.test/**", (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/") {
      return route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><meta charset="utf-8">
          ${styles.map((file) => `<link rel="stylesheet" href="/${file}">`).join("")}
          <div id="ed" style="width:800px;height:320px"></div>
          <script src="/vs/loader.js"></script>`,
      });
    }
    if (pathname === "/monaco-theme.js") {
      return route.fulfill({
        contentType: "text/javascript",
        body: ts.transpileModule(fs.readFileSync(path.resolve(web, "../../web-src/app/monaco-theme.ts"), "utf8"), {
          compilerOptions: { module: ts.ModuleKind.ES2020, target: ts.ScriptTarget.ES2019 },
        }).outputText,
      });
    }
    const file = path.join(web, pathname.startsWith("/vs/") ? "monaco" : "", pathname);
    if (!fs.existsSync(file)) return route.fulfill({ status: 404 });
    return route.fulfill({ path: file });
  });
  await page.goto("http://monaco.test/");
  await page.evaluate(() => new Promise((resolve) => {
    window.MonacoEnvironment = { getWorkerUrl: () => "data:text/javascript,;" };
    require.config({ paths: { vs: "/vs" } });
    require(["vs/editor/editor.main"], () => {
      const ready = () => {
        window.editor = monaco.editor.create(document.getElementById("ed"), {
          value: "Unrelated text",
          minimap: { enabled: false },
        });
        editor.focus();
        resolve();
      };
      // editor.main.js adds its stylesheet without waiting for it. A find
      // widget opened before it applies measures its match count across the
      // whole bare widget, and Monaco keeps that width as the count's minimum
      // for good: the input shrinks to 14 px and its option toggles cover the
      // replace chevron. The app opens Find long after this has loaded.
      const css = [...document.querySelectorAll('link[rel="stylesheet"]')]
        .find((link) => link.href.includes("editor.main.css"));
      if (css && !css.sheet) {
        css.addEventListener("load", ready, { once: true });
        css.addEventListener("error", ready, { once: true });
      } else {
        ready();
      }
    });
  }));
  const isMac = await page.evaluate(() => navigator.platform.includes("Mac"));
  await page.keyboard.press(isMac ? "Meta+f" : "Control+f");
  const find = page.locator(".find-widget.visible");
  await find.locator(".find-part .input").fill("展開について");
  await find.locator(".matchesCount").getByText("No results").waitFor();
  await page.waitForFunction(() =>
    getComputedStyle(document.querySelector(".find-widget.visible")).transform === "matrix(1, 0, 0, 1, 0, 0)");

  const cases = [];
  for (const theme of ["light", "dark"]) {
    await page.evaluate(async (theme) => {
      const { applyMonacoTheme } = await import("/monaco-theme.js");
      document.documentElement.dataset.theme = theme;
      applyMonacoTheme(monaco, theme);
    }, theme);
    for (const [width, layout] of [[800, null], [430, "reduced"], [350, "narrow"], [215, "collapsed"]]) {
      await page.evaluate((width) => {
        document.getElementById("ed").style.width = width + "px";
        editor.layout();
      }, width);
      for (const expanded of [false, true]) {
        if (expanded) await find.locator(".button.toggle").click();
        const geometry = await find.evaluate((widget) => {
          const box = (el) => el.getBoundingClientRect();
          const close = widget.querySelector(".codicon-widget-close");
          const closeBox = box(close);
          const center = (rect) => rect.top + rect.height / 2;
          const parent = box(widget);
          const actions = [...widget.querySelectorAll(".find-actions .button, .codicon-find-selection")]
            .map(box).filter((rect) => rect.width);
          const hit = document.elementFromPoint(closeBox.left + closeBox.width / 2, center(closeBox));
          const toggle = widget.querySelector(".button.toggle");
          const toggleBox = box(toggle);
          return {
            layout: ["collapsed", "narrow", "reduced"].find((mode) =>
              widget.classList.contains(mode + "-find-widget")) ?? null,
            expanded: widget.classList.contains("replaceToggled"),
            centerOffsets: actions.map((rect) => center(closeBox) - center(rect)),
            closeSize: [closeBox.width, closeBox.height],
            rightInset: parent.right - closeBox.right,
            gap: closeBox.left - Math.max(...actions.map((rect) => rect.right)),
            inWidget: closeBox.top >= parent.top && closeBox.bottom <= parent.bottom,
            hit: close.contains(hit),
            // The replace chevron must stay clickable (nothing laid over it).
            toggleHit: toggle.contains(document.elementFromPoint(
              toggleBox.left + toggleBox.width / 2, center(toggleBox))),
            findInputWidth: box(widget.querySelector(".find-part .monaco-findInput")).width,
          };
        });
        cases.push({ theme, width, layout, expanded, geometry });
        if (expanded) await find.locator(".button.toggle").click();
      }
    }
  }

  const failures = cases.filter(({ layout, expanded, geometry: g }) =>
    g.layout !== layout ||
    g.expanded !== expanded || !g.centerOffsets.length ||
    g.centerOffsets.some((offset) => Math.abs(offset) > 0.5) || g.closeSize.join("x") !== "22x22" ||
    g.rightInset < 4 || g.rightInset > 5 || g.gap < 0 || !g.inWidget || !g.hit ||
    // The input never collapses (58 px in Monaco's collapsed layout; 14 px when broken).
    !g.toggleHit || g.findInputWidth < 40);
  assert.deepEqual(failures, []);
  await find.locator(".codicon-widget-close").click();
  await find.waitFor({ state: "hidden" });
});
