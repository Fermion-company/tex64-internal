import test from "node:test";
import assert from "node:assert/strict";
import {
  APP_MODE_STORAGE_KEY,
  parseAppMode,
  resolveInitialAppMode,
} from "../Resources/web/app/app-mode.js";
import { resolveAiEmbedUrl } from "../Resources/web/app/ai-mode-ui.js";

test("app mode parses only known modes", () => {
  assert.equal(parseAppMode("code"), "code");
  assert.equal(parseAppMode("ai"), null);
  assert.equal(parseAppMode("pro"), null);
  assert.equal(parseAppMode("PRO"), null);
  assert.equal(parseAppMode(""), null);
  assert.equal(parseAppMode(null), null);
});

test("desktop always starts in Code even when AI was stored", () => {
  assert.equal(resolveInitialAppMode("ai"), "code");
  assert.equal(resolveInitialAppMode("code"), "code");
});

test("initial mode migrates the removed Pro mode to Code", () => {
  assert.equal(resolveInitialAppMode("pro"), "code");
  assert.equal(resolveInitialAppMode(null), "code");
  assert.equal(resolveInitialAppMode("garbage"), "code");
});

test("storage key is stable", () => {
  assert.equal(APP_MODE_STORAGE_KEY, "tex64.appMode.v1");
});

test("AI embed URL gains the native marker without clobbering the URL", () => {
  assert.equal(
    resolveAiEmbedUrl("http://127.0.0.1:3100"),
    "http://127.0.0.1:3100/?embed=native"
  );
  assert.equal(
    resolveAiEmbedUrl("https://ai.tex64.com/docs?x=1#top"),
    "https://ai.tex64.com/docs?x=1&embed=native#top"
  );
  assert.equal(resolveAiEmbedUrl("not a url"), "not a url");
});

test("the shipped desktop shell has no app-mode switch or AI workspace", async () => {
  const fs = await import("node:fs");
  const html = fs.readFileSync(new URL("../Resources/web/index.html", import.meta.url), "utf8");
  const init = fs.readFileSync(new URL("../web-src/main-init.ts", import.meta.url), "utf8");

  assert.doesNotMatch(html, /id="mode-switcher"|data-app-mode-tab=/);
  assert.doesNotMatch(html, /id="ai-mode-view"|id="ai-mode-webview-host"/);
  assert.match(html, /<html[^>]*data-app-mode="code"/);
  assert.doesNotMatch(init, /initAiModeUi|initAppModeUi|APP_MODE_STORAGE_KEY/);
  assert.match(init, /getAppMode:\s*\(\)\s*=>\s*"code"/);
});
