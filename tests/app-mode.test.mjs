import test from "node:test";
import assert from "node:assert/strict";
import {
  APP_MODE_STORAGE_KEY,
  parseAppMode,
  resolveInitialAppMode,
  initAppModeUi,
  prepareCodeWorkspaceHandoff,
  prepareAppModeTransition,
} from "../Resources/web/app/app-mode.js";
import {
  isAllowedAiGuestRequest,
  resolveAiEmbedUrl,
  sanitizeAiGuestEvent,
} from "../Resources/web/app/ai-mode-ui.js";

test("app mode parses only known modes", () => {
  assert.equal(parseAppMode("code"), "code");
  assert.equal(parseAppMode("ai"), "ai");
  assert.equal(parseAppMode("pro"), null);
  assert.equal(parseAppMode("PRO"), null);
  assert.equal(parseAppMode(""), null);
  assert.equal(parseAppMode(null), null);
});

test("desktop restores a known stored mode", () => {
  assert.equal(resolveInitialAppMode("ai"), "ai");
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

test("programmatic AI mode requests switch after approval", async () => {
  const previousGlobals = {
    document: globalThis.document,
    window: globalThis.window,
    localStorage: globalThis.localStorage,
    requestAnimationFrame: globalThis.requestAnimationFrame,
  };
  globalThis.document = {
    documentElement: { dataset: {} },
    activeElement: null,
    getElementById: () => null,
  };
  globalThis.window = { dispatchEvent() {} };
  globalThis.localStorage = { setItem() {} };
  globalThis.requestAnimationFrame = (callback) => {
    callback(0);
    return 1;
  };

  try {
    let aiApprovalCalls = 0;
    const changes = [];
    const api = initAppModeUi({
      initialMode: "code",
      beforeModeChange: (next) => {
        if (next === "ai") aiApprovalCalls += 1;
        return true;
      },
      onModeChange: (next) => changes.push(next),
    });
    api.setMode("ai");
    api.setMode("ai");
    assert.equal(aiApprovalCalls, 1, "the AI transition is approved once");
    assert.equal(api.getMode(), "ai");
    assert.deepEqual(changes, ["code", "ai"]);
  } finally {
    globalThis.document = previousGlobals.document;
    globalThis.window = previousGlobals.window;
    globalThis.localStorage = previousGlobals.localStorage;
    globalThis.requestAnimationFrame = previousGlobals.requestAnimationFrame;
  }
});

test("Code to AI stops old writers before saving and refuses either failure", async () => {
  const order = [];
  assert.deepEqual(
    await prepareAppModeTransition({
      next: "ai",
      previous: "code",
      quiesce: async () => {
        order.push("quiesce");
        return { ok: true };
      },
      saveCode: async () => {
        order.push("save");
        return true;
      },
    }),
    { ok: true },
  );
  assert.deepEqual(order, ["quiesce", "save"]);

  let savedAfterFailure = false;
  assert.deepEqual(
    await prepareAppModeTransition({
      next: "ai",
      previous: "code",
      quiesce: async () => ({ ok: false, error: "still running" }),
      saveCode: async () => {
        savedAfterFailure = true;
        return true;
      },
    }),
    { ok: false, phase: "quiesce", error: "still running" },
  );
  assert.equal(savedAfterFailure, false);
  assert.deepEqual(
    await prepareAppModeTransition({
      next: "ai",
      previous: "code",
      quiesce: async () => ({ ok: true }),
      saveCode: async () => false,
    }),
    { ok: false, phase: "save" },
  );
});

test("workspace changes use the same quiesce-before-save handoff", async () => {
  const order = [];
  assert.deepEqual(
    await prepareCodeWorkspaceHandoff({
      quiesce: async () => {
        order.push("quiesce");
        return { ok: true };
      },
      saveCode: async () => {
        order.push("save");
        return true;
      },
    }),
    { ok: true },
  );
  assert.deepEqual(order, ["quiesce", "save"]);

  let saved = false;
  assert.equal(
    (
      await prepareCodeWorkspaceHandoff({
        quiesce: async () => ({ ok: false }),
        saveCode: async () => {
          saved = true;
          return true;
        },
      })
    ).ok,
    false,
  );
  assert.equal(saved, false);
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

test("AI guest agent requests stay document and workspace scoped", () => {
  const conversationId = "tex64-ai-mode:workspace:paper%2Fmain.tex";
  assert.equal(
    isAllowedAiGuestRequest("agent:run", {
      conversationId,
      workspaceId: "workspace",
      workspaceGeneration: 2,
      documentMainFile: "paper/main.tex",
    }),
    true,
  );
  assert.equal(
    isAllowedAiGuestRequest("agent:run", {
      conversationId,
      workspaceId: "workspace",
      workspaceGeneration: 2,
      documentMainFile: "other/main.tex",
    }),
    false,
    "a turn cannot persist another document's work into this conversation",
  );
  assert.equal(
    isAllowedAiGuestRequest(
      "agent:state:get",
      { conversationId: "tex64-ai-mode:other-workspace:main.tex" },
      { workspaceId: "workspace", workspaceGeneration: 2 },
    ),
    false,
  );
  assert.equal(
    isAllowedAiGuestRequest("agent:run", {
      conversationId,
      workspaceId: "workspace",
      documentMainFile: "paper/main.tex",
    }),
    false,
  );
  assert.equal(
    isAllowedAiGuestRequest("agent:state:get", { conversationId: "code-chat" }),
    false,
  );
  assert.equal(
    isAllowedAiGuestRequest("file:bytes", {
      requestId: "ai-pdf-1",
      workspaceId: "workspace",
      workspaceGeneration: 2,
      documentMainFile: "paper/main.tex",
      path: "paper/main.pdf",
    }),
    true,
  );
  assert.equal(
    isAllowedAiGuestRequest("file:bytes", {
      requestId: "code-pdf-1",
      workspaceId: "workspace",
      workspaceGeneration: 2,
      documentMainFile: "paper/main.tex",
      path: "paper/main.pdf",
    }),
    false,
  );
});

test("AI guest workspace actions require and match the delivered workspace generation", () => {
  const expected = { workspaceId: "workspace-a", workspaceGeneration: 7 };
  const scoped = {
    requestId: "ai-request-1",
    workspaceId: "workspace-a",
    workspaceGeneration: 7,
  };
  assert.equal(
    isAllowedAiGuestRequest(
      "file:excerpt",
      { ...scoped, documentMainFile: "paper/main.tex", path: "paper/main.tex" },
      expected,
    ),
    true,
  );
  assert.equal(
    isAllowedAiGuestRequest(
      "file:excerpt",
      {
        ...scoped,
        workspaceGeneration: 6,
        documentMainFile: "paper/main.tex",
        path: "paper/main.tex",
      },
      expected,
    ),
    false,
  );
  assert.equal(
    isAllowedAiGuestRequest(
      "file:replaceLines",
      { requestId: "ai-request-2", workspaceId: "workspace-a", documentMainFile: "main.tex" },
      expected,
    ),
    false,
  );
  assert.equal(
    isAllowedAiGuestRequest(
      "build",
      { ...scoped, requestId: "ai-build-1", documentMainFile: "paper/main.tex" },
      { workspaceId: "workspace-b", workspaceGeneration: 7 },
    ),
    false,
  );
  assert.equal(isAllowedAiGuestRequest("openWorkspace", {}, expected), true);
});

test("AI guest never receives Code-mode conversation state", () => {
  assert.equal(
    sanitizeAiGuestEvent({
      type: "agent:message",
      payload: { conversationId: "code-chat", text: "private Code transcript" },
    }),
    null,
  );
  const conversationId = "tex64-ai-mode:workspace:paper%2Fmain.tex";
  const safe = sanitizeAiGuestEvent({
    type: "agent:state",
    payload: {
      requestId: "ai-agent-state-1",
      conversationId,
      sessions: [
        { conversationId, messages: [{ role: "user", text: "paper" }] },
        { conversationId: "code-chat", messages: [{ role: "user", text: "private" }] },
      ],
    },
  });
  assert.deepEqual(safe?.payload.sessions, [
    { conversationId, messages: [{ role: "user", text: "paper" }] },
  ]);
  assert.equal(
    sanitizeAiGuestEvent(
      {
        type: "agent:message",
        payload: {
          conversationId: "tex64-ai-mode:other-workspace:main.tex",
          text: "another workspace",
        },
      },
      { workspaceId: "workspace", workspaceGeneration: 2 },
    ),
    null,
  );
  assert.equal(
    sanitizeAiGuestEvent({
      type: "file:bytesResult",
      payload: { requestId: "code-pdf-1", ok: true, base64: "private" },
    }),
    null,
  );
  for (const [type, payload] of [
    [
      "file:excerptResult",
      { requestId: "excerpt-code-1", ok: true, lines: ["private source"] },
    ],
    ["synctex:reverseResult", { requestId: "synctex-code-1", path: "private.tex" }],
    [
      "agent:state",
      { requestId: "agent-code-1", conversationId, sessions: [{ conversationId }] },
    ],
  ]) {
    assert.equal(
      sanitizeAiGuestEvent({ type, payload }),
      null,
      `${type} must remain in Code mode`,
    );
  }
  assert.deepEqual(
    sanitizeAiGuestEvent({
      type: "file:excerptResult",
      payload: { requestId: "ai-excerpt-1", ok: true, lines: ["AI source"] },
    }),
    {
      type: "file:excerptResult",
      payload: { requestId: "ai-excerpt-1", ok: true, lines: ["AI source"] },
    },
  );
  assert.equal(
    sanitizeAiGuestEvent(
      {
        type: "file:excerptResult",
        payload: {
          requestId: "ai-excerpt-old-workspace",
          workspaceId: "workspace-old",
          workspaceGeneration: 6,
          ok: true,
          lines: ["old workspace source"],
        },
      },
      { workspaceId: "workspace-new", workspaceGeneration: 7 },
    ),
    null,
  );
});

test("AI retry discards a dead webview before requesting a fresh server config", async () => {
  const fs = await import("node:fs");
  const source = fs.readFileSync(
    new URL("../web-src/app/ai-mode-ui.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /retryButton[\s\S]{0,900}discardWebview\(\);[\s\S]{0,500}createWebview\(\)/,
  );
  assert.match(source, /const discardWebview[\s\S]{0,240}previous\?\.remove\(\)/);
});

test("the shipped desktop shell exposes Code and AI", async () => {
  const fs = await import("node:fs");
  const html = fs.readFileSync(new URL("../Resources/web/index.html", import.meta.url), "utf8");
  const init = fs.readFileSync(new URL("../web-src/main-init.ts", import.meta.url), "utf8");

  assert.match(html, /id="mode-switcher"/);
  assert.match(
    html,
    /<div class="topbar-left">[\s\S]*id="toggle-sidebar-button"[\s\S]*id="mode-switcher"[\s\S]*<\/div>\s*<div class="topbar-drag"><\/div>/,
  );
  assert.doesNotMatch(html, /id="ai-mode-open-browser"/);
  assert.doesNotMatch(html, /id="ai-mode-open-axiom"/);
  assert.match(html, /data-app-mode-tab="code"/);
  assert.match(html, /data-app-mode-tab="ai"/);
  assert.doesNotMatch(html, /data-app-mode-tab="pro"/);
  assert.match(html, /id="ai-mode-view"/);
  assert.match(html, /id="ai-mode-webview-host"/);
  assert.match(html, /<html[^>]*data-app-mode="code"/);
  assert.match(init, /initAiModeUi/);
  assert.match(init, /initAppModeUi/);
  assert.match(init, /APP_MODE_STORAGE_KEY/);
  assert.match(init, /getAppMode:\s*\(\)\s*=>\s*appModeApi\.getMode\(\)/);
});
