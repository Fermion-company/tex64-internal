import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AXIOM_PRO_MODEL,
  AXIOM_STANDARD_MODEL,
  maskAxiomResponseModel,
  resolveAxiomModel,
} from "../api/v2/_lib/ai-model-policy.js";
import {
  clearRuntimeConfigCache,
  getRuntimeConfig,
} from "../api/v2/_lib/runtime-config.js";
import { computeTokenLimitForPlan } from "../api/v2/_lib/subscription-domain.js";
import completionsHandler from "../api/v2/ai/openai/chat/completions.js";

const modelConfig = {
  axiomStandardModel: "provider/private-standard",
  axiomProModel: "provider/private-pro",
};

const withEnvironment = async (values, callback) => {
  const names = Object.keys(values);
  const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  clearRuntimeConfigCache();
  try {
    return await callback();
  } finally {
    for (const name of names) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
    clearRuntimeConfigCache();
  }
};

const createResponseRecorder = () => {
  const chunks = [];
  return {
    statusCode: 0,
    headers: {},
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode;
      for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
    },
    write(value) {
      chunks.push(Buffer.from(value));
    },
    end(value) {
      if (value !== undefined) chunks.push(Buffer.from(value));
      this.ended = true;
    },
    text() {
      return Buffer.concat(chunks).toString("utf8");
    },
  };
};

test("only public Axiom aliases resolve to server-owned provider models", () => {
  assert.deepEqual(
    resolveAxiomModel({
      requestedModel: AXIOM_STANDARD_MODEL,
      subscription: { plan: "free" },
      config: modelConfig,
    }),
    {
      publicModel: AXIOM_STANDARD_MODEL,
      upstreamModel: "provider/private-standard",
    }
  );
  assert.throws(
    () =>
      resolveAxiomModel({
        requestedModel: "provider/private-pro",
        subscription: { plan: "pro" },
        config: modelConfig,
      }),
    (error) =>
      error?.code === "MODEL_NOT_SUPPORTED" && error?.statusCode === 400
  );
});

test("Axiom Pro is rejected unless the subscription plan is Pro", () => {
  for (const plan of ["free", "basic", undefined]) {
    assert.throws(
      () =>
        resolveAxiomModel({
          requestedModel: AXIOM_PRO_MODEL,
          subscription: { plan },
          config: modelConfig,
        }),
      (error) =>
        error?.code === "MODEL_PLAN_REQUIRED" && error?.statusCode === 403
    );
  }
  assert.equal(
    resolveAxiomModel({
      requestedModel: AXIOM_PRO_MODEL,
      subscription: { plan: "pro" },
      config: modelConfig,
    }).upstreamModel,
    "provider/private-pro"
  );
});

test("provider model ids are masked from OpenAI-compatible responses", () => {
  assert.deepEqual(
    maskAxiomResponseModel(
      { id: "chatcmpl_1", model: "provider/private-pro", choices: [] },
      AXIOM_PRO_MODEL
    ),
    { id: "chatcmpl_1", model: AXIOM_PRO_MODEL, choices: [] }
  );
});

test("default visible quotas match the product token allowances", () => {
  const names = [
    "TEX64_PLATFORM_FREE_MONTHLY_TOKENS",
    "TEX64_LLM_AXIOM_100_UPSTREAM",
    "TEX64_LLM_AXIOM_100_PRO_UPSTREAM",
  ];
  const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) {
    delete process.env[name];
  }
  clearRuntimeConfigCache();
  try {
    const config = getRuntimeConfig();
    assert.equal(computeTokenLimitForPlan("free", config), 200_000);
    assert.equal(computeTokenLimitForPlan("basic", config), 800_000);
    assert.equal(computeTokenLimitForPlan("pro", config), 3_000_000);
  } finally {
    for (const name of names) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
    clearRuntimeConfigCache();
  }
});

test("chat proxy enforces the Pro gate before contacting the provider", async () => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-model-gate-"));
  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = async () => {
    providerCalls += 1;
    throw new Error("provider must not be called");
  };
  try {
    await withEnvironment(
      {
        NODE_ENV: "development",
        TEX64_PLATFORM_ALLOW_DEV_AUTH: "true",
        TEX64_PLATFORM_STATE_FALLBACK: "true",
        TEX64_PLATFORM_STATE_FILE: path.join(temporaryDirectory, "state.json"),
        TEX64_PLATFORM_DEFAULT_PLAN: "basic",
        OPENAI_API_KEY: "test-only-key",
        TEX64_LLM_AXIOM_100_PRO_UPSTREAM: "provider/private-pro",
      },
      async () => {
        const response = createResponseRecorder();
        await completionsHandler(
          {
            method: "POST",
            headers: { "x-tex64-dev-user": "basic@example.test" },
            body: {
              model: AXIOM_PRO_MODEL,
              messages: [{ role: "user", content: "hello" }],
            },
          },
          response
        );
        assert.equal(response.statusCode, 403);
        assert.equal(JSON.parse(response.text()).error.code, "MODEL_PLAN_REQUIRED");
        assert.equal(providerCalls, 0);
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("chat proxy substitutes and masks the provider model in an SSE stream", async () => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-model-stream-"));
  const originalFetch = globalThis.fetch;
  let providerBody = null;
  globalThis.fetch = async (_url, options) => {
    providerBody = JSON.parse(options.body);
    return new Response(
      [
        'data: {"id":"chatcmpl_1","model":"provider/private-standard","choices":[{"delta":{"content":"ok"}}]}',
        "",
        'data: {"id":"chatcmpl_1","model":"provider/private-standard","choices":[],"usage":{"prompt_tokens":2,"completion_tokens":1}}',
        "",
        "data: [DONE]",
        "",
      ].join("\n"),
      { status: 200, headers: { "content-type": "text/event-stream" } }
    );
  };
  try {
    await withEnvironment(
      {
        NODE_ENV: "development",
        TEX64_PLATFORM_ALLOW_DEV_AUTH: "true",
        TEX64_PLATFORM_STATE_FALLBACK: "true",
        TEX64_PLATFORM_STATE_FILE: path.join(temporaryDirectory, "state.json"),
        TEX64_PLATFORM_DEFAULT_PLAN: "basic",
        OPENAI_API_KEY: "test-only-key",
        TEX64_LLM_AXIOM_100_UPSTREAM: "provider/private-standard",
      },
      async () => {
        const response = createResponseRecorder();
        await completionsHandler(
          {
            method: "POST",
            headers: {
              "x-tex64-dev-user": "basic@example.test",
              "x-tex64-turn-remaining-tokens": "500",
            },
            body: {
              model: AXIOM_STANDARD_MODEL,
              messages: [{ role: "user", content: "hello" }],
              stream: true,
              stream_options: { include_usage: true },
            },
          },
          response
        );
        assert.equal(response.statusCode, 200);
        assert.equal(providerBody.model, "provider/private-standard");
        assert.ok(providerBody.max_completion_tokens < 32_000);
        assert.equal(response.text().includes("provider/private-standard"), false);
        assert.match(response.text(), /"model":"Axiom1\.0"/);
        assert.match(response.text(), /data: \[DONE\]/);
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
});
