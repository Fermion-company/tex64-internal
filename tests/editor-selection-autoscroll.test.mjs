import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import {
  selectionAutoScrollDelta,
  selectionAutoScrollVelocity,
} from "../Resources/web/app/editor-selection-autoscroll.js";

const WEB_ROOT = path.resolve(fileURLToPath(new URL("../Resources/web/", import.meta.url)));
const MIME = new Map([
  [".css", "text/css"],
  [".html", "text/html"],
  [".js", "text/javascript"],
]);

const startServer = async () => {
  const server = createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    if (pathname === "/harness.html") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html>
        <meta charset="utf-8">
        <style>html,body,#host{width:100%;height:100%;margin:0;overflow:hidden}</style>
        <div id="host"></div>
        <script src="/monaco/vs/loader.js"></script>`);
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

test("selection drag stays still away from the editor edges", () => {
  assert.equal(selectionAutoScrollVelocity(300, { top: 100, bottom: 500 }, 20), 0);
});

test("selection drag scrolls toward either edge before the pointer leaves the window", () => {
  const down = selectionAutoScrollVelocity(495, { top: 100, bottom: 500 }, 20);
  const up = selectionAutoScrollVelocity(105, { top: 100, bottom: 500 }, 20);
  assert.ok(down > 0);
  assert.ok(up < 0);
  assert.equal(Math.abs(down), Math.abs(up));
});

test("selection drag velocity is capped outside the editor", () => {
  const atBottom = selectionAutoScrollVelocity(500, { top: 100, bottom: 500 }, 20);
  const farBelow = selectionAutoScrollVelocity(900, { top: 100, bottom: 500 }, 20);
  assert.equal(farBelow, atBottom);
});

test("selection drag frame delta is time based and caps stalled frames", () => {
  assert.equal(selectionAutoScrollDelta(300, 20), 6);
  assert.equal(selectionAutoScrollDelta(300, 200), 15);
  assert.equal(selectionAutoScrollDelta(Number.NaN, 20), 0);
});

test("real Monaco selection keeps scrolling while held at the browser bottom edge", {
  timeout: 20_000,
}, async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 640, height: 320 } });
  await page.goto(`${base}/harness.html`);
  await page.evaluate(async () => {
    window.require.config({ paths: { vs: `${location.origin}/monaco/vs` } });
    await new Promise((resolve, reject) => {
      window.require(["vs/editor/editor.main"], async () => {
        try {
          const { attachSelectionDragAutoScroll } = await import("/app/editor-selection-autoscroll.js");
          const value = Array.from({ length: 400 }, (_, index) => `line ${index + 1}`).join("\n");
          window.testEditor = window.monaco.editor.create(document.getElementById("host"), {
            value,
            language: "plaintext",
            lineHeight: 20,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
          });
          attachSelectionDragAutoScroll(window.monaco, window.testEditor, document.getElementById("host"));
          resolve();
        } catch (error) {
          reject(error);
        }
      }, reject);
    });
  });
  const viewLines = page.locator(".monaco-editor .view-lines");
  await viewLines.waitFor();
  const box = await viewLines.boundingBox();
  assert.ok(box);
  const x = box.x + Math.min(180, box.width / 2);
  await page.mouse.move(x, box.y + 80);
  await page.mouse.down();
  await page.mouse.move(x, box.y + box.height - 1, { steps: 12 });
  await page.waitForTimeout(650);
  const result = await page.evaluate(() => ({
    scrollTop: window.testEditor.getScrollTop(),
    endLine: window.testEditor.getSelection().positionLineNumber,
  }));
  await page.mouse.up();
  assert.ok(result.scrollTop > 80, `expected scrolling, got ${result.scrollTop}`);
  assert.ok(result.endLine > 18, `expected selection to extend below the first viewport, got line ${result.endLine}`);
});
