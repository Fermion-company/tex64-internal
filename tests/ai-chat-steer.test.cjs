"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const ts = require("typescript");

// The real Code side chat's submit path (ai-chat-ui-events) and its steering
// controller, transpiled with the modules they import, driven through fake
// host callbacks. The payload it posts is then fed to the main process's
// steering.cjs, the path the AI workspace already uses.
const MODULES = ["ai-chat-ui-events", "ai-chat-steer", "ai-chat-message", "ai-i18n", "i18n"];
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-ai-chat-steer-"));
fs.writeFileSync(path.join(outDir, "package.json"), JSON.stringify({ type: "module" }));
for (const name of MODULES) {
  const source = fs.readFileSync(path.join(__dirname, "../web-src/app", `${name}.ts`), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText;
  fs.writeFileSync(path.join(outDir, `${name}.js`), output);
}
test.after(() => fs.rmSync(outDir, { recursive: true, force: true }));

const { acceptSteering } = require("../electron/services/openprism/steering.cjs");

// ── Fake host ──
const timers = new Map();
let nextTimer = 1;
globalThis.window = {
  setTimeout: (fn) => { const id = nextTimer++; timers.set(id, fn); return id; },
  clearTimeout: (id) => { timers.delete(id); },
};
const runTimeouts = () => {
  for (const [id, fn] of [...timers]) {
    timers.delete(id);
    fn();
  }
};
class FakeElement {
  constructor() { this.listeners = {}; this.style = {}; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
}
class FakeHTMLElement extends FakeElement {}
class FakeButton extends FakeHTMLElement {}
class FakeTextArea extends FakeHTMLElement {
  constructor() { super(); this.value = ""; }
}
globalThis.Element = FakeElement;
globalThis.HTMLElement = FakeHTMLElement;
globalThis.HTMLButtonElement = FakeButton;
globalThis.HTMLTextAreaElement = FakeTextArea;
globalThis.HTMLInputElement = class extends FakeHTMLElement {};

const load = async () => import(pathToFileURL(path.join(outDir, "ai-chat-ui-events.js")).href);

const setup = async (options = {}) => {
  const { initAiChatEventBindings } = await load();
  const chat = {
    id: "chat-1",
    title: "Intro",
    messages: [],
    proposals: new Map(),
    appliedProposalIds: new Set(),
    statusMessage: "Editing — main.tex",
    hasUndo: false,
    queue: [],
  };
  const host = {
    chat,
    posts: [],
    runs: [],
    thinking: [],
    attachments: [],
    context: { ...(options.context ?? {}) },
    guest: false,
    postOk: true,
    running: new Set(),
    input: new FakeTextArea(),
  };
  const api = initAiChatEventBindings({
    aiChatLog: null,
    aiInput: host.input,
    aiSend: null,
    aiAttach: null,
    aiAttachInput: null,
    aiStatus: null,
    aiUndo: null,
    aiStop: null,
    aiChatNew: null,
    postToNative: (payload) => {
      host.posts.push(payload);
      return payload.type === "agent:steer" ? host.postOk : true;
    },
    getActiveChatId: () => chat.id,
    setActiveChatId: () => {},
    getPendingAttachments: () => host.attachments,
    getChat: (id) => (id === chat.id ? chat : null),
    createChat: () => chat,
    setChatTitle: () => {},
    renderHistoryList: () => {},
    appendMessage: (message) => { chat.messages.push(message); },
    removeQueuedMessage: (_chatId, queueId) => {
      chat.messages = chat.messages.filter((msg) => !(msg.queued && msg.queueId === queueId));
    },
    settleLiveProposals: () => {},
    autoGrow: () => {},
    updateContextBar: () => {},
    requestAgentRun: (chatId, message, parts, contextPayload) => {
      host.runs.push({ chatId, message, parts, contextPayload });
      host.running.add(chatId);
      return true;
    },
    buildContextPayload: (extras = {}) => ({ axiomSurface: "code", ...extras, ...host.context }),
    clearPendingAttachments: () => { host.attachments = []; },
    // @ references clear once sent; a selection stays in the editor.
    clearMentionPaths: () => {
      const { explicitContextRefs: _refs, explicitContextPaths: _paths, ...rest } = host.context;
      host.context = rest;
    },
    addImageFiles: async () => {},
    isAiBlocked: () => false,
    needsLogin: () => false,
    requestAiAccessCheck: () => {},
    requestPlatformUsage: () => {},
    updateStatusDisplay: () => {},
    resolvePricingUrl: () => "",
    openExternalUrl: () => {},
    runningConversations: host.running,
    resumableConversations: new Set(),
    pendingAgentRequests: new Map(),
    clearThinkingMessage: () => host.thinking.push("clear"),
    upsertThinkingMessage: () => host.thinking.push("upsert"),
    updateSendState: () => {},
    resetToNewChatState: () => {},
    isCollabGuest: () => host.guest,
  });
  // Typed into the composer and sent, the way Enter and the send button do.
  host.type = (text, extra = {}) => {
    host.input.value = text;
    api.submitMessage(text, { clearInput: true, steerIfRunning: true, ...extra });
  };
  host.steers = () => host.posts.filter((post) => post.type === "agent:steer");
  host.type("Write the introduction");
  assert.equal(host.runs.length, 1, "the first request starts a turn");
  return { api, host, chat };
};

test("a follow-up the host takes joins the running turn as an ordinary message", async () => {
  const { api, host, chat } = await setup();
  host.type("Keep it under 100 words");
  const [steer] = host.steers();
  assert.ok(steer, "the follow-up goes to the running turn");
  assert.equal(steer.conversationId, "chat-1");
  assert.equal(steer.message, "Keep it under 100 words");
  assert.match(steer.steeringId, /^steer-/);
  assert.ok(!steer.requestId.startsWith("ai-"), "a Code request id is never relayed to the AI workspace");
  assert.equal(host.input.value, "", "the composer empties at once");
  assert.equal(chat.queue.length, 0);
  assert.equal(chat.messages.length, 1, "nothing shows before the host answers");

  api.handleSteerResult({ requestId: steer.requestId, conversationId: "chat-1", accepted: true });
  assert.equal(chat.queue.length, 0, "an accepted follow-up is not queued");
  const last = chat.messages.at(-1);
  assert.deepEqual({ role: last.role, text: last.text, queued: last.queued }, { role: "user", text: "Keep it under 100 words", queued: undefined });
  assert.deepEqual(host.thinking.slice(-2), ["clear", "upsert"], "the working line moves below the correction");
  assert.equal(host.runs.length, 1, "no second turn starts");

  // A repeated answer changes nothing.
  api.handleSteerResult({ requestId: steer.requestId, conversationId: "chat-1", accepted: true });
  assert.equal(chat.messages.filter((msg) => msg.text === "Keep it under 100 words").length, 1);
});

test("the payload the chat posts is one the main process accepts for a Code conversation", async () => {
  const { host } = await setup();
  host.type("Use the active voice");
  const [steer] = host.steers();
  const conversation = [];
  const run = { acceptingSteering: true, controller: new AbortController(), workspaceRoot: "/work", steering: [] };
  const service = {
    buildConversation: () => conversation,
    runningControllers: new Map([["chat-1", run]]),
    workspace: { getRootPath: () => "/work" },
    markSessionDirty: () => {},
  };
  assert.equal(acceptSteering(service, steer.conversationId, steer), true);
  assert.deepEqual(run.steering, ["Use the active voice"]);
  assert.deepEqual(conversation, [{ role: "user", content: "Use the active voice", steeringId: steer.steeringId }]);
  // A retry of the same steer is not added twice.
  assert.equal(acceptSteering(service, steer.conversationId, steer), true);
  assert.equal(run.steering.length, 1);
  // Once the turn stops taking corrections, the host refuses.
  run.acceptingSteering = false;
  assert.equal(acceptSteering(service, steer.conversationId, { ...steer, steeringId: "steer-other" }), false);
});

test("a follow-up the host refuses waits in the queue", async () => {
  const { api, host, chat } = await setup();
  host.type("Add a citation");
  const [steer] = host.steers();
  api.handleSteerResult({ requestId: steer.requestId, conversationId: "chat-1", accepted: false });
  assert.equal(chat.queue.length, 1);
  assert.equal(chat.queue[0].text, "Add a citation");
  const last = chat.messages.at(-1);
  assert.equal(last.queued, true);
  assert.equal(last.queueId, chat.queue[0].id);
  assert.equal(host.runs.length, 1, "it waits for the running turn");

  // Something already waits: a later follow-up queues behind it, in order.
  host.type("And a footnote");
  assert.equal(host.steers().length, 1, "no steer overtakes the queue");
  assert.deepEqual(chat.queue.map((item) => item.text), ["Add a citation", "And a footnote"]);
});

test("attachments, @ references, a new selection, another mode or a guest session queue without steering", async () => {
  const { api, host, chat } = await setup();
  const queuedWithoutSteer = (label, act) => {
    // Each case starts from a plain follow-up with nothing waiting.
    chat.queue = [];
    host.context = {};
    const before = host.steers().length;
    const queued = chat.queue.length;
    act();
    assert.equal(host.steers().length, before, `${label}: no steer`);
    assert.equal(chat.queue.length, queued + 1, `${label}: queued`);
  };
  queuedWithoutSteer("attachment", () => {
    host.attachments = [{ mimeType: "image/png", data: "AAAA" }];
    host.type("What is in this figure?");
  });
  assert.match(chat.messages.at(-1).text, /\[attached images 1\]/);
  queuedWithoutSteer("@ file", () => {
    host.context = { explicitContextRefs: [{ kind: "file", path: "intro.tex" }], explicitContextPaths: ["intro.tex"] };
    host.type("Also fix @intro.tex");
  });
  queuedWithoutSteer("new selection", () => {
    host.context = { activeSelection: { path: "main.tex", startLine: 3, startColumn: 1, endLine: 4, endColumn: 9, textLength: 40 } };
    host.type("Rewrite this");
  });
  queuedWithoutSteer("another mode", () => {
    api.setMode("ask");
    host.type("Why did you do that?");
    api.setMode("agent");
  });
  queuedWithoutSteer("guest", () => {
    host.guest = true;
    host.type("Shorter");
    host.guest = false;
  });
  queuedWithoutSteer("quick action", () => {
    api.submitMessage("Retry this", { clearInput: false });
  });
  assert.equal(host.runs.length, 1, "none of them started a turn");

  // A steer the bridge could not deliver queues at once.
  chat.queue = [];
  host.context = {};
  host.postOk = false;
  host.type("Shorter");
  assert.equal(host.steers().length, 1, "the steer was tried");
  assert.equal(chat.queue.length, 1, "and the follow-up waits instead");
  assert.equal(chat.messages.at(-1).queued, true);
});

test("the selection the running turn started with does not stop a steer", async () => {
  const selection = { path: "main.tex", startLine: 3, startColumn: 1, endLine: 4, endColumn: 9, textLength: 40 };
  const { host, chat } = await setup({ context: { activeSelection: selection } });
  host.type("Keep the first sentence");
  assert.equal(host.steers().length, 1, "the unchanged selection still steers");
  assert.equal(chat.queue.length, 0);
  host.context = { activeSelection: { ...selection, endLine: 8 } };
  host.type("And this part");
  assert.equal(host.steers().length, 1, "a different selection needs its own turn");
  assert.equal(chat.queue.length, 1);
});

test("a refusal after the turn ended sends the follow-up as the next turn", async () => {
  const { api, host, chat } = await setup();
  host.type("Fix the typo too");
  const [steer] = host.steers();
  // The turn finished before the host read the steer.
  host.running.delete("chat-1");
  api.drainQueue("chat-1");
  assert.equal(host.runs.length, 1, "nothing goes out while the answer is pending");
  api.handleSteerResult({ requestId: steer.requestId, conversationId: "chat-1", accepted: false });
  assert.equal(host.runs.length, 2, "the follow-up starts its own turn");
  assert.equal(host.runs[1].message, "Fix the typo too");
  assert.equal(chat.queue.length, 0);
  assert.ok(!chat.messages.some((msg) => msg.queued), "no queued bubble is left behind");
});

test("no answer from the host falls back to the queue; a late answer is ignored", async () => {
  const { api, host, chat } = await setup();
  host.type("Number the equations");
  const [steer] = host.steers();
  runTimeouts();
  assert.equal(chat.queue.length, 1);
  api.handleSteerResult({ requestId: steer.requestId, conversationId: "chat-1", accepted: true });
  assert.equal(chat.messages.filter((msg) => msg.text === "Number the equations").length, 1, "shown once, as queued");
  assert.equal(chat.messages.at(-1).queued, true);
});
