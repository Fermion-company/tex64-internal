const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const WORKSPACE = path.join(PROJECT_ROOT, "test-workspace");
const ELECTRON_BIN = require("electron");

const closeElectronApp = async (app) => {
  if (!app) return;
  const child = app.process?.();
  await Promise.race([
    app.close().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
  if (child && !child.killed && child.exitCode == null) child.kill("SIGKILL");
};

const waitFor = async (read, accept, timeoutMs = 30_000) => {
  const started = Date.now();
  let value;
  while (Date.now() - started < timeoutMs) {
    value = await read();
    if (accept(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("condition timed out; last value: " + JSON.stringify(value));
};

const waitForVisibleRegion = async (frame, match, timeoutMs = 30_000) => waitFor(
  async () => {
    const snapshot = await frame.evaluate(() =>
      fetch("/dom", { cache: "no-store" }).then((response) => response.json())
    );
    const region = snapshot.blocks?.flatMap((block) =>
      (block.editRegions || []).map((item) => ({ blockId: block.id, blockSource: block.source, ...item }))
    ).find(match);
    if (!region) return null;
    if (snapshot.mode === "opaque") {
      const visible = await frame.evaluate(() => Boolean(document.querySelector("#pages > .page.is-final")));
      return visible ? region : null;
    }
    const visible = await frame.evaluate((id) =>
      Boolean(document.querySelector(`[data-src="${CSS.escape(id)}"]`)), region.blockId);
    return visible ? region : null;
  },
  Boolean,
  timeoutMs
);

const canonicalRegionRect = async (frame, region) => frame.evaluate(async (target) => {
  const snapshot = await fetch("/dom", { cache: "no-store" }).then((response) => response.json());
  if (snapshot.mode !== "opaque") return null;
  if (target.kind === "text") {
    const response = await fetch(`/canonical/boxes?c=${snapshot.canonical?.id}`, { cache: "no-store" });
    const pages = response.ok ? (await response.json()).pages || [] : [];
    const key = (input) => String(input || "").normalize("NFKC").replace(/\s+/g, "");
    const wanted = key(target.value);
    for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
      const words = pages[pageIndex];
      for (let start = 0; start < words.length; start++) {
        let joined = "";
        for (let end = start; end < words.length && joined.length <= wanted.length; end++) {
          joined += key(words[end].text);
          if (joined === wanted) {
            const group = words.slice(start, end + 1);
            const page = document.querySelector(`#pages > .page[data-page="${pageIndex + 1}"]`);
            if (!page) return null;
            page.scrollIntoView({ block: "center" });
            await page.querySelector("img.canon")?.decode?.().catch(() => {});
            const rect = page.getBoundingClientRect();
            const paper = snapshot.canonical?.paper || { w: 612, h: 792 };
            const box = {
              left: Math.min(...group.map((item) => item.left)),
              top: Math.min(...group.map((item) => item.top)),
              right: Math.max(...group.map((item) => item.right)),
              bottom: Math.max(...group.map((item) => item.bottom)),
            };
            return {
              left: rect.left + (box.left / paper.w) * rect.width,
              top: rect.top + (box.top / paper.h) * rect.height,
              right: rect.left + (box.right / paper.w) * rect.width,
              bottom: rect.top + (box.bottom / paper.h) * rect.height,
            };
          }
          if (!wanted.startsWith(joined)) break;
        }
      }
    }
  }
  const generated = Number(target.source?.end?.line) < Number(target.blockSource?.start?.line);
  if (generated) {
    const page = document.querySelector('#pages > .page[data-page="1"]');
    if (!page) return null;
    page.scrollIntoView({ block: "center" });
    await page.querySelector("img.canon")?.decode?.().catch(() => {});
    const rect = page.getBoundingClientRect();
    return {
      left: rect.left + rect.width * 0.12,
      top: rect.top + rect.height * 0.04,
      right: rect.right - rect.width * 0.12,
      bottom: rect.top + rect.height * 0.24,
    };
  }
  const response = await fetch("/synctex/forward", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: snapshot.canonical?.id,
      locations: [target.source?.start, target.source?.end].map((position) => ({
        file: target.source?.file,
        line: position?.line,
        column: position?.column,
      })),
    }),
  });
  const anchors = response.ok ? (await response.json()).results?.filter(Boolean) || [] : [];
  if (!anchors.length) return null;
  const pageNumber = anchors[0].page;
  const page = document.querySelector(`#pages > .page[data-page="${pageNumber}"]`);
  if (!page) return null;
  page.scrollIntoView({ block: "center" });
  await page.querySelector("img.canon")?.decode?.().catch(() => {});
  const pageRect = page.getBoundingClientRect();
  const paper = snapshot.canonical?.paper || { w: 612, h: 792 };
  const box = {
    left: Math.min(...anchors.map((item) => item.box.left)),
    top: Math.min(...anchors.map((item) => item.box.top)),
    right: Math.max(...anchors.map((item) => item.box.right)),
    bottom: Math.max(...anchors.map((item) => item.box.bottom)),
  };
  return {
    left: pageRect.left + (box.left / paper.w) * pageRect.width,
    top: pageRect.top + (box.top / paper.h) * pageRect.height,
    right: pageRect.left + (box.right / paper.w) * pageRect.width,
    bottom: pageRect.top + (box.bottom / paper.h) * pageRect.height,
  };
}, region);

const presentedCanonicalTextRect = async (frame, region) => frame.evaluate(async (target) => {
  const key = (input) => String(input || "").normalize("NFKC").replace(/\s+/g, "");
  const wanted = key(target.value);
  for (const page of document.querySelectorAll("#pages > .page[data-page]")) {
    const pageNumber = Number(page.dataset.page);
    const id = Number(page.dataset.canonPresentedId);
    if (!Number.isInteger(pageNumber) || !Number.isFinite(id)) continue;
    const response = await fetch(`/canonical/boxes?c=${id}`, { cache: "no-store" });
    if (!response.ok) continue;
    const words = (await response.json()).pages?.[pageNumber - 1] || [];
    for (let start = 0; start < words.length; start++) {
      let joined = "";
      for (let end = start; end < words.length && joined.length <= wanted.length; end++) {
        joined += key(words[end].text);
        if (joined === wanted) {
          const group = words.slice(start, end + 1);
          page.scrollIntoView({ block: "center" });
          const pageRect = page.getBoundingClientRect();
          const paper = {
            w: Number(page.dataset.canonPaperW) || 612,
            h: Number(page.dataset.canonPaperH) || 792,
          };
          const box = {
            left: Math.min(...group.map((item) => item.left)),
            top: Math.min(...group.map((item) => item.top)),
            right: Math.max(...group.map((item) => item.right)),
            bottom: Math.max(...group.map((item) => item.bottom)),
          };
          return {
            left: pageRect.left + (box.left / paper.w) * pageRect.width,
            top: pageRect.top + (box.top / paper.h) * pageRect.height,
            right: pageRect.left + (box.right / paper.w) * pageRect.width,
            bottom: pageRect.top + (box.bottom / paper.h) * pageRect.height,
          };
        }
        if (!wanted.startsWith(joined)) break;
      }
    }
  }
  return null;
}, region);

const screenshotFrameRect = async (page, frame, rect, padding = 4) => {
  const frameElement = await frame.frameElement();
  const frameBox = await frameElement.boundingBox();
  await frameElement.dispose();
  assert.ok(frameBox, "live-preview frame has viewport geometry");
  const viewport = page.viewportSize() ?? await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  const left = Math.max(0, frameBox.x + rect.left - padding);
  const top = Math.max(0, frameBox.y + rect.top - padding);
  const right = Math.min(viewport.width, frameBox.x + rect.right + padding);
  const bottom = Math.min(viewport.height, frameBox.y + rect.bottom + padding);
  return page.screenshot({
    animations: "disabled",
    caret: "hide",
    style: ".tdom-direct-editor, .tdom-direct-editor * { caret-color: transparent !important; --caret-color: transparent !important; }",
    clip: { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) },
  });
};

const measureMathRegionRect = async (frame, region) => {
  const measured = await frame.evaluate((target) => {
  const exactNodes = [...document.querySelectorAll(`[data-edit="${CSS.escape(target.id)}"]`)]
    .filter((node) => !node.classList.contains("tdom-direct-editor"));
  const blockStart = Number(target.blockSource?.start?.line);
  const firstLine = Number(target.source?.start?.line) - blockStart;
  const lastLine = Number(target.source?.end?.line) - blockStart;
  const fallback = [...document.querySelectorAll(`[data-src="${CSS.escape(target.blockId)}"][data-line]`)]
    .filter((node) => {
      const line = Number(node.dataset.line);
      const inRegion = !Number.isFinite(firstLine) || !Number.isFinite(lastLine) ||
        (line >= firstLine && line <= lastLine);
      return inRegion && (node.dataset.math === "1" || node.classList.contains("tdom-source-hit"));
    });
  const nodes = exactNodes.length ? exactNodes : fallback;
  const rects = nodes.map((node) => node.getBoundingClientRect()).filter((rect) => rect.width || rect.height);
  return rects.length ? {
    left: Math.min(...rects.map((rect) => rect.left)),
    top: Math.min(...rects.map((rect) => rect.top)),
    right: Math.max(...rects.map((rect) => rect.right)),
    bottom: Math.max(...rects.map((rect) => rect.bottom)),
  } : null;
  }, region);
  return measured ?? canonicalRegionRect(frame, region);
};

const measureTextRegionRect = async (frame, region) => {
  const measured = await frame.evaluate((target) => {
  const exactNodes = [...document.querySelectorAll(`[data-edit="${CSS.escape(target.id)}"]`)]
    .filter((node) => !node.classList.contains("tdom-direct-editor"));
  const key = (input) => String(input || "").normalize("NFKC").replace(/\s+/g, "");
  const wanted = key(target.value);
  const textNodes = [...document.querySelectorAll(`svg text[data-src="${CSS.escape(target.blockId)}"]`)]
    .filter((node) => node.dataset.math !== "1");
  let matched = [];
  for (let start = 0; start < textNodes.length && !matched.length; start++) {
    let joined = "";
    for (let end = start; end < textNodes.length && joined.length <= wanted.length; end++) {
      joined += key(textNodes[end].textContent);
      if (joined === wanted) {
        matched = textNodes.slice(start, end + 1);
        break;
      }
      if (!wanted.startsWith(joined)) break;
    }
  }
  const blockStart = Number(target.blockSource?.start?.line);
  const firstLine = Number(target.source?.start?.line) - blockStart;
  const lastLine = Number(target.source?.end?.line) - blockStart;
  let sourceHits = [...document.querySelectorAll(
    `rect.tdom-source-hit[data-src="${CSS.escape(target.blockId)}"]`
  )];
  const onSourceLines = sourceHits.filter((node) => {
    const line = Number(node.dataset.line);
    return Number.isFinite(firstLine) && Number.isFinite(lastLine) && line >= firstLine && line <= lastLine;
  });
  if (onSourceLines.length) sourceHits = onSourceLines;
  const nodes = exactNodes.length ? exactNodes : matched.length ? matched : sourceHits;
  const rects = nodes.map((node) => node.getBoundingClientRect()).filter((rect) => rect.width || rect.height);
  return rects.length ? {
    left: Math.min(...rects.map((rect) => rect.left)),
    top: Math.min(...rects.map((rect) => rect.top)),
    right: Math.max(...rects.map((rect) => rect.right)),
    bottom: Math.max(...rects.map((rect) => rect.bottom)),
  } : null;
  }, region);
  return measured ?? canonicalRegionRect(frame, region);
};

