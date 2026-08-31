"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  HARD_MAX_AGENT_ITERATIONS,
  MAX_AGENT_TOKENS_PER_RUN,
  buildReplayHistory,
  compactRequestMessages,
  estimateRequestInputTokenUpperBound,
  planNextRequest,
  resolveMaxAgentIterations,
} = require("../electron/services/openprism/run-budget.cjs");
const {
  runAgentConversation,
} = require("../electron/services/openprism/run-loop.cjs");

test("configured iteration counts can never exceed the 24-call product boundary", () => {
  assert.equal(HARD_MAX_AGENT_ITERATIONS, 24);
  assert.equal(resolveMaxAgentIterations(500), 24);
  assert.equal(resolveMaxAgentIterations(9999), 24);
  assert.equal(resolveMaxAgentIterations(8), 8);
  assert.equal(resolveMaxAgentIterations(undefined), 24);
});

test("conversation replay drops oldest text and never begins with a dangling assistant", () => {
  const huge = "x".repeat(30_000);
  const replayed = buildReplayHistory([
    { role: "assistant", content: "orphan" },
    { role: "user", content: huge },
    { role: "assistant", content: huge },
    { role: "user", content: "latest request" },
    { role: "assistant", content: "latest answer" },
  ]);
  assert.equal(replayed[0].role, "user");
  assert.deepEqual(replayed.slice(-2), [
    { role: "user", content: "latest request" },
    { role: "assistant", content: "latest answer" },
  ]);
  assert.ok(
    Buffer.byteLength(JSON.stringify(replayed), "utf8") < 50_000,
    "old thread text is not replayed without a bound",
  );

  const multibyte = buildReplayHistory([
    { role: "user", content: "数".repeat(100_000) },
  ]);
  assert.ok(Buffer.byteLength(multibyte[0].content, "utf8") <= 48_000);
});

test("old tool payloads compact after consumption while the latest result stays intact", () => {
  const oldArguments = JSON.stringify({ content: "A".repeat(20_000) });
  const latestResult = JSON.stringify({ content: "B".repeat(20_000) });
  const compacted = compactRequestMessages([
    { role: "system", content: "system" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "old", type: "function", function: { name: "write_file", arguments: oldArguments } },
      ],
    },
    { role: "tool", tool_call_id: "old", content: "C".repeat(20_000) },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "latest", type: "function", function: { name: "read_file", arguments: "{\"path\":\"main.tex\"}" } },
      ],
    },
    { role: "tool", tool_call_id: "latest", content: latestResult },
  ]);

  assert.ok(compacted[1].tool_calls[0].function.arguments.length < 200);
  assert.ok(compacted[2].content.length < 200);
  assert.equal(compacted[4].content, latestResult);
});

test("request planning reserves input and caps the provider completion inside remaining quota", () => {
  const messages = [{ role: "user", content: "write and compile" }];
  const tools = [{ type: "function", function: { name: "compile_document", parameters: {} } }];
  const inputUpperBound = estimateRequestInputTokenUpperBound(messages, tools);
  const remainingTokens = inputUpperBound + 1_000;
  const plan = planNextRequest({ remainingTokens, messages, tools });
  assert.equal(plan.allowed, true);
  assert.equal(plan.maxCompletionTokens, 1_000);
  assert.ok(inputUpperBound + plan.maxCompletionTokens <= remainingTokens);
  assert.equal(
    planNextRequest({
      remainingTokens: inputUpperBound + 100,
      messages,
      tools,
    }).allowed,
    false,
  );
});

const makeRunService = ({ quotaSequence, maxIterations = 9999 }) => {
  const conversation = [];
  const events = [];
  const run = { token: "budget-test", controller: new AbortController() };
  let quotaIndex = 0;
  return {
    conversation,
    events,
    service: {
      workspace: {
        getRootPath: () => "/tmp/tex64-budget-test",
        resolvePath: (value) => `/tmp/tex64-budget-test/${value}`,
      },
      ensureUserSettings: () => ({
        getAgentSettings: async () => ({ model: "Axiom1.0" }),
      }),
      resolveAgentPolicy: () => ({}),
      resolveAgentOptions: () => ({ maxIterations }),
      contextByConversation: new Map(),
      workspaceRootByConversation: new Map(),
      buildConversation: () => conversation,
      markSessionDirty: () => {},
      startConversationRun: () => run,
      isRunCurrent: (_conversationId, token) => token === run.token,
      finishConversationRun: () => {},
      sendToRenderer: (channel, payload) => events.push({ channel, payload }),
      sendStatus: () => {},
      platformAccess: {
        refreshAccessToken: async () => "test-token",
        ensureDeviceId: async () => "test-device",
        checkAiAccess: async () => {
          const remainingTokens =
            quotaSequence[Math.min(quotaIndex, quotaSequence.length - 1)];
          quotaIndex += 1;
          return {
            allowed: remainingTokens > 0,
            reason: remainingTokens > 0 ? "active" : "QUOTA_EXCEEDED",
            quota: { remainingTokens },
          };
        },
      },
    },
  };
};

