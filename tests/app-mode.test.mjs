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
  assert.equal(parseAppMode("ai"), "ai");
  assert.equal(parseAppMode("pro"), "pro");
  assert.equal(parseAppMode("PRO"), null);
  assert.equal(parseAppMode(""), null);
  assert.equal(parseAppMode(null), null);
});

test("initial mode prefers the stored switcher state", () => {
  assert.equal(resolveInitialAppMode("ai", true), "ai");
  assert.equal(resolveInitialAppMode("code", true), "code");
});

test("initial mode migrates the legacy Pro toggle", () => {
  assert.equal(resolveInitialAppMode(null, true), "pro");
  assert.equal(resolveInitialAppMode(null, false), "code");
  assert.equal(resolveInitialAppMode("garbage", true), "pro");
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
