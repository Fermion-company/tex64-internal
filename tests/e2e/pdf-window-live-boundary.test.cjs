const assert = require("node:assert/strict");
const fs = require("node:fs");
const { createServer } = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { _electron: electron } = require("playwright");

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const ELECTRON_BIN = require("electron");
const APP_ENTRY = path.join(PROJECT_ROOT, "tests/fixtures/pdf-window-live-boundary-app.cjs");
const STATIC_PDF = path.join(PROJECT_ROOT, "test-workspace/assets/pdfs/sample.pdf");

const closeElectronApp = async (electronApp) => {
  if (!electronApp) return;
  const child = electronApp.process();
  await Promise.race([
    electronApp.close().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child && !child.killed && child.exitCode == null) child.kill("SIGKILL");
};

const startLiveServer = async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html>
      <meta name="color-scheme" content="dark">
      <style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#0868d7}#surface{position:fixed;inset:0;background:#0868d7}</style>
      <div id="surface"></div>
      <script>
        const activationId = new URLSearchParams(location.search).get("activationId");
        window.sendReady = (documentEpoch = 1) => parent.postMessage({
          source: "tdom-embed",
          activationId,
          ready: true,
          documentEpoch,
          pageCount: 1,
          page: 1,
          zoom: 1,
          status: { up: true, busy: false, mode: "structured" },
        }, "*");
      <\/script>`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
};

const waitForManager = async (electronApp) => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const ready = await electronApp.evaluate(() => Boolean(globalThis.__pdfBoundaryManager));
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("PDFWindowManager did not initialize");
};

const nativeState = (electronApp) => electronApp.evaluate(() => {
  const manager = globalThis.__pdfBoundaryManager;
  const window = manager?.window;
  if (!window || window.isDestroyed()) return { exists: false };
  return {
    exists: true,
    visible: window.isVisible(),
    opacity: window.getOpacity(),
    ready: manager.isReady,
    currentPath: manager.currentPath,
    pendingLiveShow: manager.pendingLiveShow,
  };
});

const findLiveFrame = async (page) => {
  await page.waitForFunction(() => {
    const frame = document.getElementById("pdf-live-frame");
    return frame?.src?.startsWith("http://127.0.0.1:") && frame.src.includes("activationId=");
  }, null, { timeout: 10_000 });
  const deadline = Date.now() + 10_000;
  let frame = null;
  while (!frame && Date.now() < deadline) {
    frame = page.frames().find((candidate) => {
      try { return new URL(candidate.url()).searchParams.has("activationId"); } catch { return false; }
    }) ?? null;
    if (!frame) await page.waitForTimeout(10);
  }
  assert.ok(frame, "the staged Live iframe loaded");
  await frame.waitForFunction(() => typeof window.sendReady === "function");
  return frame;
};

const captureClip = (page, clip) => page.screenshot({ clip });

test("native detached window never exposes an uncommitted Live surface", { timeout: 45_000 }, async (t) => {
  assert.equal(fs.existsSync(STATIC_PDF), true, "static PDF fixture exists");
  const { server, baseUrl } = await startLiveServer();
  t.after(() => server.close());
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-pdf-boundary-"));
  const electronApp = await electron.launch({
    executablePath: ELECTRON_BIN,
    args: [APP_ENTRY],
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      TEX64_E2E: "1",
      TEX64_E2E_USERDATA: userData,
      // This test measures actual BrowserWindow visibility and opacity.
      TEX64_E2E_FORCE_HEADLESS: "0",
      NODE_ENV: "test",
    },
    timeout: 20_000,
  });
  t.after(() => closeElectronApp(electronApp));
  await waitForManager(electronApp);

  // Case 1: a rendered static PDF is the opaque cover while Live stages.
  await electronApp.evaluate((_electron, pdfPath) => {
    globalThis.__pdfBoundaryManager.show(pdfPath);
  }, STATIC_PDF);
  const staticPage = await electronApp.firstWindow();
  await staticPage.waitForLoadState("domcontentloaded");
  await staticPage.waitForFunction(() => {
    const canvas = document.querySelector("#pdf-pages .page canvas");
    return canvas instanceof HTMLCanvasElement && canvas.width > 100 && canvas.height > 100;
  }, null, { timeout: 15_000 });
  const canvasBox = await staticPage.locator("#pdf-pages .page canvas").first().boundingBox();
  assert.ok(canvasBox && canvasBox.width > 40 && canvasBox.height > 40, "static PDF has painted pixels");
  const clip = {
    x: Math.round(canvasBox.x + 16),
    y: Math.round(canvasBox.y + 16),
    width: 24,
    height: 24,
  };
  const staticPixels = await captureClip(staticPage, clip);

  await electronApp.evaluate((_electron, liveUrl) => {
    globalThis.__pdfBoundaryManager.setLive(liveUrl, { generation: 1, show: true });
  }, `${baseUrl}/with-static`);
  const staticLiveFrame = await findLiveFrame(staticPage);
  await staticPage.waitForFunction(() => document.body.classList.contains("is-live-pending"));
  for (let index = 0; index < 6; index += 1) {
    const state = await nativeState(electronApp);
    assert.equal(state.visible, true, "the static BrowserWindow stays visible");
    assert.equal(state.opacity, 1, "the static BrowserWindow stays opaque");
    assert.deepEqual(
      await captureClip(staticPage, clip),
      staticPixels,
      `staging frame ${index + 1} preserves every sampled static PDF pixel`
    );
    await staticPage.waitForTimeout(16);
  }
  await staticLiveFrame.evaluate(() => window.sendReady(1));
  await staticPage.waitForFunction(() => document.body.classList.contains("is-live"));
  await staticPage.waitForFunction(() => document.getElementById("pdf-live-frame")?.dataset.livePhase === "active");
  assert.notDeepEqual(await captureClip(staticPage, clip), staticPixels, "committed Live pixels replace static PDF pixels");

  // Case 2: without a static PDF, Chromium is warmed in a visible native
  // window whose compositor opacity is zero. Only live-surface-ready may
  // make it opaque.
  await electronApp.evaluate(() => {
    const manager = globalThis.__pdfBoundaryManager;
    manager.setLive(null, { generation: 2, hide: true });
    manager.close();
  });
  const closeDeadline = Date.now() + 10_000;
  while ((await nativeState(electronApp)).exists && Date.now() < closeDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal((await nativeState(electronApp)).exists, false, "the static window closed before the Live-only case");
  const nextWindow = electronApp.waitForEvent("window", { timeout: 10_000 });
  await electronApp.evaluate((_electron, liveUrl) => {
    globalThis.__pdfBoundaryNativeEvents.length = 0;
    globalThis.__pdfBoundaryManager.setLive(liveUrl, { generation: 3, show: true });
  }, `${baseUrl}/without-static`);
  const liveOnlyPage = await nextWindow;
  await liveOnlyPage.waitForLoadState("domcontentloaded");
  const liveOnlyFrame = await findLiveFrame(liveOnlyPage);
  await liveOnlyPage.waitForFunction(() => document.body.classList.contains("is-live-pending"));

  const preReadySamples = [];
  for (let index = 0; index < 12; index += 1) {
    preReadySamples.push(await nativeState(electronApp));
    await liveOnlyPage.waitForTimeout(8);
  }
  assert.equal(preReadySamples.every((state) => state.visible === true), true, "the hidden-opacity window is actually warmed");
  assert.equal(preReadySamples.every((state) => state.opacity === 0), true, "no sampled pre-ready native frame is visible");
  const firstNativeShow = await electronApp.evaluate(() =>
    globalThis.__pdfBoundaryNativeEvents.find((event) => event.type === "show-inactive-before") ?? null
  );
  assert.ok(firstNativeShow, "the actual native showInactive boundary was observed");
  assert.equal(firstNativeShow.opacity, 0, "native opacity was already zero before first visibility");

  await liveOnlyFrame.evaluate(() => window.sendReady(1));
  await liveOnlyPage.waitForFunction(() => document.body.classList.contains("is-live"));
  const committedDeadline = Date.now() + 10_000;
  let committedState = await nativeState(electronApp);
  while (committedState.opacity !== 1 && Date.now() < committedDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    committedState = await nativeState(electronApp);
  }
  assert.equal(committedState.opacity, 1, "matching live-surface-ready reveals the native window");
  assert.equal(committedState.pendingLiveShow, null, "the exact activation completed");

  // Case 3: a startup error is not allowed to bypass the paint handshake.
  // The acknowledgement can be fast, so assert the actual native call order
  // recorded around BrowserWindow.showInactive.
  await electronApp.evaluate(() => {
    const manager = globalThis.__pdfBoundaryManager;
    manager.setLive(null, { generation: 4, hide: true, error: null });
    manager.close();
  });
  const errorCloseDeadline = Date.now() + 10_000;
  while ((await nativeState(electronApp)).exists && Date.now() < errorCloseDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const errorWindowPromise = electronApp.waitForEvent("window", { timeout: 10_000 });
  await electronApp.evaluate(() => {
    globalThis.__pdfBoundaryNativeEvents.length = 0;
    globalThis.__pdfBoundaryManager.setLive(null, {
      generation: 5,
      show: true,
      error: "リアルタイムプレビュー: engine failed",
    });
  });
  const errorPage = await errorWindowPromise;
  await errorPage.waitForLoadState("domcontentloaded");
  await errorPage.waitForFunction(() =>
    document.getElementById("pdf-status")?.textContent === "リアルタイムプレビュー: engine failed"
  );
  const errorReadyDeadline = Date.now() + 10_000;
  let errorState = await nativeState(electronApp);
  while ((errorState.opacity !== 1 || errorState.pendingLiveShow !== null) && Date.now() < errorReadyDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    errorState = await nativeState(electronApp);
  }
  const errorNativeEvents = await electronApp.evaluate(() => [...globalThis.__pdfBoundaryNativeEvents]);
  const errorShows = errorNativeEvents.filter((event) => event.type === "show-inactive-before");
  assert.equal(errorShows.length >= 2, true, "error window was warmed, then committed");
  assert.equal(errorShows[0].opacity, 0, "the first native error-window show is transparent");
  assert.equal(errorShows.at(-1).opacity, 1, "only the painted error acknowledgement reveals it");
  assert.equal(errorState.pendingLiveShow, null);
});