const clickRegion = async (frame, blockId, kind, value, options = {}) => {
  const svgClick = await frame.evaluate(async ({ blockId, kind, value, options }) => {
    const snapshot = await fetch("/dom", { cache: "no-store" }).then((response) => response.json());
    if (snapshot.mode === "opaque") return null;
    const escaped = CSS.escape(blockId);
    const expected = String(value || "").replace(/\s+/g, "");
    const candidates = [
      ...document.querySelectorAll('.tdom-source-hit[data-src="' + escaped + '"]'),
      ...document.querySelectorAll('[data-src="' + escaped + '"]'),
    ];
    const sourceHit = candidates.find((node) =>
      node.classList.contains("tdom-source-hit") &&
      (options.localLine == null || node.dataset.line === String(options.localLine))
    );
    const target =
      candidates.find((node) => kind === "math" && node.dataset.math === "1") ||
      (kind === "math" ? sourceHit : null) ||
      candidates.find((node) =>
        kind === "text" &&
        node.tagName.toLowerCase() === "text" &&
        Boolean(node.textContent?.trim()) &&
        expected.includes(String(node.textContent).replace(/\s+/g, ""))
      ) ||
      candidates.find((node) => node.classList.contains("tdom-source-hit")) ||
      candidates.find((node) => node.tagName.toLowerCase() === "text");
    if (!target) return null;
    const rect = target.getBoundingClientRect();
    const point = {
      x: rect.left + Math.max(1, rect.width * (options.columnRatio ?? 0.5)),
      y: rect.top + Math.max(1, rect.height / 2),
    };
    target.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      clientX: point.x,
      clientY: point.y,
    }));
    return point;
  }, { blockId, kind, value, options });
  if (svgClick) return svgClick;
  const canonicalClick = await waitFor(() => frame.evaluate(async ({ blockId, kind, value, options }) => {
    const snapshot = await fetch("/dom", { cache: "no-store" }).then((response) => response.json());
    if (snapshot.mode !== "opaque") return null;
    const block = snapshot.blocks?.find((item) => item.id === blockId);
    const region = block?.editRegions?.find((item) => item.kind === kind && item.value === value);
    if (!block || !region) return null;
    const generated = Number(region.source?.end?.line) < Number(block.source?.start?.line);
    let pageNumber = 1;
    let paperX = 306;
    let paperY = 166;
    let textBox = null;
    if (kind === "text") {
      const boxesResponse = await fetch(`/canonical/boxes?c=${snapshot.canonical?.id}`, { cache: "no-store" });
      const pages = boxesResponse.ok ? (await boxesResponse.json()).pages || [] : [];
      const key = (input) => String(input || "").normalize("NFKC").replace(/\s+/g, "");
      const wanted = key(region.value);
      for (let pageIndex = 0; pageIndex < pages.length && !textBox; pageIndex++) {
        const words = pages[pageIndex];
        for (let start = 0; start < words.length && !textBox; start++) {
          let joined = "";
          for (let end = start; end < words.length && joined.length <= wanted.length; end++) {
            joined += key(words[end].text);
            if (joined === wanted) {
              const group = words.slice(start, end + 1);
              textBox = {
                page: pageIndex + 1,
                left: Math.min(...group.map((item) => item.left)),
                top: Math.min(...group.map((item) => item.top)),
                right: Math.max(...group.map((item) => item.right)),
                bottom: Math.max(...group.map((item) => item.bottom)),
              };
              break;
            }
            if (!wanted.startsWith(joined)) break;
          }
        }
      }
    }
    if (textBox) {
      pageNumber = textBox.page;
      paperX = textBox.left + Math.max(1, (textBox.right - textBox.left) * (options.columnRatio ?? 0.5));
      paperY = (textBox.top + textBox.bottom) / 2;
    } else if (generated) {
      const generatedRegions = block.editRegions
        .filter((item) => Number(item.source?.end?.line) < Number(block.source?.start?.line))
        .sort((a, b) => a.source.start.line - b.source.start.line);
      const index = Math.max(0, generatedRegions.findIndex((item) => item.id === region.id));
      paperY = [166, 195, 219][index] ?? 166 + index * 28;
    } else {
      const sourceLines = String(region.sourceValue ?? region.value ?? "").split(/\r?\n/);
      const interior = sourceLines
        .map((text, index) => ({ text, index }))
        .find(({ text }) => {
          const trimmed = text.trim();
          return trimmed && !/^\\(?:begin|end|label)\b/.test(trimmed) &&
            !/^\\(?:notag|nonumber)\b/.test(trimmed);
        });
      const focusLine = interior
        ? Number(region.source?.start?.line) + interior.index
        : region.source?.start?.line;
      const focusColumn = interior
        ? Math.max(1, interior.text.search(/\S/) + 1)
        : region.source?.start?.column;
      const response = await fetch("/synctex/forward", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: snapshot.canonical?.id,
          locations: [{
            file: region.source?.file,
            line: focusLine,
            column: focusColumn,
          }],
        }),
      });
      const anchor = response.ok ? (await response.json()).results?.[0] : null;
      if (!anchor) return null;
      pageNumber = anchor.page;
      paperX = Number.isFinite(anchor.x) ? anchor.x + 2 : (anchor.box.left + anchor.box.right) / 2;
      paperY = Number.isFinite(anchor.y) ? anchor.y : (anchor.box.top + anchor.box.bottom) / 2;
    }
    const page = document.querySelector(`#pages > .page[data-page="${pageNumber}"]`);
    if (!page) return null;
    page.scrollIntoView({ block: "center" });
    const rect = page.getBoundingClientRect();
    const paper = snapshot.canonical?.paper || { w: 612, h: 792 };
    const relative = {
      x: (paperX / paper.w) * rect.width,
      y: (paperY / paper.h) * rect.height,
    };
    return {
      pageNumber,
      relative,
      point: { x: rect.left + relative.x, y: rect.top + relative.y },
    };
  }, { blockId, kind, value, options }), Boolean, 15_000);
  const frameElement = await frame.frameElement();
  const frameBox = await frameElement.boundingBox();
  await frameElement.dispose();
  assert.ok(frameBox, "live-preview frame is visible for a canonical click");
  await frame.page().mouse.click(
    frameBox.x + canonicalClick.point.x,
    frameBox.y + canonicalClick.point.y
  );
  await frame.waitForTimeout(80);
  if (await frame.locator(".tdom-direct-editor").count() === 0) {
    // Headless Electron occasionally drops a coordinate click while its
    // detached PDF BrowserWindow is being focused. Re-dispatch the identical
    // in-frame click so the product's real hit-resolution path still runs.
    await frame.evaluate((point) => {
      const event = new MouseEvent("click", {
        bubbles: true,
        clientX: point.x,
        clientY: point.y,
      });
      const target = document.elementFromPoint(point.x, point.y) ||
        window.pageAtClientPoint?.(event);
      target?.dispatchEvent(event);
    }, canonicalClick.point);
  }
  return canonicalClick.point;
};

const measureOpaqueSuggestionPanel = async (frame) => frame.evaluate(() => {
  const session = typeof directEditor === "undefined" ? null : directEditor;
  const panel = session?.element?.querySelector(".math-wysiwyg-panel");
  const page = session ? document.querySelector(`#pages > .page[data-page="${session.pageNumber}"]`) : null;
  const anchor = session?.canonicalAnchorPoint;
  if (!session || !panel || !page || !anchor) return null;
  const pageRect = page.getBoundingClientRect();
  const panelRect = panel.getBoundingClientRect();
  const shellRect = session.element.getBoundingClientRect();
  const paper = {
    w: Number(page.dataset.canonPaperW) || 612,
    h: Number(page.dataset.canonPaperH) || 792,
  };
  const expected = {
    x: pageRect.left + (anchor.x / paper.w) * pageRect.width,
    y: pageRect.top + (anchor.y / paper.h) * pageRect.height,
  };
  return {
    anchor: { x: anchor.x, y: anchor.y },
    expected,
    page: {
      left: pageRect.left,
      top: pageRect.top,
      width: pageRect.width,
      height: pageRect.height,
    },
    panel: {
      left: panelRect.left,
      top: panelRect.top,
      right: panelRect.right,
      bottom: panelRect.bottom,
      width: panelRect.width,
      height: panelRect.height,
      inlineLeft: panel.style.left,
      inlineTop: panel.style.top,
      ariaHidden: panel.getAttribute("aria-hidden"),
      display: getComputedStyle(panel).display,
      childCount: panel.childElementCount,
    },
    shell: {
      left: shellRect.left,
      top: shellRect.top,
      right: shellRect.right,
      bottom: shellRect.bottom,
      width: shellRect.width,
      height: shellRect.height,
    },
    canonicalCss: {
      left: session.element.style.getPropertyValue("--tdom-canonical-panel-left"),
      top: session.element.style.getPropertyValue("--tdom-canonical-panel-top"),
    },
    scrollTop: document.getElementById("pages")?.scrollTop ?? 0,
    zoom: typeof zoom === "number" ? zoom : null,
  };
});

const openOpaqueSuggestionPanel = async (frame) => {
  await waitFor(
    () => frame.evaluate(() => Boolean(
      typeof directEditor !== "undefined" && directEditor?.wysiwyg?.openCustomCandidates
    )),
    Boolean,
    10_000
  );
  await frame.evaluate(() => {
    directEditor.wysiwyg.openCustomCandidates([
      { id: "e2e-anchor-a", label: "alpha", hint: "", displayLatex: "\\alpha", apply() {} },
      { id: "e2e-anchor-b", label: "beta", hint: "", displayLatex: "\\beta", apply() {} },
    ]);
    repositionDirectEditor();
  });
  return waitFor(() => measureOpaqueSuggestionPanel(frame), Boolean, 10_000);
};

const clickCanonicalSource = async (frame, source) => {
  const target = await waitFor(() => frame.evaluate(async (location) => {
    const snapshot = await fetch("/dom", { cache: "no-store" }).then((response) => response.json());
    const response = await fetch("/synctex/forward", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: snapshot.canonical?.id,
        locations: [location],
      }),
    });
    const anchor = response.ok ? (await response.json()).results?.[0] : null;
    if (!anchor) return null;
    const page = document.querySelector(`#pages > .page[data-page="${anchor.page}"]`);
    if (!page) return null;
    page.scrollIntoView({ block: "center" });
    await page.querySelector("img.canon")?.decode?.().catch(() => {});
    const rect = page.getBoundingClientRect();
    const paper = snapshot.canonical?.paper || { w: 612, h: 792 };
    return {
      page: anchor.page,
      relative: {
        x: (anchor.x / paper.w) * rect.width,
        y: (anchor.y / paper.h) * rect.height,
      },
      point: {
        x: rect.left + (anchor.x / paper.w) * rect.width,
        y: rect.top + (anchor.y / paper.h) * rect.height,
      },
    };
  }, source), Boolean, 15_000);
  await frame.locator(`#pages > .page[data-page="${target.page}"]`).click({
    position: target.relative,
    force: true,
  });
  return target.point;
};

const clickCanonicalWordAfter = async (frame, prefix) => {
  const target = await waitFor(() => frame.evaluate(async (wantedPrefix) => {
    const snapshot = await fetch("/dom", { cache: "no-store" }).then((response) => response.json());
    const response = await fetch(`/canonical/boxes?c=${snapshot.canonical?.id}`, { cache: "no-store" });
    const pages = response.ok ? (await response.json()).pages || [] : [];
    const key = (input) => String(input || "").normalize("NFKC").replace(/\s+/g, "");
    const wanted = key(wantedPrefix);
    for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
      const words = pages[pageIndex];
      for (let start = 0; start < words.length; start++) {
        let joined = "";
        for (let end = start; end < words.length && joined.length <= wanted.length; end++) {
          joined += key(words[end].text);
          if (joined !== wanted) {
            if (!wanted.startsWith(joined)) break;
            continue;
          }
          const word = words[end + 1];
          const page = document.querySelector(`#pages > .page[data-page="${pageIndex + 1}"]`);
          if (!word || !page) return null;
          page.scrollIntoView({ block: "center" });
          const rect = page.getBoundingClientRect();
          const paper = snapshot.canonical?.paper || { w: 612, h: 792 };
          return {
            page: pageIndex + 1,
            relative: {
              x: (((word.left + word.right) / 2) / paper.w) * rect.width,
              y: (((word.top + word.bottom) / 2) / paper.h) * rect.height,
            },
            x: rect.left + (((word.left + word.right) / 2) / paper.w) * rect.width,
            y: rect.top + (((word.top + word.bottom) / 2) / paper.h) * rect.height,
            text: word.text,
          };
        }
      }
    }
    return null;
  }, prefix), Boolean, 15_000);
  await frame.locator(`#pages > .page[data-page="${target.page}"]`).click({
    position: target.relative,
    force: true,
  });
  return target;
};

