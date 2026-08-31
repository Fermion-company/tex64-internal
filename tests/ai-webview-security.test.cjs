"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  hardenAiWebviewPreferences,
  isAllowedAiWebviewSource,
  secureAiWebviewContents,
} = require("../electron/services/ai-web-security.cjs");

test("will-attach hardening replaces hostile guest preferences", () => {
  const preferences = {
    allowRunningInsecureContent: true,
    contextIsolation: false,
    nodeIntegration: true,
    preload: "/tmp/untrusted-preload.cjs",
    sandbox: false,
    webSecurity: false,
  };
  hardenAiWebviewPreferences(preferences, "/app/electron/ai-web-preload.cjs");
  assert.deepEqual(preferences, {
    allowRunningInsecureContent: false,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    nodeIntegrationInWorker: false,
    preload: "/app/electron/ai-web-preload.cjs",
    sandbox: true,
    webSecurity: true,
  });
});

test("packaged webviews attach only to the running 127.0.0.1 origin", () => {
  const options = {
    packaged: true,
    expectedOrigin: "http://127.0.0.1:43123",
  };
  assert.equal(
    isAllowedAiWebviewSource(
      "http://127.0.0.1:43123/",
      options,
    ),
    true,
  );
  for (const source of [
    "http://localhost:43123/",
    "http://127.0.0.1:43124/",
    "https://127.0.0.1:43123/",
    "https://ai.tex64.com/",
    "file:///tmp/index.html",
  ]) {
    assert.equal(isAllowedAiWebviewSource(source, options), false, source);
  }
  assert.equal(
    isAllowedAiWebviewSource("https://dev.example/ai", {
      packaged: false,
      expectedOrigin: null,
    }),
    true,
    "source builds keep their configurable HTTP(S) development URL",
  );
});

test("an attached guest cannot navigate, open windows, or request permissions outside its origin", () => {
  const contents = new EventEmitter();
  let windowOpenHandler = null;
  let permissionCheckHandler = null;
  let permissionRequestHandler = null;
  let devicePermissionHandler = null;
  contents.setWindowOpenHandler = (handler) => {
    windowOpenHandler = handler;
  };
  contents.session = {
    setDevicePermissionHandler: (handler) => {
      devicePermissionHandler = handler;
    },
    setPermissionCheckHandler: (handler) => {
      permissionCheckHandler = handler;
    },
    setPermissionRequestHandler: (handler) => {
      permissionRequestHandler = handler;
    },
  };

  assert.equal(
    secureAiWebviewContents(contents, {
      initialUrl: "http://127.0.0.1:43123/",
      packaged: true,
      expectedOrigin: "http://127.0.0.1:43123",
    }),
    true,
  );

  const sameOriginEvent = { preventDefault: () => assert.fail("same origin blocked") };
  contents.emit("will-navigate", sameOriginEvent, "http://127.0.0.1:43123/document");
  let blocked = 0;
  const blockedEvent = { preventDefault: () => { blocked += 1; } };
  contents.emit("will-navigate", blockedEvent, "https://attacker.example/");
  contents.emit("will-redirect", blockedEvent, "http://127.0.0.1:43124/");
  assert.equal(blocked, 2);
  assert.deepEqual(windowOpenHandler({ url: "https://attacker.example/" }), {
    action: "deny",
  });
  assert.equal(permissionCheckHandler(null, "camera"), false);
  assert.equal(devicePermissionHandler({ deviceType: "usb" }), false);
  let permissionGranted = true;
  permissionRequestHandler(null, "camera", (granted) => {
    permissionGranted = granted;
  });
  assert.equal(permissionGranted, false);
});

test("main process wires attach-time and post-attach webview defenses", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "electron", "main.cjs"),
    "utf8",
  );
  assert.match(source, /"will-attach-webview"/);
  assert.match(source, /hardenAiWebviewPreferences\(webPreferences, aiWebPreloadPath\)/);
  assert.match(source, /"did-attach-webview"/);
  assert.match(source, /secureAiWebviewContents\(contents/);
});
