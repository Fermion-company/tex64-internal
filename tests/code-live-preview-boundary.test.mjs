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
]);

const startServer = async () => {
  const server = createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    if (pathname === "/harness.html") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><meta charset=utf-8><title>Live boundary harness</title>");
      return;
    }
    const file = path.resolve(WEB_ROOT, pathname.replace(/^\/+/, ""));
    if (file !== WEB_ROOT && !file.startsWith(`${WEB_ROOT}${path.sep}`)) {
      response.writeHead(403).end();
      return;
    }
    try {
      response.writeHead(200, { "content-type": MIME.get(path.extname(file)) || "application/octet-stream" });
      response.end(readFileSync(file));
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
};

test("Code Live never republishes an obsolete project and tracks the detached destination while off", {
  timeout: 20_000,
}, async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${base}/harness.html`);

  await page.evaluate(async () => {
    localStorage.setItem("tex64.editor.feature.preview.realtime", "true");
    window.__liveState = {
      workspace: "/project-a",
      root: "/project-a/main.tex",
      path: "/project-a/main.tex",
      value: "A0",
      viewerMode: "window",
    };
    window.__viewerMessages = [];
    window.__workspaceViewerMessages = [];
    window.__windowMessages = [];
    window.__pushes = [];
    window.__changeListener = null;

    const editor = {
      getValue: () => window.__liveState.value,
      onDidChangeModelContent: (listener) => {
        window.__changeListener = listener;
        return { dispose: () => {
          if (window.__changeListener === listener) window.__changeListener = null;
        } };
      },
    };
    const group = {
      currentFilePath: window.__liveState.path,
      editor,
      isDirty: true,
      isComposing: false,
      viewer: {
        setLivePreview: (url, generation) => {
          window.__viewerMessages.push({ url, generation, at: performance.now() });
        },
      },
    };
    window.__group = group;
    window.tex64Tdom = {
      start: async () => ({ ok: true, url: "http://127.0.0.1:4633" }),
      stop: async () => ({ ok: true }),
      status: async () => ({ running: true, state: "ready" }),
      push: (payload) => new Promise((resolve, reject) => {
        window.__pushes.push({ payload, resolve, reject });
      }),
      windowLive: async (payload) => {
        window.__windowMessages.push(payload);
        return { ok: true };
      },
    };

    const { initCodeLivePreview } = await import("/app/code-live-preview.js");
    const { editorSettings } = await import("/app/editor-settings/editor-settings-store.js");
    window.__editorSettings = editorSettings;
    window.__controller = initCodeLivePreview({
      getActiveGroup: () => {
        group.currentFilePath = window.__liveState.path;
        return group;
      },
      getEditorGroups: () => [group],
      getAppMode: () => "code",
      getPdfViewerMode: () => window.__liveState.viewerMode,
      getWorkspaceRoot: () => window.__liveState.workspace,
      getRootFile: () => window.__liveState.root,
      getDirtyFileSnapshots: () => [{
        path: window.__liveState.path,
        content: window.__liveState.value,
        isDirty: true,
        truncated: false,
      }],
      setWorkspaceLivePreview: (url, generation) => {
        window.__workspaceViewerMessages.push({ url, generation, at: performance.now() });
      },
    });
  });

  await page.waitForFunction(() => window.__pushes.length === 1);
  await page.evaluate(() => window.__pushes[0].resolve({
    ok: true,
    url: "http://127.0.0.1:4633",
  }));
  await page.waitForFunction(() => window.__viewerMessages.some((item) => item.url));
  await page.waitForFunction(() => window.__workspaceViewerMessages.some((item) => item.url));
  const firstLive = await page.evaluate(() => window.__viewerMessages.filter((item) => item.url).at(-1));
  assert.deepEqual(
    await page.evaluate(() => window.__workspaceViewerMessages.filter((item) => item.url).at(-1).url),
    firstLive.url,
    "the visible integrated Code viewer receives the Live engine URL"
  );

  // Keep a project-A edit in flight, then switch the editor's real project.
  // The poll must retire A immediately, before the project-B debounce and
  // before the old promise is allowed to resolve.
  await page.evaluate(() => {
    window.__liveState.value = "A1";
    window.__changeListener();
  });
  await page.waitForFunction(() => window.__pushes.length === 2);
  await page.evaluate(() => {
    window.__liveState.workspace = "/project-b";
    window.__liveState.root = "/project-b/main.tex";
    window.__liveState.path = "/project-b/main.tex";
    window.__liveState.value = "B0";
  });
  await page.waitForFunction(() => window.__viewerMessages.at(-1)?.url === null);
  const retiredAt = await page.evaluate(() => window.__viewerMessages.length);

  await page.evaluate(() => window.__pushes[1].resolve({
    ok: true,
    url: "http://127.0.0.1:4633",
  }));
  await page.waitForFunction(() => window.__pushes.length === 3);
  const leaked = await page.evaluate((from) =>
    window.__viewerMessages.slice(from).some((item) => item.url !== null), retiredAt
  );
  assert.equal(leaked, false, "the completed project-A push stayed retired");

  await page.evaluate(() => window.__pushes[2].resolve({
    ok: true,
    url: "http://127.0.0.1:4633",
  }));
  await page.waitForFunction(() => window.__viewerMessages.at(-1)?.url !== null);
  const secondLive = await page.evaluate(() => window.__viewerMessages.at(-1));
  assert.ok(secondLive.generation > firstLive.generation);

  // The same boundary must hold when the obsolete request rejects. A stale
  // project failure may neither open an error window nor discard the newer
  // project's queued snapshot.
  await page.evaluate(() => {
    window.__liveState.value = "B1";
    window.__changeListener();
  });
  await page.waitForFunction(() => window.__pushes.length === 4);
  await page.evaluate(() => {
    window.__liveState.workspace = "/project-c";
    window.__liveState.root = "/project-c/main.tex";
    window.__liveState.path = "/project-c/main.tex";
    window.__liveState.value = "C0";
  });
  await page.waitForFunction(() => window.__viewerMessages.at(-1)?.url === null);
  const windowMessagesBeforeStaleFailure = await page.evaluate(() => window.__windowMessages.length);
  await page.evaluate(() => window.__pushes[3].reject(new Error("obsolete project B failure")));
  await page.waitForFunction(() => window.__pushes.length === 5);
  const staleErrors = await page.evaluate((from) =>
    window.__windowMessages.slice(from).filter((item) => item?.error), windowMessagesBeforeStaleFailure
  );
  assert.deepEqual(staleErrors, [], "the obsolete project error stayed invisible");
  await page.evaluate(() => window.__pushes[4].resolve({
    ok: true,
    url: "http://127.0.0.1:4633",
  }));
  await page.waitForFunction(() => window.__viewerMessages.at(-1)?.url !== null);

  // Live off in window mode keeps a real static window. Changing the build
  // destination afterward must produce a distinct null-state distribution
  // that hides that detached surface.
  await page.evaluate(() => window.__editorSettings.setFlag("preview.realtime", false));
  await page.waitForFunction(() => window.__windowMessages.at(-1)?.url === null);
  assert.equal(await page.evaluate(() => window.__windowMessages.at(-1).hide), false);
  await page.evaluate(() => { window.__liveState.viewerMode = "tab"; });
  await page.waitForFunction(() => window.__windowMessages.at(-1)?.hide === true);
});
