"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..");

test("Code Axiom describes sign-in as optional account linking in every locale", () => {
  const source = fs.readFileSync(
    path.join(repoRoot, "web-src", "app", "ai-i18n.ts"),
    "utf8",
  );
  const overlay = source.match(/overlay_subtitle:\s*\{([^\n]+)\}/)?.[1] ?? "";
  const hint = source.match(/login_tex64_hint:\s*\{([^\n]+)\}/)?.[1] ?? "";
  for (const locale of ["en", "ja", "zh", "ko", "fr", "de", "es"]) {
    assert.match(overlay, new RegExp(`\\b${locale}:`), locale);
    assert.match(hint, new RegExp(`\\b${locale}:`), locale);
  }
  for (const optionalMarker of [
    "Optional sign-in",
    "任意ログイン",
    "可选登录",
    "선택 사항",
    "Connexion facultative",
    "Optional anmelden",
    "Inicio de sesión opcional",
  ]) {
    assert.equal(overlay.includes(optionalMarker), true, optionalMarker);
    assert.equal(hint.includes(optionalMarker), true, optionalMarker);
  }
  assert.doesNotMatch(source, /Log in to use Axiom|Axiom を使うにはログイン/);
});

test("the static first paint does not claim that Axiom requires login", () => {
  const html = fs.readFileSync(
    path.join(repoRoot, "Resources", "web", "index.html"),
    "utf8",
  );
  assert.match(html, /Optional sign-in links your Axiom allowance to your account/);
  assert.doesNotMatch(html, /Log in to use Axiom/);
});