test("live PDF directly edits prose, IME text, inline and multiline math across rapid redraws", { timeout: 180_000 }, async () => {
  const { _electron: electron } = require("playwright");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-live-edit-e2e-"));
  const workspace = path.join(tmpDir, "workspace");
  fs.cpSync(WORKSPACE, workspace, { recursive: true });
  const introPath = path.join(workspace, "sections", "intro.tex");
  fs.writeFileSync(
    introPath,
    fs.readFileSync(introPath, "utf8") + "\nInline direct formula: $a^2 + b^2 = c^2$.\n"
  );
  const mainPath = path.join(workspace, "main.tex");
  fs.writeFileSync(
    mainPath,
    fs.readFileSync(mainPath, "utf8")
      .replace("\\author{tex64}", "\\author{tex64 Author}\n\\date{August 2026}")
      .replace("\\begin{document}\n", "\\begin{document}\n\\maketitle\n")
  );
  fs.writeFileSync(
    path.join(workspace, ".tex64", "settings.json"),
    JSON.stringify({ rootFile: "main.tex" }, null, 2)
  );
  let app;
  try {
    app = await electron.launch({
      executablePath: ELECTRON_BIN,
      args: [PROJECT_ROOT],
      env: {
        ...process.env,
        PATH: "/Library/TeX/texbin:/opt/homebrew/bin:/usr/local/bin:" + (process.env.PATH ?? ""),
        TEX64_E2E: "1",
        TEX64_E2E_USERDATA: tmpDir,
        TEX64_E2E_FORCE_HEADLESS: "1",
        TEX64_E2E_OPEN_WORKSPACE_PATH: workspace,
        TEX64_ALLOW_MULTI_INSTANCE: "1",
        NODE_ENV: "test",
      },
      timeout: 60_000,
    });

    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await page.waitForSelector("body.is-ready", { timeout: 20_000 });
    await page.evaluate(() => {
      document.getElementById("announcement-modal-close")?.click();
      document.querySelectorAll(".modal.is-open").forEach((modal) => modal.classList.remove("is-open"));
    });
    // Announcement state is restored asynchronously after the shell is
    // ready; dismiss it once more at the point of interaction.
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      document.getElementById("announcement-modal-close")?.click();
      document.querySelectorAll(".modal.is-open").forEach((modal) => modal.classList.remove("is-open"));
    });
    await page.locator("#launcher-open").click();
    await page.waitForTimeout(1200);
    await page.evaluate(() => document.getElementById("settings-close")?.click());
    await waitFor(
      () => page.evaluate(() => [...document.querySelectorAll("#file-tree [data-path]")]
        .map((node) => node.dataset.path)
        .filter(Boolean)),
      (paths) => paths.some((file) => /main\.tex$/.test(file)),
      15_000
    );
    const treeItems = page.locator("#file-tree [data-path]");
    const treePaths = await treeItems.evaluateAll((nodes) => nodes.map((item) => item.dataset.path || ""));
    const rootMainIndex = treePaths
      .map((file, index) => ({ file, index }))
      .filter(({ file }) => /main\.tex$/.test(file))
      .sort((a, b) => a.file.length - b.file.length)[0]?.index;
    assert.notEqual(rootMainIndex, undefined, "root main.tex is present in the workspace tree");
    const openedMain = treePaths[rootMainIndex];
    await page.evaluate(() => document.getElementById("announcement-modal-close")?.click());
    await treeItems.nth(rootMainIndex).click();
    await waitFor(
      () => page.evaluate(() =>
        document.querySelector("#file-tree .file-item.is-active")?.dataset.path ?? null
      ),
      (activePath) => activePath === openedMain,
      10_000
    );
    await waitFor(
      () => page.evaluate(() => window.monaco?.editor?.getModels?.()
        .some((model) => model.getValue?.().includes("\\include{sections/intro}")) ?? false),
      Boolean,
      10_000
    );
    await page.evaluate(async () => {
      const detachedToggle = document.getElementById("editor-pdf-window");
      if (detachedToggle instanceof HTMLInputElement) {
        detachedToggle.checked = false;
        detachedToggle.dispatchEvent(new Event("change", { bubbles: true }));
      }
      const autoSync = document.getElementById("editor-auto-synctex-build");
      if (autoSync instanceof HTMLInputElement) {
        autoSync.checked = true;
        autoSync.dispatchEvent(new Event("change", { bubbles: true }));
      }
      const { editorSettings } = await import("./app/editor-settings/editor-settings-store.js");
      editorSettings.setFlag("preview.realtime", false);
    });
    await page.locator("#build-button").click();
    await waitFor(
      () => page.locator("#build-button").getAttribute("aria-busy"),
      (value) => value === "true",
      10_000
    );
    await waitFor(
      () => page.locator("#build-button").getAttribute("aria-busy"),
      (value) => value === "false",
      60_000
    );
    await page.evaluate(() => document.getElementById("announcement-modal-close")?.click());
    await page.locator("#synctex-button").click();
    const pdfViewerFrame = await waitFor(
      async () => page.frames().find((frame) => frame.url().includes("pdf-viewer.html")) ?? null,
      Boolean,
      60_000
    );
    await page.evaluate(async () => {
      const { editorSettings } = await import("./app/editor-settings/editor-settings-store.js");
      editorSettings.setFlag("preview.realtime", true);
    });

    const inTabEngine = await waitFor(
      () => page.evaluate(() => window.tex64Tdom?.status?.()),
      (status) => status?.running && status?.state === "ready" && status?.url,
      40_000
    );
    await waitFor(
      () => fetch(`${inTabEngine.url}/dom`, { cache: "no-store" }).then((response) => response.json()),
      (snapshot) => snapshot.blocks?.some((block) =>
        block.editRegions?.some((region) => /sections\/intro\.tex$/.test(region.source?.file || ""))
      ),
      30_000
    );
    assert.equal(
      (await app.windows()).some((candidate) => candidate !== page && candidate.url().includes("pdf-viewer.html")),
      false,
      "Live stays inside the current Code UI and never opens a detached viewer"
    );
    const pdfPage = page;
    const livePageErrors = [];
    pdfPage.on("pageerror", (error) => livePageErrors.push(String(error?.stack || error)));
    const liveFrame = await waitFor(
      async () => page.frames().find((frame) => /127\.0\.0\.1:\d+\/\?embed=1/.test(frame.url())) ?? null,
      Boolean,
      40_000
    );
    await pdfViewerFrame.waitForFunction(() => document.body.classList.contains("is-live"), null, { timeout: 40_000 });
    const dom = await waitFor(
      () => liveFrame.evaluate(() => fetch("/dom", { cache: "no-store" }).then((response) => response.json())),
      (snapshot) => snapshot.blocks?.some((block) =>
        block.editRegions?.some((region) => /sections\/intro\.tex$/.test(region.source?.file || ""))
      ),
      30_000
    );
    const intro = dom.blocks.flatMap((block) =>
      (block.editRegions || []).map((region) => ({ blockId: block.id, ...region }))
    ).find((region) =>
      /sections\/intro\.tex$/.test(region.source?.file || "") && region.value === "Introduction"
    );
    const introProse = dom.blocks.flatMap((block) =>
      (block.editRegions || []).map((region) => ({ blockId: block.id, ...region }))
    ).find((region) =>
      /sections\/intro\.tex$/.test(region.source?.file || "") &&
      region.value === "This section provides context and references Figure"
    );
    assert.ok(intro, "intro heading edit region is present");
    assert.ok(introProse, "multi-run intro prose edit region is present");
    const titleRegion = await waitForVisibleRegion(liveFrame, (region) => (
      /main\.tex$/.test(region.source?.file || "") && region.value === "tex64 Test Workspace"
    ), 30_000);
    assert.ok(titleRegion, "maketitle title edit region is present");
    await liveFrame.evaluate((blockId) =>
      document.querySelector(`[data-src="${CSS.escape(blockId)}"]`)?.scrollIntoView({ block: "center" }),
    titleRegion.blockId);
    await liveFrame.waitForTimeout(100);
    const titlePrintRect = await measureTextRegionRect(liveFrame, titleRegion);
    assert.ok(titlePrintRect, "maketitle has a measurable print rectangle");
    const titleScrollBeforeClick = await liveFrame.evaluate(() => document.getElementById("pages")?.scrollTop ?? 0);
    const titleBeforeClick = await screenshotFrameRect(pdfPage, liveFrame, titlePrintRect);
    await clickRegion(liveFrame, titleRegion.blockId, "text", titleRegion.value, { localLine: 1 });
    const titleEditor = liveFrame.locator(".tdom-direct-text[contenteditable]");
    await titleEditor.waitFor({ timeout: 10_000 });
    assert.equal(await titleEditor.textContent(), titleRegion.value, "maketitle opens the title rather than a neighboring field");
    const titleAfterClick = await screenshotFrameRect(pdfPage, liveFrame, titlePrintRect);
    assert.ok(
      titleBeforeClick.equals(titleAfterClick),
      "clicking maketitle must not move or repaint a single printed pixel"
    );
    assert.equal(
      await liveFrame.evaluate(() => document.getElementById("pages")?.scrollTop ?? 0),
      titleScrollBeforeClick,
      "focusing maketitle never scrolls the PDF pane"
    );
    await titleEditor.press("Escape");
    await liveFrame.locator(".tdom-direct-editor").waitFor({ state: "detached", timeout: 5_000 });
    const figureReference = dom.blocks.find((block) =>
      block.refs?.includes("fig:sample")
    );
    assert.equal(dom.labels?.["fig:sample"], "1", "the figure reference resolves to its live counter");
    assert.ok(figureReference, "the figure reference block is present");
    const clickedReference = await liveFrame.evaluate(({ blockId, printed }) => {
      const target = [...document.querySelectorAll(`text[data-src="${CSS.escape(blockId)}"]`)]
        .find((node) => node.textContent?.trim() === printed);
      if (!target) return false;
      const rect = target.getBoundingClientRect();
      target.dispatchEvent(new MouseEvent("click", {
        bubbles: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      }));
      return true;
    }, { blockId: figureReference.id, printed: "1" });
    assert.equal(clickedReference, true, "the printed Figure 1 reference is present");
    await liveFrame.waitForTimeout(150);
    assert.equal(await liveFrame.locator(".tdom-direct-editor").count(), 0, "a reference click never opens prose editing");
    await liveFrame.evaluate((blockId) =>
      document.querySelector(`[data-src="${CSS.escape(blockId)}"]`)?.scrollIntoView({ block: "center" }),
    introProse.blockId);
    await liveFrame.waitForTimeout(100);
    const prosePrintRect = await liveFrame.evaluate(({ blockId, value }) => {
      const key = (input) => String(input || "").normalize("NFKC").replace(/\s+/g, "");
      const wanted = key(value);
      const nodes = [...document.querySelectorAll(`svg text[data-src="${CSS.escape(blockId)}"]`)]
        .filter((node) => node.dataset.math !== "1");
      let matched = [];
      for (let start = 0; start < nodes.length && !matched.length; start++) {
        let joined = "";
        for (let end = start; end < nodes.length && joined.length <= wanted.length; end++) {
          joined += key(nodes[end].textContent);
          if (joined === wanted) {
            matched = nodes.slice(start, end + 1);
            break;
          }
          if (!wanted.startsWith(joined)) break;
        }
      }
      const rects = matched.map((node) => node.getBoundingClientRect());
      return rects.length ? {
        left: Math.min(...rects.map((rect) => rect.left)),
        top: Math.min(...rects.map((rect) => rect.top)),
        right: Math.max(...rects.map((rect) => rect.right)),
        bottom: Math.max(...rects.map((rect) => rect.bottom)),
      } : null;
    }, { blockId: introProse.blockId, value: introProse.value });
    assert.ok(prosePrintRect, "printed prose has a measurable ink rectangle");
    const proseScrollBeforeClick = await liveFrame.evaluate(() => document.getElementById("pages")?.scrollTop ?? 0);
    const proseBeforeClick = await screenshotFrameRect(pdfPage, liveFrame, prosePrintRect);
    await clickRegion(liveFrame, introProse.blockId, "text", introProse.value);
    const proseSurface = liveFrame.locator(".tdom-direct-text[contenteditable]");
    await proseSurface.waitFor({ timeout: 10_000 });
    const proseAfterClick = await screenshotFrameRect(pdfPage, liveFrame, prosePrintRect);
    assert.ok(
      proseBeforeClick.equals(proseAfterClick),
      "clicking prose must not move or repaint a single printed pixel"
    );
    const proseClickState = await liveFrame.evaluate(() => {
      const control = document.querySelector(".tdom-direct-text[contenteditable]");
      const selection = window.getSelection();
      return {
        scrollTop: document.getElementById("pages")?.scrollTop ?? 0,
        caretOffset: control?.contains(selection?.anchorNode) ? selection?.anchorOffset : null,
        length: control?.textContent?.length ?? 0,
      };
    });
    assert.equal(proseClickState.scrollTop, proseScrollBeforeClick, "focusing prose never scrolls the PDF pane");
    assert.ok(
      Number.isInteger(proseClickState.caretOffset) && proseClickState.caretOffset < proseClickState.length,
      `the caret stays at the clicked word instead of jumping to the end: ${JSON.stringify(proseClickState)}`
    );
    const proseGeometry = await liveFrame.evaluate(({ blockId, value }) => {
      const key = (input) => String(input || "").normalize("NFKC").replace(/\s+/g, "");
      const wanted = key(value);
      const nodes = [...document.querySelectorAll(`svg text[data-src="${CSS.escape(blockId)}"]`)]
        .filter((node) => node.dataset.math !== "1");
      let matched = [];
      for (let start = 0; start < nodes.length && !matched.length; start++) {
        let joined = "";
        for (let end = start; end < nodes.length && joined.length <= wanted.length; end++) {
          joined += key(nodes[end].textContent);
          if (joined === wanted) {
            matched = nodes.slice(start, end + 1);
            break;
          }
          if (!wanted.startsWith(joined)) break;
        }
      }
      const rects = matched.map((node) => node.getBoundingClientRect());
      const expected = rects.length ? {
        left: Math.min(...rects.map((rect) => rect.left)),
        top: Math.min(...rects.map((rect) => rect.top)),
        right: Math.max(...rects.map((rect) => rect.right)),
        bottom: Math.max(...rects.map((rect) => rect.bottom)),
      } : null;
      const overlay = document.querySelector(".tdom-direct-editor")?.getBoundingClientRect();
      const first = matched[0];
      const svg = first?.closest("svg");
      const pageScale = svg ? svg.getBoundingClientRect().width / svg.viewBox.baseVal.width : 1;
      const expectedFont = Number(first?.getAttribute("font-size")) * pageScale;
      const actualFont = parseFloat(getComputedStyle(document.querySelector(".tdom-direct-editor")).fontSize);
      return expected && overlay ? {
        left: Math.abs(expected.left - overlay.left),
        top: Math.abs(expected.top - overlay.top),
        width: Math.abs((expected.right - expected.left) - overlay.width),
        font: Math.abs(expectedFont - actualFont),
        runs: matched.length,
      } : null;
    }, { blockId: introProse.blockId, value: introProse.value });
    assert.ok(
      proseGeometry && proseGeometry.runs >= 2 &&
        proseGeometry.left < 2 && proseGeometry.top < 2 &&
        proseGeometry.width < 2 && proseGeometry.font < 0.6,
      `multi-run prose is edited on its printed glyphs: ${JSON.stringify(proseGeometry)}`
    );
    await proseSurface.press("Escape");
    await liveFrame.locator(".tdom-direct-editor").waitFor({ state: "detached", timeout: 5_000 });
    await clickRegion(liveFrame, intro.blockId, "text", intro.value);
    const textEditor = liveFrame.locator(".tdom-direct-text[contenteditable]");
    await textEditor.waitFor({ timeout: 10_000 });
    const textSurface = await liveFrame.evaluate(() => {
      const shell = document.querySelector(".tdom-direct-editor");
      const control = document.querySelector(".tdom-direct-text[contenteditable]");
      const style = getComputedStyle(shell);
      return {
        tag: control?.tagName,
        border: style.borderTopWidth,
        radius: style.borderRadius,
        shadow: style.boxShadow,
        padding: style.padding,
      };
    });
    assert.deepEqual(textSurface, {
      tag: "SPAN",
      border: "0px",
      radius: "0px",
      shadow: "none",
      padding: "0px",
    }, "prose becomes a frameless editable glyph surface");
    const textAlignment = await liveFrame.evaluate(({ blockId, value }) => {
      const expected = String(value).replace(/\s+/g, "");
      const target = [...document.querySelectorAll(`text[data-src="${CSS.escape(blockId)}"]`)]
        .find((node) => expected.includes(String(node.textContent || "").replace(/\s+/g, "")));
      const overlay = document.querySelector(".tdom-direct-editor");
      const a = target?.getBoundingClientRect();
      const b = overlay?.getBoundingClientRect();
      return a && b ? { left: Math.abs(a.left - b.left), top: Math.abs(a.top - b.top) } : null;
    }, { blockId: intro.blockId, value: intro.value });
    assert.ok(textAlignment && textAlignment.left < 8 && textAlignment.top < 8, "the prose editor overlays its clicked glyph");
    await textEditor.press("End");
    await textEditor.press("Shift+ArrowLeft");
    const selectedEnding = await liveFrame.evaluate(() => window.getSelection()?.toString() ?? "");
    assert.equal(selectedEnding.length, 1, "keyboard range selection stays inside the clicked prose");
    await textEditor.press("Backspace");
    await textEditor.pressSequentially(selectedEnding);
    await textEditor.press("Meta+ArrowRight");
    await textEditor.pressSequentially(" R");
    await waitFor(
      () => page.evaluate(() => window.monaco?.editor?.getModels?.()
        .find((model) => /sections\/intro\.tex$/.test(model.uri?.path || model.uri?.toString?.() || ""))
        ?.getValue?.() ?? ""),
      (value) => value.includes("\\section{Introduction R}"),
      15_000
    );
    await waitFor(
      () => liveFrame.evaluate(() => fetch("/dom", { cache: "no-store" }).then((response) => response.json())),
      (snapshot) => snapshot.blocks?.some((block) =>
        block.editRegions?.some((region) => region.value === "Introduction R")
      ),
      20_000
    );
    const activeAfterRedraw = await liveFrame.evaluate(() => {
      const shell = document.querySelector(".tdom-direct-editor");
      const control = shell?.querySelector(".tdom-direct-text[contenteditable]");
      const rect = shell?.getBoundingClientRect();
      return {
        connected: Boolean(shell?.isConnected && control?.isConnected),
        value: control?.textContent,
        left: rect?.left,
        top: rect?.top,
      };
    });
    assert.ok(
      activeAfterRedraw.connected && activeAfterRedraw.value === "Introduction R" &&
        Number.isFinite(activeAfterRedraw.left) && Number.isFinite(activeAfterRedraw.top),
      `the same editor survives the live page redraw: ${JSON.stringify(activeAfterRedraw)}`
    );
    await textEditor.press("Meta+A");
    await textEditor.pressSequentially("Introduction Revised");
    await textEditor.evaluate((input) => input.blur());
    const introModelValue = await waitFor(
      () => page.evaluate(() => window.monaco?.editor?.getModels?.()
        .find((model) => /sections\/intro\.tex$/.test(model.uri?.path || model.uri?.toString?.() || ""))
        ?.getValue?.() ?? ""),
      (value) => value.includes("\\section{Introduction Revised}"),
      15_000
    );
    assert.match(introModelValue, /\\section\{Introduction Revised\}/);
    const updatedDom = await waitFor(
      () => liveFrame.evaluate(() => fetch("/dom", { cache: "no-store" }).then((response) => response.json())),
      (snapshot) => snapshot.blocks?.some((block) =>
        block.editRegions?.some((region) => region.value === "Introduction Revised")
      ),
      20_000
    );

    const cancellableProse = updatedDom.blocks.flatMap((block) =>
      (block.editRegions || []).map((region) => ({ blockId: block.id, ...region }))
    ).find((region) =>
      /sections\/intro\.tex$/.test(region.source?.file || "") &&
      region.value === "This section provides context and references Figure"
    );
    assert.ok(cancellableProse, "ordinary prose remains editable after the heading redraw");
    await clickRegion(liveFrame, cancellableProse.blockId, "text", cancellableProse.value);
    const cancelEditor = liveFrame.locator(".tdom-direct-text[contenteditable]");
    await cancelEditor.waitFor({ timeout: 10_000 });
    await cancelEditor.evaluate((input) => {
      input.textContent = "Temporary text that must be cancelled";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await waitFor(
      () => page.evaluate(() => window.monaco?.editor?.getModels?.()
        .find((model) => /sections\/intro\.tex$/.test(model.uri?.path || model.uri?.toString?.() || ""))
        ?.getValue?.() ?? ""),
      (value) => value.includes("Temporary text that must be cancelled"),
      15_000
    );
    await cancelEditor.press("Escape");
    const cancelledIntro = await waitFor(
      () => page.evaluate(() => window.monaco?.editor?.getModels?.()
        .find((model) => /sections\/intro\.tex$/.test(model.uri?.path || model.uri?.toString?.() || ""))
        ?.getValue?.() ?? ""),
      (value) => value.includes("This section provides context and references Figure") &&
        !value.includes("Temporary text that must be cancelled"),
      15_000
    );
    assert.match(cancelledIntro, /This section provides context and references Figure/);

    const postCancelState = await waitFor(
      async () => {
        const snapshot = await liveFrame.evaluate(() =>
          fetch("/dom", { cache: "no-store" }).then((response) => response.json())
        );
        const blockId = snapshot.blocks?.find((block) =>
          block.editRegions?.some((region) =>
            /sections\/results\.tex$/.test(region.source?.file || "") && region.value === "評価指標の分析"
          )
        )?.id;
        const visible = blockId ? await liveFrame.evaluate((id) =>
          Boolean(document.querySelector(`[data-src="${CSS.escape(id)}"]`)), blockId) : false;
        return { snapshot, visible };
      },
      (state) => state.visible,
      20_000
    );
    const postCancelDom = postCancelState.snapshot;
    const japaneseHeading = postCancelDom.blocks.flatMap((block) =>
      (block.editRegions || []).map((region) => ({ blockId: block.id, blockPages: block.pages, gfx: block.gfx, ...region }))
    ).find((region) =>
      /sections\/results\.tex$/.test(region.source?.file || "") &&
      region.value === "評価指標の分析"
    );
    assert.ok(japaneseHeading, "Japanese prose edit region is present");
    const resultsBeforeComposition = await page.evaluate(() => window.monaco?.editor?.getModels?.()
      .find((model) => /sections\/results\.tex$/.test(model.uri?.path || model.uri?.toString?.() || ""))
      ?.getValue?.() ?? null);
    await clickRegion(liveFrame, japaneseHeading.blockId, "text", japaneseHeading.value);
    const imeEditor = liveFrame.locator(".tdom-direct-text[contenteditable]");
    await imeEditor.waitFor({ timeout: 10_000 });
    await imeEditor.evaluate((input) => {
      input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "ひょうか" }));
      input.textContent = "ひょうかしひょう";
      input.dispatchEvent(new InputEvent("input", { bubbles: true, data: "ひょうかしひょう", isComposing: true }));
    });
    await liveFrame.waitForTimeout(350);
    const imeCompositionState = await imeEditor.evaluate((input) => ({
      opaque: input.closest(".tdom-direct-editor")?.classList.contains("is-opaque") ?? false,
      transform: input.style.transform,
    }));
    if (imeCompositionState.opaque) {
      assert.match(
        imeCompositionState.transform,
        /^translate3d\(/,
        "opaque IME composition anchors the native caret to the exact PDF point"
      );
    }
    const resultsDuringComposition = await page.evaluate(() => window.monaco?.editor?.getModels?.()
      .find((model) => /sections\/results\.tex$/.test(model.uri?.path || model.uri?.toString?.() || ""))
      ?.getValue?.() ?? null);
    assert.equal(resultsDuringComposition, resultsBeforeComposition, "IME intermediate text never mutates the TeX model");
    await imeEditor.evaluate((input) => {
      input.textContent = "評価指標の解析";
      input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "評価指標の解析" }));
    });
    assert.equal(
      await imeEditor.evaluate((input) => input.style.transform),
      "",
      "opaque IME caret translation is removed immediately after composition"
    );
    const resultsAfterComposition = await waitFor(
      () => page.evaluate(() => window.monaco?.editor?.getModels?.()
        .find((model) => /sections\/results\.tex$/.test(model.uri?.path || model.uri?.toString?.() || ""))
        ?.getValue?.() ?? ""),
      (value) => value.includes("\\subsection{評価指標の解析}"),
      15_000
    );
    assert.match(resultsAfterComposition, /\\subsection\{評価指標の解析\}/);

    const afterImeDom = await waitFor(
      () => liveFrame.evaluate(() => fetch("/dom", { cache: "no-store" }).then((response) => response.json())),
      (snapshot) => snapshot.blocks?.some((block) =>
        block.editRegions?.some((region) => region.value === "評価指標の解析")
      ),
      20_000
    );

    const inlineMath = afterImeDom.blocks.flatMap((block) =>
      (block.editRegions || []).map((region) => ({ blockId: block.id, blockSource: block.source, ...region }))
    ).find((region) =>
      /sections\/intro\.tex$/.test(region.source?.file || "") &&
      region.kind === "math" && /a\^2\s*\+\s*b\^2/.test(region.value)
    );
    assert.ok(inlineMath, "inline formula edit region is present");
    await liveFrame.evaluate((blockId) =>
      document.querySelector(`[data-src="${CSS.escape(blockId)}"]`)?.scrollIntoView({ block: "center" }),
    inlineMath.blockId);
    await liveFrame.waitForTimeout(100);
    const inlinePrintRect = await measureMathRegionRect(liveFrame, inlineMath);
    assert.ok(inlinePrintRect, "inline formula has a measurable print rectangle");
    const inlineScrollBeforeClick = await liveFrame.evaluate(() => document.getElementById("pages")?.scrollTop ?? 0);
    const inlineBeforeClick = await screenshotFrameRect(pdfPage, liveFrame, inlinePrintRect);
    // Deliberately click a different PDF location without blurring the
    // Japanese editor first. The previous session must finish and the next
    // one must open at the new printed formula immediately.
    await clickRegion(liveFrame, inlineMath.blockId, "math", inlineMath.value);
    const inlineMathEditor = liveFrame.locator(".tdom-direct-editor math-field");
    await inlineMathEditor.waitFor({ timeout: 10_000 });
    const inlineAfterClick = await screenshotFrameRect(pdfPage, liveFrame, inlinePrintRect);
    assert.ok(
      inlineBeforeClick.equals(inlineAfterClick),
      "clicking inline math must not move or repaint a single printed pixel"
    );
    assert.equal(
      await liveFrame.evaluate(() => document.getElementById("pages")?.scrollTop ?? 0),
      inlineScrollBeforeClick,
      "focusing inline math never scrolls the PDF pane"
    );
    assert.equal(await liveFrame.locator(".tdom-direct-editor").count(), 1, "switching locations leaves exactly one direct editor");
    const inlineGeometry = await liveFrame.evaluate(({ regionId, blockId }) => {
      const exactNodes = [...document.querySelectorAll(`[data-edit="${CSS.escape(regionId)}"]`)]
        .filter((node) => !node.classList.contains("tdom-direct-editor"));
      const nodes = exactNodes.length ? exactNodes :
        [...document.querySelectorAll(`text[data-src="${CSS.escape(blockId)}"][data-math="1"]`)];
      const rects = nodes.map((node) => node.getBoundingClientRect()).filter((rect) => rect.width || rect.height);
      const expected = rects.length ? {
        left: Math.min(...rects.map((rect) => rect.left)),
        top: Math.min(...rects.map((rect) => rect.top)),
        right: Math.max(...rects.map((rect) => rect.right)),
        bottom: Math.max(...rects.map((rect) => rect.bottom)),
      } : null;
      const actual = document.querySelector(".tdom-direct-editor")?.getBoundingClientRect();
      return expected && actual ? {
        left: Math.abs(expected.left - actual.left),
        top: Math.abs(expected.top - actual.top),
        width: Math.abs(expected.right - expected.left - actual.width),
        height: Math.abs(expected.bottom - expected.top - actual.height),
      } : null;
    }, { regionId: inlineMath.id, blockId: inlineMath.blockId });
    assert.ok(
      inlineGeometry && inlineGeometry.left < 2 && inlineGeometry.top < 2 &&
        inlineGeometry.width < 2 && inlineGeometry.height < 3,
      `inline math is edited exactly where it is printed: ${JSON.stringify(inlineGeometry)}`
    );
    await inlineMathEditor.press("Meta+A");
    await inlineMathEditor.pressSequentially("u^2 + v^2 = w^2");
    await inlineMathEditor.evaluate((field) => field.blur());
    const blocksValue = await waitFor(
      () => page.evaluate(() => window.monaco?.editor?.getModels?.()
        .find((model) => /sections\/intro\.tex$/.test(model.uri?.path || model.uri?.toString?.() || ""))
        ?.getValue?.() ?? ""),
      (value) => /u\^2\s*\+\s*v\^2\s*=\s*w\^2/.test(value),
      15_000
    );
    assert.match(blocksValue, /u\^2\s*\+\s*v\^2\s*=\s*w\^2/);

    const methodMath = await waitForVisibleRegion(liveFrame, (region) => (
      /sections\/methods\.tex$/.test(region.source?.file || "") &&
      region.kind === "math" &&
      /F\s*=\s*ma/.test(region.value)
    ), 30_000);
    assert.ok(methodMath, "methods equation edit region is present");
    await liveFrame.evaluate((blockId) =>
      document.querySelector(`[data-src="${CSS.escape(blockId)}"]`)?.scrollIntoView({ block: "center" }),
    methodMath.blockId);
    await liveFrame.waitForTimeout(100);
    const displayPrintRect = await measureMathRegionRect(liveFrame, methodMath);
    assert.ok(displayPrintRect, "display formula has a measurable print rectangle");
    const displayScrollBeforeClick = await liveFrame.evaluate(() => document.getElementById("pages")?.scrollTop ?? 0);
    const displayBeforeClick = await screenshotFrameRect(pdfPage, liveFrame, displayPrintRect);
    await clickRegion(liveFrame, methodMath.blockId, "math", methodMath.value, {
      localLine: methodMath.source.start.line - methodMath.blockSource.start.line,
    });
    const mathEditor = liveFrame.locator(".tdom-direct-editor math-field");
    await mathEditor.waitFor({ timeout: 10_000 });
    const displayAfterClick = await screenshotFrameRect(pdfPage, liveFrame, displayPrintRect);
    assert.ok(
      displayBeforeClick.equals(displayAfterClick),
      "clicking display math must not move or repaint a single printed pixel"
    );
    assert.equal(
      await liveFrame.evaluate(() => document.getElementById("pages")?.scrollTop ?? 0),
      displayScrollBeforeClick,
      "focusing display math never scrolls the PDF pane"
    );
    const mathSurface = await liveFrame.evaluate(() => {
      const style = getComputedStyle(document.querySelector(".tdom-direct-editor"));
      return {
        border: style.borderTopWidth,
        radius: style.borderRadius,
        shadow: style.boxShadow,
        padding: style.padding,
      };
    });
    assert.deepEqual(mathSurface, {
      border: "0px",
      radius: "0px",
      shadow: "none",
      padding: "0px",
    }, "MathLive replaces the printed formula without an editor box");
    const mathAlignment = await liveFrame.evaluate(({ blockId, regionId }) => {
      const target = document.querySelector(`[data-edit="${CSS.escape(regionId)}"]`) ||
        document.querySelector(`text[data-src="${CSS.escape(blockId)}"][data-math="1"]`) ||
        document.querySelector(`rect.tdom-source-hit[data-src="${CSS.escape(blockId)}"]`);
      const overlay = document.querySelector(".tdom-direct-editor");
      const a = target?.getBoundingClientRect();
      const b = overlay?.getBoundingClientRect();
      return a && b ? { left: Math.abs(a.left - b.left), top: Math.abs(a.top - b.top) } : null;
    }, { blockId: methodMath.blockId, regionId: methodMath.id });
    assert.ok(
      mathAlignment && mathAlignment.left < 12 && mathAlignment.top < 12,
      `the formula editor overlays its clicked glyph: ${JSON.stringify(mathAlignment)}`
    );
    await mathEditor.press("Meta+A");
    const selectedMath = await mathEditor.evaluate((field) => field.selection);
    const mathRange = Array.isArray(selectedMath?.ranges?.[0]) ? selectedMath.ranges[0] : selectedMath;
    assert.ok(Array.isArray(mathRange) && mathRange[0] !== mathRange[1], "MathLive keyboard selection is non-collapsed");
    await mathEditor.press("/");
    assert.match(
      await mathEditor.evaluate((field) => field.getValue?.("latex") || field.value),
      /\\frac\{/,
      "typing / wraps the selected printed formula as a fraction"
    );
    await mathEditor.press("Meta+A");
    await mathEditor.pressSequentially("G = mb");
    await mathEditor.evaluate((field) => field.blur());
    const methodsValue = await waitFor(
      () => page.evaluate(() => window.monaco?.editor?.getModels?.()
        .find((model) => /sections\/methods\.tex$/.test(model.uri?.path || model.uri?.toString?.() || ""))
        ?.getValue?.() ?? ""),
      (value) => /G\s*=\s*mb/.test(value),
      15_000
    );
    assert.match(methodsValue, /G\s*=\s*mb/);
    assert.match(methodsValue, /\\label\{eq:newton\}/, "the equation label survives WYSIWYG replacement");

    const undoRedo = await page.evaluate(async () => {
      const model = window.monaco.editor.getModels()
        .find((item) => /sections\/methods\.tex$/.test(item.uri?.path || item.uri?.toString?.() || ""));
      model.undo();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const undone = model.getValue();
      model.redo();
      await new Promise((resolve) => setTimeout(resolve, 0));
      return { undone, redone: model.getValue() };
    });
    assert.match(undoRedo.undone, /F\s*=\s*ma/);
    assert.match(undoRedo.redone, /G\s*=\s*mb/);

    const alignMath = await waitForVisibleRegion(liveFrame, (region) => (
      /sections\/methods\.tex$/.test(region.source?.file || "") &&
      region.kind === "math" && /a\s*&=\s*b\s*\+\s*c/.test(region.value)
    ), 30_000);
    assert.ok(alignMath, "multi-line align edit region is present");
    await liveFrame.evaluate((blockId) =>
      document.querySelector(`[data-src="${CSS.escape(blockId)}"]`)?.scrollIntoView({ block: "center" }),
    alignMath.blockId);
    await liveFrame.waitForTimeout(100);
    const alignPrintRect = await measureMathRegionRect(liveFrame, alignMath);
    assert.ok(alignPrintRect, "multi-line formula has a measurable print rectangle");
    const alignScrollBeforeClick = await liveFrame.evaluate(() => document.getElementById("pages")?.scrollTop ?? 0);
    const alignBeforeClick = await screenshotFrameRect(pdfPage, liveFrame, alignPrintRect);
    await clickRegion(liveFrame, alignMath.blockId, "math", alignMath.value, {
      localLine: alignMath.source.start.line - alignMath.blockSource.start.line,
    });
    const alignEditor = liveFrame.locator(".tdom-direct-editor math-field");
    await alignEditor.waitFor({ timeout: 10_000 });
    const alignAfterClick = await screenshotFrameRect(pdfPage, liveFrame, alignPrintRect);
    assert.ok(
      alignBeforeClick.equals(alignAfterClick),
      "clicking multi-line math must not move or repaint a single printed pixel"
    );
    assert.equal(
      await liveFrame.evaluate(() => document.getElementById("pages")?.scrollTop ?? 0),
      alignScrollBeforeClick,
      "focusing multi-line math never scrolls the PDF pane"
    );
    const alignGeometry = await liveFrame.evaluate(({ regionId, blockId, firstLine, lastLine }) => {
      const exactNodes = [...document.querySelectorAll(`[data-edit="${CSS.escape(regionId)}"]`)]
        .filter((node) => !node.classList.contains("tdom-direct-editor"));
      const nodes = exactNodes.length ? exactNodes :
        [...document.querySelectorAll(`[data-src="${CSS.escape(blockId)}"][data-line]`)].filter((node) => {
          const line = Number(node.dataset.line);
          return line >= firstLine && line <= lastLine &&
            (node.dataset.math === "1" || node.classList.contains("tdom-source-hit"));
        });
      const rects = nodes.map((node) => node.getBoundingClientRect()).filter((rect) => rect.width || rect.height);
      const expected = rects.length ? {
        left: Math.min(...rects.map((rect) => rect.left)),
        top: Math.min(...rects.map((rect) => rect.top)),
        right: Math.max(...rects.map((rect) => rect.right)),
        bottom: Math.max(...rects.map((rect) => rect.bottom)),
      } : null;
      const shell = document.querySelector(".tdom-direct-editor");
      const actual = shell?.getBoundingClientRect();
      const style = shell ? getComputedStyle(shell) : null;
      return expected && actual ? {
        left: Math.abs(expected.left - actual.left),
        top: Math.abs(expected.top - actual.top),
        width: Math.abs(expected.right - expected.left - actual.width),
        expectedHeight: expected.bottom - expected.top,
        actualHeight: actual.height,
        border: style?.borderTopWidth,
        shadow: style?.boxShadow,
      } : null;
    }, {
      regionId: alignMath.id,
      blockId: alignMath.blockId,
      firstLine: alignMath.source.start.line - alignMath.blockSource.start.line,
      lastLine: alignMath.source.end.line - alignMath.blockSource.start.line,
    });
    assert.ok(
      alignGeometry && alignGeometry.left < 2 && alignGeometry.top < 2 && alignGeometry.width < 3 &&
        alignGeometry.actualHeight >= alignGeometry.expectedHeight - 3 &&
        alignGeometry.border === "0px" && alignGeometry.shadow === "none",
      `multi-line math occupies the printed align area without a box: ${JSON.stringify(alignGeometry)}`
    );
    await alignEditor.evaluate((field) => {
      field.value = "\\begin{aligned}p &= q + r \\\\ s &= t - u\\end{aligned}";
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.blur();
    });
    const alignedMethodsValue = await waitFor(
      () => page.evaluate(() => window.monaco?.editor?.getModels?.()
        .find((model) => /sections\/methods\.tex$/.test(model.uri?.path || model.uri?.toString?.() || ""))
        ?.getValue?.() ?? ""),
      (value) => /p\s*&=\s*q\s*\+\s*r/.test(value) && /s\s*&=\s*t\s*-\s*u/.test(value),
      15_000
    );
    assert.match(alignedMethodsValue, /\\label\{eq:align\}/, "the align label survives direct multi-line replacement");
    assert.deepEqual(livePageErrors, [], "direct editing raises no live-preview page errors");
  } finally {
    await closeElectronApp(app);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("two-column canonical pages directly edit paper titles, prose, figures, tables, footnotes, cases, and matrices", { timeout: 180_000 }, async () => {
  const { _electron: electron } = require("playwright");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-twocolumn-edit-e2e-"));
  const workspace = path.join(tmpDir, "workspace");
  fs.cpSync(WORKSPACE, workspace, { recursive: true });
  const mainPath = path.join(workspace, "main.tex");
  fs.writeFileSync(mainPath, String.raw`\documentclass[twocolumn]{article}
\usepackage{graphicx}
\usepackage{booktabs}
\usepackage{amsmath}
\title{Two Column Paper}
\author{Alice Author}
\date{August 2026}
\begin{document}
\maketitle
\section{Left Column}
Left column editable prose with a footnote\footnote{Editable footnote text.} and inline math $a^2+b^2=c^2$.
\begin{figure}[h]
\centering
\includegraphics[width=.48\columnwidth]{figures/sample-image.png}
\caption{Editable figure caption}\label{fig:two-column}
\end{figure}
Reference check: Figure~\ref{fig:two-column}.
\begin{equation}
h(x)=\begin{cases}x^2,&x>0\\0,&x\leq0\end{cases}
\label{eq:cases-two-column}
\end{equation}
\newpage
\section{Right Column}
Right column editable prose.
\begin{equation}
M=\begin{bmatrix}1&2\\3&4\end{bmatrix}
\label{eq:matrix-two-column}
\end{equation}
\begin{table}[h]
\centering
\begin{tabular}{lc}
Method & Value \\
Alpha & 0.95 \\
\end{tabular}
\caption{Editable table caption}\label{tab:two-column}
\end{table}
\end{document}
`);
  fs.writeFileSync(
    path.join(workspace, ".tex64", "settings.json"),
    JSON.stringify({ rootFile: "main.tex" }, null, 2)
  );
  let app;
  try {
    app = await electron.launch({
      executablePath: ELECTRON_BIN,
      args: [PROJECT_ROOT],
      env: {
        ...process.env,
        PATH: "/Library/TeX/texbin:/opt/homebrew/bin:/usr/local/bin:" + (process.env.PATH ?? ""),
        TEX64_E2E: "1",
        TEX64_E2E_USERDATA: tmpDir,
        TEX64_E2E_FORCE_HEADLESS: "1",
        TEX64_E2E_OPEN_WORKSPACE_PATH: workspace,
        TEX64_ALLOW_MULTI_INSTANCE: "1",
        NODE_ENV: "test",
      },
      timeout: 60_000,
    });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await page.waitForSelector("body.is-ready", { timeout: 20_000 });
    await page.evaluate(() => {
      document.getElementById("announcement-modal-close")?.click();
      document.querySelectorAll(".modal.is-open").forEach((modal) => modal.classList.remove("is-open"));
    });
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      document.getElementById("announcement-modal-close")?.click();
      document.querySelectorAll(".modal.is-open").forEach((modal) => modal.classList.remove("is-open"));
    });
    await page.locator("#launcher-open").click();
    await page.waitForTimeout(1200);
    await page.evaluate(() => document.getElementById("settings-close")?.click());
    const mainItem = page.locator('#file-tree [data-path$="main.tex"]').first();
    await mainItem.waitFor({ timeout: 15_000 });
    await page.evaluate(() => document.getElementById("announcement-modal-close")?.click());
    await mainItem.click();
    await page.evaluate(async () => {
      const detachedToggle = document.getElementById("editor-pdf-window");
      if (detachedToggle instanceof HTMLInputElement) {
        detachedToggle.checked = false;
        detachedToggle.dispatchEvent(new Event("change", { bubbles: true }));
      }
      const autoSync = document.getElementById("editor-auto-synctex-build");
      if (autoSync instanceof HTMLInputElement) {
        autoSync.checked = true;
        autoSync.dispatchEvent(new Event("change", { bubbles: true }));
      }
      const { editorSettings } = await import("./app/editor-settings/editor-settings-store.js");
      editorSettings.setFlag("preview.realtime", false);
    });
    await page.locator("#build-button").click();
    await waitFor(
      () => page.locator("#build-button").getAttribute("aria-busy"),
      (value) => value === "true",
      10_000
    );
    await waitFor(
      () => page.locator("#build-button").getAttribute("aria-busy"),
      (value) => value === "false",
      60_000
    );
    await page.evaluate(() => document.getElementById("announcement-modal-close")?.click());
    await page.locator("#synctex-button").click();
    const pdfViewerFrame = await waitFor(
      async () => page.frames().find((frame) => frame.url().includes("pdf-viewer.html")) ?? null,
      Boolean,
      60_000
    );
    await page.evaluate(async () => {
      const { editorSettings } = await import("./app/editor-settings/editor-settings-store.js");
      editorSettings.setFlag("preview.realtime", true);
    });
    const pdfPage = page;
    const liveFrame = await waitFor(
      async () => page.frames().find((frame) => /127\.0\.0\.1:\d+\/\?embed=1/.test(frame.url())) ?? null,
      Boolean,
      40_000
    );
    await pdfViewerFrame.waitForFunction(() => document.body.classList.contains("is-live"), null, { timeout: 40_000 });
    const snapshot = await waitFor(
      () => liveFrame.evaluate(() => fetch("/dom", { cache: "no-store" }).then((response) => response.json())),
      (dom) => dom.mode === "opaque" && dom.canonical?.id && !dom.canonical?.inFlight &&
        dom.blocks?.some((block) => block.editRegions?.some((region) => region.value === "Right column editable prose.")),
      40_000
    );
    await waitFor(() => liveFrame.evaluate((canonicalId) => {
      const page = document.querySelector('#pages > .page[data-page="1"]');
      const image = page?.querySelector('img.canon');
      return {
        ready: Boolean(image?.dataset.src?.includes(`c=${canonicalId}`) && image.complete && image.naturalWidth > 0),
        page: page ? { ...page.dataset } : null,
        image: image ? { ...image.dataset, complete: image.complete, naturalWidth: image.naturalWidth } : null,
        batches: typeof opaqueCanonicalBatches === "undefined" ? [] : [...opaqueCanonicalBatches.values()].map((batch) => ({
          key: batch.key,
          sealed: batch.sealed,
          snapshot: batch.snapshot === undefined ? "pending" : Boolean(batch.snapshot),
          editorStage: batch.editorStage === undefined ? "pending" : batch.editorStage,
          expected: [...batch.expected].map(([pageNumber, entry]) => ({ pageNumber, src: entry.src, ready: typeof entry.apply === "function" })),
        })),
      };
    }, snapshot.canonical.id), (value) => value.ready, 30_000);
    assert.ok(snapshot.modeReasons.some((reason) => reason.includes("twocolumn")), "two-column uses exact canonical page assembly");
    const regions = snapshot.blocks.flatMap((block) =>
      (block.editRegions || []).map((region) => ({ blockId: block.id, blockSource: block.source, ...region }))
    );
    const findRegion = (value, kind = "text") => regions.find((region) => region.kind === kind &&
      (typeof value === "string" ? region.value === value : value.test(region.value)));
    const title = findRegion("Two Column Paper");
    const left = findRegion(/^Left column editable prose with a footnote$/);
    const footnote = findRegion("Editable footnote text.");
    const figureCaption = findRegion("Editable figure caption");
    const cases = findRegion(/\\begin\{cases\}/, "math");
    const right = findRegion("Right column editable prose.");
    const matrix = findRegion(/\\begin\{bmatrix\}/, "math");
    const tableCell = findRegion("Alpha");
    const tableCaption = findRegion("Editable table caption");
    for (const [name, region] of Object.entries({
      title, left, footnote, figureCaption, cases, right, matrix, tableCell, tableCaption,
    })) assert.ok(region, `${name} has a direct-edit region`);
    assert.equal(regions.some((region) => region.value === "lc"), false, "the tabular column specification is never editable prose");

    const exactText = await liveFrame.evaluate(() =>
      fetch("/canonical/text", { cache: "no-store" }).then((response) => response.json())
    );
    const printed = exactText.pages.join("\n");
    assert.match(printed, /Two Column Paper/);
    assert.match(printed, /Figure\s+1/);
    assert.match(printed, /Editable footnote text/);

    const leftRect = await canonicalRegionRect(liveFrame, left);
    const rightRect = await canonicalRegionRect(liveFrame, right);
    assert.ok(leftRect && rightRect, "both columns have SyncTeX print geometry");
    const columnState = await liveFrame.evaluate(({ leftRect, rightRect }) => {
      const page = document.querySelector('#pages > .page[data-page="1"]')?.getBoundingClientRect();
      return page ? {
        center: (page.left + page.right) / 2,
        left: (leftRect.left + leftRect.right) / 2,
        right: (rightRect.left + rightRect.right) / 2,
      } : null;
    }, { leftRect, rightRect });
    assert.ok(
      columnState && columnState.left < columnState.center && columnState.right > columnState.center,
      `SyncTeX distinguishes the left and right columns: ${JSON.stringify(columnState)}`
    );

    const titleRect = await canonicalRegionRect(liveFrame, title);
    const twoColumnTitleScroll = await liveFrame.evaluate(() => document.getElementById("pages")?.scrollTop ?? 0);
    const titleBefore = await screenshotFrameRect(pdfPage, liveFrame, titleRect);
    await clickRegion(liveFrame, title.blockId, title.kind, title.value);
    const titleEditor = liveFrame.locator(".tdom-direct-text[contenteditable]");
    await titleEditor.waitFor({ timeout: 10_000 });
    assert.equal(await titleEditor.textContent(), title.value);
    const titleAfter = await screenshotFrameRect(pdfPage, liveFrame, titleRect);
    const twoColumnTitleScrollAfter = await liveFrame.evaluate(() => document.getElementById("pages")?.scrollTop ?? 0);
    assert.equal(twoColumnTitleScrollAfter, twoColumnTitleScroll, "opening a two-column title never scrolls the exact page");
    assert.ok(titleBefore.equals(titleAfter), "opening a two-column title never repaints the exact page");
    let holdCanonicalRequests = true;
    let heldCanonicalUrl = null;
    let releaseCanonicalRequests;
    const canonicalRelease = new Promise((resolve) => {
      releaseCanonicalRequests = resolve;
    });
    await pdfPage.route(/\/canonical\/1\.svg\?c=/, async (route) => {
      if (!holdCanonicalRequests) {
        await route.continue();
        return;
      }
      heldCanonicalUrl ??= route.request().url();
      await canonicalRelease;
      await route.continue();
    });
    await titleEditor.press("Meta+A");
    await titleEditor.pressSequentially("Revised Two Column Paper");
    const opaqueTypingStyle = await liveFrame.evaluate(() => {
      const shell = document.querySelector(".tdom-direct-editor");
      const control = shell?.querySelector("[contenteditable]");
      return {
        opaque: shell?.classList.contains("is-opaque") ?? false,
        color: control ? getComputedStyle(control).color : null,
        caret: control ? getComputedStyle(control).caretColor : null,
        opacity: control ? getComputedStyle(control).opacity : null,
        background: shell ? getComputedStyle(shell).backgroundColor : null,
      };
    });
    assert.equal(opaqueTypingStyle.opaque, true);
    assert.equal(opaqueTypingStyle.color, "rgba(0, 0, 0, 0)");
    assert.equal(opaqueTypingStyle.caret, "rgba(0, 0, 0, 0)");
    assert.equal(opaqueTypingStyle.opacity, "0");
    assert.equal(opaqueTypingStyle.background, "rgba(0, 0, 0, 0)");
    await waitFor(async () => ({
      heldCanonicalUrl,
      model: await page.evaluate(() => window.monaco?.editor?.getModels?.()
        .find((model) => /main\.tex$/.test(model.uri?.path || model.uri?.toString?.() || ""))?.getValue?.() ?? ""),
      engine: await liveFrame.evaluate(() => fetch("/status", { cache: "no-store" }).then((response) => response.json())),
      editor: await liveFrame.evaluate(() => ({
        text: document.querySelector(".tdom-direct-text[contenteditable]")?.textContent ?? null,
        session: typeof directEditor === "undefined" || !directEditor ? null : {
          sentEdit: directEditor.sentEdit,
          lastVisibleValue: directEditor.lastVisibleValue,
          region: directEditor.region,
        },
      })),
      dom: await liveFrame.evaluate(() => fetch("/dom", { cache: "no-store" }).then((response) => response.json()).then((value) => ({
        rev: value.report?.rev,
        srcRev: value.report?.srcRev,
        canonical: value.canonical,
      }))),
    }), (value) => Boolean(value.heldCanonicalUrl), 30_000);
    const blockedSwap = await liveFrame.evaluate(() => {
      const page = document.querySelector('#pages > .page[data-page="1"]');
      const image = page?.querySelector('img.canon');
      return {
        current: image?.dataset.src ?? null,
        wanted: page?.dataset.canonWanted ?? null,
        pending: page?.dataset.canonPending ?? null,
      };
    });
    assert.notEqual(blockedSwap.current, blockedSwap.wanted, "the next exact page is pending while its response is held");
    assert.equal(blockedSwap.pending, blockedSwap.wanted);
    const titleWhilePending = await screenshotFrameRect(pdfPage, liveFrame, titleRect);
    assert.ok(
      titleAfter.equals(titleWhilePending),
      "two-column typing keeps the previous exact pixels until the next exact page swaps in"
    );

    // The next location must resolve against the generation that is actually
    // still painted, then rebase its old source range onto the current Monaco
    // buffer. Do this while every new canonical SVG remains blocked.
    const switchStarted = Date.now();
    const rightPresentedRect = await presentedCanonicalTextRect(liveFrame, right);
    assert.ok(rightPresentedRect, "the old presented generation still exposes the right-column text box");
    const hostPendingState = await pdfViewerFrame.evaluate(() => ({
      live: document.body.classList.contains("is-live"),
      pending: document.body.classList.contains("is-live-pending"),
      frameHidden: document.getElementById("pdf-live-frame")?.getAttribute("aria-hidden") ?? null,
    }));
    assert.deepEqual(
      hostPendingState,
      { live: true, pending: false, frameHidden: "false" },
      "an opaque canonical compile keeps the old exact frame interactive"
    );
    const resolverProbe = await liveFrame.evaluate(async (rect) => {
      const clientX = (rect.left + rect.right) / 2;
      const clientY = (rect.top + rect.bottom) / 2;
      const target = document.elementFromPoint(clientX, clientY);
      const page = pageAtClientPoint({ clientX, clientY }, target);
      const resolved = await resolveOpaqueEditRegion(page, { clientX, clientY, target });
      return {
        target: target?.tagName ?? null,
        page: page?.dataset?.page ?? null,
        presented: page ? presentedPageState(page) : null,
        resolved: resolved ? { id: resolved.region?.id, value: resolved.region?.value } : null,
      };
    }, rightPresentedRect);
    assert.equal(
      resolverProbe.resolved?.value,
      right.value,
      `the painted right-column coordinates resolve against their retained generation: ${JSON.stringify(resolverProbe)}`
    );
    const liveFrameElement = await liveFrame.frameElement();
    const liveFrameBox = await liveFrameElement.boundingBox();
    await liveFrameElement.dispose();
    assert.ok(liveFrameBox);
    await pdfPage.mouse.click(
      liveFrameBox.x + (rightPresentedRect.left + rightPresentedRect.right) / 2,
      liveFrameBox.y + (rightPresentedRect.top + rightPresentedRect.bottom) / 2
    );
    const rightEditor = liveFrame.locator(".tdom-direct-text[contenteditable]");
    await waitFor(
      () => liveFrame.evaluate(() => document.querySelector(".tdom-direct-text[contenteditable]")?.textContent ?? null),
      (value) => value === right.value,
      10_000
    );
    assert.ok(Date.now() - switchStarted < 3_000, "a second column opens immediately while the next exact page is still pending");
    assert.equal(await liveFrame.locator(".tdom-direct-editor").count(), 1);
    await rightEditor.press("Meta+A");
    await rightEditor.evaluate((control) => {
      control.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "Right column revised" }));
      control.textContent = "Right column revised immediately.";
      control.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        data: "Right column revised immediately.",
        isComposing: true,
      }));
    });
    await liveFrame.waitForTimeout(100);
    assert.match(
      await rightEditor.evaluate((control) => control.style.transform),
      /^translate3d\(/,
      "opaque two-column IME keeps the native caret at its exact PDF anchor"
    );
    const rightDuringComposition = await page.evaluate(() => window.monaco?.editor?.getModels?.()
      .find((model) => /main\.tex$/.test(model.uri?.path || model.uri?.toString?.() || ""))?.getValue?.() ?? "");
    assert.doesNotMatch(
      rightDuringComposition,
      /Right column revised immediately\./,
      "opaque IME intermediate text stays out of the TeX source"
    );
    await rightEditor.evaluate((control) => {
      control.dispatchEvent(new CompositionEvent("compositionend", {
        bubbles: true,
        data: "Right column revised immediately.",
      }));
    });
    assert.equal(
      await rightEditor.evaluate((control) => control.style.transform),
      "",
      "opaque two-column IME removes the native caret translation after commit"
    );
    await rightEditor.evaluate((control) => control.blur());
    await waitFor(
      () => page.evaluate(() => window.monaco?.editor?.getModels?.()
        .find((model) => /main\.tex$/.test(model.uri?.path || model.uri?.toString?.() || ""))?.getValue?.() ?? ""),
      (value) => value.includes("Right column revised immediately."),
      15_000
    );

    holdCanonicalRequests = false;
    releaseCanonicalRequests();
    await liveFrame.waitForFunction(() => {
      const page = document.querySelector('#pages > .page[data-page="1"]');
      const image = page?.querySelector('img.canon');
      return Boolean(image?.dataset.src && image.dataset.src === page?.dataset.canonWanted && !page?.dataset.canonPending);
    }, null, { timeout: 30_000 });
    await waitFor(
      () => page.evaluate(() => window.monaco?.editor?.getModels?.()
        .find((model) => /main\.tex$/.test(model.uri?.path || model.uri?.toString?.() || ""))?.getValue?.() ?? ""),
      (value) => value.includes("\\title{Revised Two Column Paper}"),
      15_000
    );

    const textReplacements = new Map([
      [footnote.value, "Revised footnote text."],
      [figureCaption.value, "Revised figure caption"],
      [tableCell.value, "Beta"],
      [tableCaption.value, "Revised table caption"],
    ]);
    for (const region of [footnote, figureCaption, tableCell, tableCaption]) {
      const current = await waitForVisibleRegion(liveFrame, (item) => item.kind === region.kind && item.value === region.value, 30_000);
      await clickRegion(liveFrame, current.blockId, current.kind, current.value);
      const editor = liveFrame.locator(".tdom-direct-text[contenteditable]");
      await editor.waitFor({ timeout: 10_000 });
      assert.equal(await editor.textContent(), current.value);
      const replacement = textReplacements.get(region.value);
      await editor.press("Meta+A");
      await editor.pressSequentially(replacement);
      await editor.evaluate((control) => control.blur());
      await waitFor(
        () => page.evaluate(() => window.monaco?.editor?.getModels?.()
          .find((model) => /main\.tex$/.test(model.uri?.path || model.uri?.toString?.() || ""))?.getValue?.() ?? ""),
        (value) => value.includes(replacement),
        15_000
      );
    }

    const assertCanonicalPanelAnchor = (measurement, label) => {
      assert.ok(measurement?.panel.width > 0 && measurement.panel.height > 0,
        `${label}: the real candidate panel is visibly laid out: ${JSON.stringify(measurement)}`);
      const anchorX = Math.max(
        measurement.panel.left,
        Math.min(measurement.expected.x, measurement.panel.right)
      );
      const belowAnchorY = measurement.panel.top - 5;
      const aboveAnchorY = measurement.panel.bottom + 5;
      assert.ok(
        Math.abs(anchorX - measurement.expected.x) <= 2,
        `${label}: panel contains the exact canonical x anchor: ${JSON.stringify(measurement)}`
      );
      assert.ok(
        Math.min(
          Math.abs(belowAnchorY - measurement.expected.y),
          Math.abs(aboveAnchorY - measurement.expected.y)
        ) <= 2,
        `${label}: panel is attached above or below the exact canonical y anchor: ${JSON.stringify(measurement)}`
      );
      assert.ok(measurement.canonicalCss.left && measurement.canonicalCss.top,
        `${label}: opaque CSS owns the panel anchor across WYS rerenders`);
    };

    let checkedOpaqueMathPaint = false;
    for (const region of [cases, matrix]) {
      const current = await waitForVisibleRegion(liveFrame, (item) => item.kind === "math" && item.id === region.id, 30_000);
      const exactMathRect = await canonicalRegionRect(liveFrame, current);
      const exactMathBefore = checkedOpaqueMathPaint
        ? null
        : await screenshotFrameRect(pdfPage, liveFrame, exactMathRect);
      const canonicalClickPoint = await clickRegion(liveFrame, current.blockId, "math", current.value);
      const editor = liveFrame.locator(".tdom-direct-editor math-field");
      await editor.waitFor({ timeout: 10_000 });
      if (!checkedOpaqueMathPaint) {
        const exactMathFocused = await screenshotFrameRect(pdfPage, liveFrame, exactMathRect);
        assert.ok(exactMathBefore.equals(exactMathFocused), "opening opaque math paints no browser-positioned formula pixels");
        await editor.press("Meta+A");
        const selectionPaint = await liveFrame.evaluate(() => {
          const field = document.querySelector(".tdom-direct-editor math-field");
          const root = field?.shadowRoot;
          return {
            opacity: field ? getComputedStyle(field).opacity : null,
            caret: field ? getComputedStyle(field).getPropertyValue("--caret-color").trim() : null,
            selectionVariable: field ? getComputedStyle(field).getPropertyValue("--selection-background-color").trim() : null,
            shadowSelections: root?.querySelectorAll(".ML__selection").length ?? 0,
          };
        });
        assert.equal(selectionPaint.opacity, "0");
        assert.equal(selectionPaint.caret, "transparent");
        assert.equal(selectionPaint.selectionVariable, "transparent");
        const exactMathSelected = await screenshotFrameRect(pdfPage, liveFrame, exactMathRect);
        assert.ok(exactMathBefore.equals(exactMathSelected), "selecting opaque math leaves the exact page unchanged");
        checkedOpaqueMathPaint = true;
      }

      const anchorLabel = /begin\{cases\}/.test(current.value) ? "cases" : "matrix";
      const initialPanel = await openOpaqueSuggestionPanel(liveFrame);
      assert.ok(
        Math.abs(initialPanel.expected.x - canonicalClickPoint.x) <= 2 &&
          Math.abs(initialPanel.expected.y - canonicalClickPoint.y) <= 2,
        `${anchorLabel}: the stored paper anchor is the first canonical click: ${JSON.stringify({ canonicalClickPoint, initialPanel })}`
      );
      assertCanonicalPanelAnchor(initialPanel, `${anchorLabel} initial`);

      await liveFrame.evaluate(() => {
        const shell = directEditor.element;
        const rect = shell.getBoundingClientRect();
        shell.style.width = `${rect.width + 113}px`;
        shell.style.height = `${rect.height + 71}px`;
      });
      // Re-render the real WYS panel with another selected candidate. Calling
      // the public candidate API isolates the renderer itself: dispatching an
      // Arrow key against these synthetic candidates would correctly close
      // them because, unlike a user-typed suggestion session, they have no
      // active source token to preserve on MathLive's selection-change event.
      await liveFrame.evaluate(() => {
        directEditor.wysiwyg.openCustomCandidates([
          { id: "e2e-anchor-a", label: "alpha", hint: "", displayLatex: "\\alpha", apply() {} },
          { id: "e2e-anchor-b", label: "beta", hint: "", displayLatex: "\\beta", apply() {} },
        ], { selectedIndex: 1 });
      });
      const afterKeyNavigation = await measureOpaqueSuggestionPanel(liveFrame);
      assertCanonicalPanelAnchor(afterKeyNavigation, `${anchorLabel} WYS rerender`);
      assert.ok(
        afterKeyNavigation.shell.width > initialPanel.shell.width + 100 &&
          afterKeyNavigation.shell.height > initialPanel.shell.height + 60,
        `${anchorLabel}: the test materially moves the shell right and bottom edges`
      );
      assert.ok(
        Math.abs(afterKeyNavigation.panel.left - initialPanel.panel.left) <= 1 &&
          Math.abs(afterKeyNavigation.panel.top - initialPanel.panel.top) <= 1,
        `${anchorLabel}: panel position is independent of shell width/bottom and survives a WYS rerender`
      );
      await liveFrame.evaluate(() => repositionDirectEditor());

      const zoomedPanel = await liveFrame.evaluate(() => {
        const previous = zoom;
        setZoom(previous >= 2.8 ? previous / 1.17 : previous * 1.17);
        return previous;
      }).then(async (previousZoom) => {
        await liveFrame.evaluate(() => new Promise((resolve) => requestAnimationFrame(() =>
          requestAnimationFrame(resolve)
        )));
        return { previousZoom, measurement: await measureOpaqueSuggestionPanel(liveFrame) };
      });
      assert.deepEqual(zoomedPanel.measurement.anchor, initialPanel.anchor,
        `${anchorLabel}: zoom preserves the canonical paper point`);
      assertCanonicalPanelAnchor(zoomedPanel.measurement, `${anchorLabel} zoom`);

      const beforeScroll = zoomedPanel.measurement;
      const scrollMove = await liveFrame.evaluate(() => {
        const container = document.getElementById("pages");
        const before = container.scrollTop;
        const max = Math.max(0, container.scrollHeight - container.clientHeight);
        const desired = before + 36 <= max ? before + 36 : Math.max(0, before - 36);
        container.scrollTop = desired;
        return { before, desired, max };
      });
      await liveFrame.evaluate(() => new Promise((resolve) => requestAnimationFrame(() =>
        requestAnimationFrame(resolve)
      )));
      const afterScroll = await measureOpaqueSuggestionPanel(liveFrame);
      assert.deepEqual(afterScroll.anchor, initialPanel.anchor,
        `${anchorLabel}: scroll preserves the canonical paper point`);
      assertCanonicalPanelAnchor(afterScroll, `${anchorLabel} scroll`);
      if (scrollMove.max >= 20) {
        assert.ok(Math.abs(afterScroll.scrollTop - scrollMove.before) >= 20,
          `${anchorLabel}: the regression exercises a real preview scroll: ${JSON.stringify(scrollMove)}`);
        assert.ok(
          Math.abs(
            (afterScroll.panel.top - beforeScroll.panel.top) -
            (afterScroll.page.top - beforeScroll.page.top)
          ) <= 2,
          `${anchorLabel}: panel follows its canonical page by the exact scroll delta`
        );
      } else {
        assert.equal(afterScroll.scrollTop, 0,
          `${anchorLabel}: a page that fits the in-tab viewer remains unscrolled`);
      }

      await liveFrame.evaluate(({ previousZoom, previousScroll }) => {
        directEditor.wysiwyg.close();
        setZoom(previousZoom);
        document.getElementById("pages").scrollTop = previousScroll;
        requestAnimationFrame(repositionDirectEditor);
      }, {
        previousZoom: zoomedPanel.previousZoom,
        previousScroll: scrollMove.before,
      });
      await liveFrame.evaluate(() => new Promise((resolve) => requestAnimationFrame(() =>
        requestAnimationFrame(resolve)
      )));

      const originalMath = await editor.evaluate((field) => field.getValue?.("latex") || field.value);
      assert.match(originalMath, /begin\{(?:cases|bmatrix)\}/);
      const replacement = /begin\{cases\}/.test(originalMath)
        ? originalMath.replace("x^2", "x^3")
        : originalMath.replace("3&4", "3&5");
      await editor.evaluate((field, value) => {
        field.value = value;
        field.dispatchEvent(new Event("input", { bubbles: true }));
        field.blur();
      }, replacement);
      await waitFor(
        () => page.evaluate(() => window.monaco?.editor?.getModels?.()
          .find((model) => /main\.tex$/.test(model.uri?.path || model.uri?.toString?.() || ""))?.getValue?.() ?? ""),
        (value) => /begin\{cases\}/.test(replacement) ? value.includes("x^3") : value.includes("3&5"),
        15_000
      );
    }

    await clickCanonicalSource(liveFrame, {
      file: path.join(workspace, "main.tex"), line: 14, column: 3,
    });
    await liveFrame.locator(".tdom-direct-editor").waitFor({ state: "detached", timeout: 5_000 });
    assert.equal(await liveFrame.locator(".tdom-direct-editor").count(), 0, "clicking the image itself never edits its caption");
    const referenceWord = await clickCanonicalWordAfter(liveFrame, "Reference check: Figure");
    assert.match(referenceWord.text, /1/);
    await liveFrame.waitForTimeout(200);
    assert.equal(await liveFrame.locator(".tdom-direct-editor").count(), 0, "clicking a resolved reference never opens prose editing");

    const convergenceStarted = Date.now();
    const convergedText = await waitFor(
      () => liveFrame.evaluate(() => fetch("/canonical/text", { cache: "no-store" }).then((response) => response.json())),
      (result) => {
        const text = result.pages?.join("\n") ?? "";
        return text.includes("Revised Two Column Paper") &&
          text.includes("Right column revised immediately.") &&
          text.includes("Revised footnote text.") &&
          text.includes("Revised figure caption") &&
          text.includes("Beta") &&
          text.includes("Revised table caption");
      },
      30_000
    );
    assert.ok(Date.now() - convergenceStarted < 30_000, "the exact two-column page converges without stalling");
    assert.match(convergedText.pages.join("\n"), /Alice Author/);
    assert.match(convergedText.pages.join("\n"), /August 2026/);
    const finalSource = await page.evaluate(() => window.monaco?.editor?.getModels?.()
      .find((model) => /main\.tex$/.test(model.uri?.path || model.uri?.toString?.() || ""))?.getValue?.() ?? "");
    assert.match(finalSource, /\\includegraphics\[[^\]]*\]\{figures\/sample-image\.png\}/);
    assert.match(finalSource, /\\ref\{fig:two-column\}/);
    assert.match(finalSource, /\\begin\{tabular\}\{lc\}/);
    assert.match(finalSource, /\\label\{eq:cases-two-column\}/);
    assert.match(finalSource, /\\label\{eq:matrix-two-column\}/);
  } finally {
    await closeElectronApp(app);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