test("the run loop stops before a second paid call when refreshed quota is exhausted", async () => {
  const originalFetch = global.fetch;
  let providerCalls = 0;
  let requestBody = null;
  let requestHeaders = null;
  global.fetch = async (_url, options) => {
    providerCalls += 1;
    requestBody = JSON.parse(options.body);
    requestHeaders = options.headers;
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "unknown-1",
                  type: "function",
                  function: { name: "not_a_real_tool", arguments: "{}" },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 1_000, completion_tokens: 100, total_tokens: 1_100 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const { service, events } = makeRunService({ quotaSequence: [100_000, 0] });
  try {
    await runAgentConversation(service, {
      message: "Make a small edit and compile it.",
      context: { uiLocale: "ja" },
      conversationId: "ai-mode:test",
      forcePlatformAxiom: true,
    });
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(providerCalls, 1);
  assert.ok(Number.isInteger(requestBody.max_completion_tokens));
  assert.ok(requestBody.max_completion_tokens > 0);
  assert.equal(requestHeaders["X-Tex64-Turn-Remaining-Tokens"], "100000");
  assert.match(
    events.find((event) => event.channel === "agent:message")?.payload?.text ?? "",
    /トークン上限/,
  );
});

test("official proxy quota delta enforces the cost-normalized per-turn ceiling", async () => {
  const originalFetch = global.fetch;
  let providerCalls = 0;
  global.fetch = async () => {
    providerCalls += 1;
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "costly-output",
                  type: "function",
                  function: { name: "not_a_real_tool", arguments: "{}" },
                },
              ],
            },
          },
        ],
        // Raw provider tokens alone would leave almost the full 100k turn
        // budget. The fresh server quota below simulates those tokens costing
        // 100k user-visible quota units (for example, higher-priced output).
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const { service, events } = makeRunService({
    quotaSequence: [1_000_000, 900_000],
  });
  try {
    await runAgentConversation(service, {
      message: "Try a costly tool step.",
      context: { uiLocale: "ja" },
      conversationId: "ai-mode:cost-normalized-budget",
      forcePlatformAxiom: true,
    });
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(providerCalls, 1);
  assert.match(
    events.find((event) => event.channel === "agent:message")?.payload?.text ?? "",
    /このターンの処理上限/,
  );
});

test("missing provider usage fails closed before another paid tool-loop call", async () => {
  const originalFetch = global.fetch;
  let providerCalls = 0;
  global.fetch = async () => {
    providerCalls += 1;
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "unknown-no-usage",
                  type: "function",
                  function: { name: "not_a_real_tool", arguments: "{}" },
                },
              ],
            },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const { service, events } = makeRunService({
    quotaSequence: Array(5).fill(1_000_000),
  });
  try {
    await runAgentConversation(service, {
      message: "Try a tool.",
      context: { uiLocale: "ja" },
      conversationId: "ai-mode:no-usage",
      forcePlatformAxiom: true,
    });
  } finally {
    global.fetch = originalFetch;
  }
  assert.equal(providerCalls, 1);
  assert.match(
    events.find((event) => event.channel === "agent:message")?.payload?.text ?? "",
    /このターンの処理上限/,
  );
});

test("a stale 500-iteration setting still produces at most 24 paid calls", async () => {
  const originalFetch = global.fetch;
  let providerCalls = 0;
  global.fetch = async () => {
    providerCalls += 1;
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: `unknown-${providerCalls}`,
                  type: "function",
                  function: { name: `unknown_tool_${providerCalls}`, arguments: "{}" },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const { service, events } = makeRunService({
    quotaSequence: Array(30).fill(1_000_000),
    maxIterations: 500,
  });
  try {
    await runAgentConversation(service, {
      message: "Keep trying forever.",
      context: { uiLocale: "ja" },
      conversationId: "ai-mode:max-loop",
      forcePlatformAxiom: true,
    });
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(providerCalls, HARD_MAX_AGENT_ITERATIONS);
  assert.match(
    events.find((event) => event.channel === "agent:message")?.payload?.text ?? "",
    /処理の上限（24回）/,
  );
  assert.equal(MAX_AGENT_TOKENS_PER_RUN, 100_000);
});
