import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const WEB_ROOT = path.resolve(fileURLToPath(new URL("../Resources/web/", import.meta.url)));
const MIME = new Map([
  [".css", "text/css"],
  [".html", "text/html"],
  [".js", "text/javascript"],
  [".mjs", "text/javascript"],
  [".woff2", "font/woff2"],
]);

const startStaticServer = async () => {
  const requests = [];
  const server = createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    requests.push(pathname);
    const relative = pathname === "/" ? "pdf-viewer.html" : pathname.replace(/^\/+/, "");
    const file = path.resolve(WEB_ROOT, relative);
    if (file !== WEB_ROOT && !file.startsWith(`${WEB_ROOT}${path.sep}`)) {
      response.writeHead(403).end();
      return;
    }
    try {
      const body = readFileSync(file);
      response.writeHead(200, { "content-type": MIME.get(path.extname(file)) || "application/octet-stream" });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    server,
    base: `http://127.0.0.1:${server.address().port}`,
    requests,
  };
};

test("document reset keeps static PDF visible until the matching exact epoch is ready", { timeout: 20_000 }, async (t) => {
  const { server, base, requests } = await startStaticServer();
  t.after(() => server.close());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  await page.addInitScript(() => {
    window.__pdfOutbound = [];
    window.tex64Pdf = {
      postMessage(payload) { window.__pdfOutbound.push(payload); },
      onMessage(handler) { window.__pdfInbound = handler; },
    };
  });
  await page.route("**/live/**", (route) => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><style>html,body{margin:0;width:100%;height:100%;background:#123}#live{position:fixed;inset:0;background:#13579b}</style>
      <div id="live"></div>
      <script>
        const activationId = new URLSearchParams(location.search).get('activationId');
        window.resetAcks = [];
        window.hostMessages = [];
        window.addEventListener('message', (event) => {
          const data = event.data;
          if (data?.source === 'tdom-host' && data.activationId === activationId) hostMessages.push(data);
          if (data?.source === 'tdom-host' && data.activationId === activationId && data.action === 'reset-ack') {
            resetAcks.push(data.documentEpoch);
          }
        });
        window.sendHost = (payload) => parent.postMessage({ source:'tdom-embed', activationId, ...payload }, '*');
      <\/script>`,
  }));

  await page.goto(`${base}/pdf-viewer.html`);
  await page.waitForFunction(() => typeof window.__pdfInbound === "function");
  await page.evaluate((liveUrl) => {
    const marker = document.createElement("div");
    marker.id = "static-pdf-marker";
    Object.assign(marker.style, {
      position: "fixed", left: "300px", top: "250px", width: "120px", height: "120px",
      background: "rgb(215, 35, 35)", zIndex: "1",
    });
    document.getElementById("pdf-pages").append(marker);
    window.__pdfInbound({ type: "live", payload: { url: liveUrl, generation: 1 } });
  }, `${base}/live`);

  const frameElement = page.locator("#pdf-live-frame");
  await frameElement.waitFor({ state: "attached" });
  await page.waitForFunction(() => document.getElementById("pdf-live-frame").src.includes("/live/"));
  const liveFrame = page.frames().find((frame) => frame.url().includes("/live/"));
  assert.ok(liveFrame);
  await liveFrame.evaluate(() => window.sendHost({
    ready: true,
    documentEpoch: 1,
    pageCount: 4,
    page: 1,
    zoom: 1,
    status: { up: true, mode: "structured" },
  }));
  await page.waitForFunction(() => document.body.classList.contains("is-live"));
  const activationId = new URL(liveFrame.url()).searchParams.get("activationId");
  await page.waitForFunction(() => window.__pdfOutbound.some((item) =>
    item?.type === "live-surface-ready" && item.payload?.generation === 1
  ));

  await page.locator("#pdf-next").click();
  await page.locator("#pdf-next").click();
  assert.equal(await page.locator("#pdf-page-input").inputValue(), "3");
  await liveFrame.waitForFunction(() =>
    window.hostMessages.filter((item) => item.action === "goto-page").slice(-2)
      .map((item) => item.page).join(",") === "2,3"
  );
  await page.evaluate(() => window.__pdfInbound({
    type: "sync",
    payload: { page: 4, x: 72, y: 360, sourceFile: "main.tex", sourceLine: 55, sourceColumn: 3 },
  }));
  assert.equal(await page.locator("#pdf-page-input").inputValue(), "4");
  await liveFrame.waitForFunction(() => window.hostMessages.some((item) =>
    item.action === "goto-sync" && item.page === 4 && item.y === 360 &&
    item.sourceFile === "main.tex" && item.sourceLine === 55
  ));

  await liveFrame.evaluate(() => window.sendHost({ action: "reset-pending", documentEpoch: 2 }));
  await page.waitForFunction(() => document.body.classList.contains("is-live-pending"));
  await liveFrame.waitForFunction(() => window.resetAcks.includes(2));
  const pendingState = await page.evaluate(() => {
    const iframe = document.getElementById("pdf-live-frame");
    const marker = document.getElementById("static-pdf-marker");
    const rect = marker.getBoundingClientRect();
    return {
      live: document.body.classList.contains("is-live"),
      visibility: getComputedStyle(iframe).visibility,
      zIndex: getComputedStyle(iframe).zIndex,
      staticAtPoint: document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)?.id,
    };
  });
  assert.deepEqual(pendingState, {
    live: false,
    visibility: "visible",
    zIndex: "0",
    staticAtPoint: "static-pdf-marker",
  });
  const staticPixels = await page.screenshot({ clip: { x: 310, y: 260, width: 20, height: 20 } });

  await liveFrame.evaluate(() => window.sendHost({ ready: true, documentEpoch: 1 }));
  await page.waitForTimeout(50);
  assert.equal(await page.evaluate(() => document.body.classList.contains("is-live")), false);

  // Freeze the parent's animation frames so both sides of the paint barrier
  // are observable deterministically. The live iframe is paintable below
  // the static PDF, but neither the ready message nor the first rAF may
  // expose it.
  await page.evaluate(() => {
    window.__nativeRequestAnimationFrame = window.requestAnimationFrame.bind(window);
    window.__rafCallbacks = [];
    window.requestAnimationFrame = (callback) => {
      window.__rafCallbacks.push(callback);
      return window.__rafCallbacks.length;
    };
    window.__flushOneAnimationFrame = () => {
      const callbacks = window.__rafCallbacks.splice(0);
      callbacks.forEach((callback) => callback(performance.now()));
    };
  });
  await liveFrame.evaluate(() => window.sendHost({
    ready: true,
    documentEpoch: 2,
    pageCount: 1,
    page: 1,
    zoom: 1,
    status: { up: true, mode: "structured" },
  }));
  await page.waitForFunction(() =>
    document.getElementById("pdf-live-frame")?.dataset.livePhase === "staging" &&
    window.__rafCallbacks.length === 1
  );
  assert.equal(await page.evaluate(() => document.body.classList.contains("is-live")), false);
  assert.equal(await page.evaluate(() => {
    const marker = document.getElementById("static-pdf-marker");
    const rect = marker.getBoundingClientRect();
    return document.elementFromPoint(rect.left + 10, rect.top + 10)?.id;
  }), "static-pdf-marker");
  assert.deepEqual(
    await page.screenshot({ clip: { x: 310, y: 260, width: 20, height: 20 } }),
    staticPixels,
    "ready alone does not change a single covered pixel"
  );

  await page.evaluate(() => window.__flushOneAnimationFrame());
  await page.waitForFunction(() => window.__rafCallbacks.length === 1);
  assert.equal(await page.evaluate(() => document.body.classList.contains("is-live")), false);
  assert.deepEqual(
    await page.screenshot({ clip: { x: 310, y: 260, width: 20, height: 20 } }),
    staticPixels,
    "the first paint keeps the static cover intact"
  );
  await page.evaluate(() => window.__flushOneAnimationFrame());
  await page.waitForFunction(() => document.body.classList.contains("is-live"));
  assert.notDeepEqual(
    await page.screenshot({ clip: { x: 310, y: 260, width: 20, height: 20 } }),
    staticPixels,
    "only the committed second paint reveals live pixels"
  );
  assert.equal(new URL(await frameElement.getAttribute("src")).searchParams.get("activationId"), activationId);
  await page.evaluate(() => {
    window.requestAnimationFrame = window.__nativeRequestAnimationFrame;
  });

  // The same engine URL with a new generation is a different activation.
  // Its navigation is covered immediately; a delayed ready from the old
  // activation cannot uncover it.
  await page.evaluate((liveUrl) => {
    window.__pdfInbound({ type: "live", payload: { url: liveUrl, generation: 2 } });
  }, `${base}/live`);
  await page.waitForFunction(() => document.body.classList.contains("is-live-pending"));
  const nextActivationId = await page.waitForFunction((prior) => {
    const src = document.getElementById("pdf-live-frame")?.src;
    if (!src) return false;
    const id = new URL(src).searchParams.get("activationId");
    return id && id !== prior ? id : false;
  }, activationId).then((handle) => handle.jsonValue());
  const nextFrame = page.frames().find((frame) =>
    new URL(frame.url()).searchParams.get("activationId") === nextActivationId
  );
  assert.ok(nextFrame);
  await nextFrame.evaluate((staleActivationId) => {
    parent.postMessage({
      source: "tdom-embed",
      activationId: staleActivationId,
      ready: true,
      documentEpoch: 99,
    }, "*");
  }, activationId);
  await page.waitForTimeout(50);
  assert.equal(await page.evaluate(() => document.body.classList.contains("is-live")), false);
  await nextFrame.evaluate(() => window.sendHost({
    ready: true,
    documentEpoch: 1,
    pageCount: 1,
    page: 1,
    zoom: 1,
    status: { up: true, mode: "structured" },
  }));
  await page.waitForFunction(() => document.body.classList.contains("is-live"));

  await page.evaluate((url) => window.__pdfInbound({
    type: "open",
    payload: { url, path: "/tmp/deferred.pdf" },
  }), `${base}/deferred.pdf`);
  await page.waitForTimeout(50);
  assert.equal(requests.includes("/deferred.pdf"), false, "static reload is frozen below Live");

  await page.evaluate(() => window.__pdfInbound({ type: "live", payload: null }));
  await page.waitForFunction(() =>
    !document.body.classList.contains("is-live") &&
    !document.body.classList.contains("is-live-pending")
  );
  const offState = await page.evaluate(() => {
    const iframe = document.getElementById("pdf-live-frame");
    const marker = document.getElementById("static-pdf-marker");
    const rect = marker.getBoundingClientRect();
    return {
      display: getComputedStyle(iframe).display,
      ariaHidden: iframe.getAttribute("aria-hidden"),
      staticAtPoint: document.elementFromPoint(rect.left + 10, rect.top + 10)?.id,
    };
  });
  assert.deepEqual(offState, {
    display: "none",
    ariaHidden: "true",
    staticAtPoint: "static-pdf-marker",
  });
  const deferredDeadline = Date.now() + 2_000;
  while (!requests.includes("/deferred.pdf") && Date.now() < deferredDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(requests.includes("/deferred.pdf"), true, "latest static reload resumes only after Live is off");

  // A terminal startup error is also a surface. A newly shown native window
  // must not be revealed merely because the viewer document loaded; wait
  // until the error text itself has crossed the same two-paint barrier.
  await page.evaluate(() => {
    window.__nativeRequestAnimationFrame = window.requestAnimationFrame.bind(window);
    window.__rafCallbacks = [];
    window.requestAnimationFrame = (callback) => {
      window.__rafCallbacks.push(callback);
      return window.__rafCallbacks.length;
    };
    window.__flushOneAnimationFrame = () => {
      const callbacks = window.__rafCallbacks.splice(0);
      callbacks.forEach((callback) => callback(performance.now()));
    };
    window.__pdfInbound({
      type: "live-error",
      payload: { error: "engine failed", url: null, generation: 23 },
    });
  });
  await page.waitForFunction(() => window.__rafCallbacks.length === 1);
  assert.equal(await page.evaluate(() => window.__pdfOutbound.some((item) =>
    item?.type === "live-error-surface-ready" && item.payload?.generation === 23
  )), false, "setting error text alone cannot reveal a native window");
  await page.evaluate(() => window.__flushOneAnimationFrame());
  await page.waitForFunction(() => window.__rafCallbacks.length === 1);
  assert.equal(await page.evaluate(() => window.__pdfOutbound.some((item) =>
    item?.type === "live-error-surface-ready" && item.payload?.generation === 23
  )), false, "the first error paint remains covered");
  await page.evaluate(() => window.__flushOneAnimationFrame());
  await page.waitForFunction(() => window.__pdfOutbound.some((item) =>
    item?.type === "live-error-surface-ready" && item.payload?.generation === 23
  ));
  await page.evaluate(() => {
    window.requestAnimationFrame = window.__nativeRequestAnimationFrame;
  });
});

