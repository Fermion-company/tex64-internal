import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { simulateReadableStream } from "ai/test";
import type { LanguageModelV2StreamPart } from "@ai-sdk/provider";

import { SAMPLE_DOCUMENT } from "@/domain/document";
import { runDocumentTurn, type TurnFrame } from "@/server/agent/turn";
import type { DocumentRepository } from "@/server/persistence";
import { LocalDocumentRepository } from "@/server/persistence/local-repository";

const USER_ID = "90000000-0000-4000-8000-000000000001";
const TURN_ONE = "90000000-0000-4000-8000-000000000002";
const TURN_TWO = "90000000-0000-4000-8000-000000000003";

type ModelCall = { prompt: { role: string; content: unknown }[] };

type RepositoryGlobal = typeof globalThis & {
  __tex64DocumentRepository?: DocumentRepository;
  AI_SDK_DEFAULT_PROVIDER?: unknown;
};

let temporaryDirectory: string;
let repository: LocalDocumentRepository;
let calls: ModelCall[];

/**
 * A model that answers in words and calls no tools. Hand-rolled rather than
 * the SDK's mock classes so the test does not depend on which provider
 * specification version the installed SDK negotiates.
 */
function answeringModel(text: string) {
  return {
    specificationVersion: "v2" as const,
    provider: "mock-provider",
    modelId: "mock-model",
    supportedUrls: {},
    doGenerate: () => {
      throw new Error("The conversation turn only streams.");
    },
    doStream: (options: ModelCall) => {
      calls.push(options);
      return Promise.resolve({
        stream: simulateReadableStream<LanguageModelV2StreamPart>({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "0" },
            { type: "text-delta", id: "0", delta: text },
            { type: "text-end", id: "0" },
            {
              type: "finish",
              finishReason: "stop",
              usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
            },
          ],
        }),
      });
    },
  };
}

function installModel(model: ReturnType<typeof answeringModel>): void {
  // Only languageModel() is reached by a turn; the rest of the provider
  // surface is deliberately absent.
  (globalThis as RepositoryGlobal).AI_SDK_DEFAULT_PROVIDER = {
    languageModel: () => model,
  } as unknown as RepositoryGlobal["AI_SDK_DEFAULT_PROVIDER"];
}

async function collect(turnId: string, prompt: string): Promise<TurnFrame[]> {
  const frames: TurnFrame[] = [];
  for await (const frame of runDocumentTurn({
    userId: USER_ID,
    documentId: SAMPLE_DOCUMENT.id,
    turnId,
    prompt,
    targetNodeId: null,
    abortSignal: new AbortController().signal,
  })) {
    frames.push(frame);
  }
  return frames;
}

beforeEach(async () => {
  calls = [];
  process.env.AI_GATEWAY_API_KEY = "test-gateway-key";
  process.env.TEX64_AI_MODEL = "openai/test-model";
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "tex64-turn-"));
  repository = new LocalDocumentRepository(
    path.join(temporaryDirectory, "store.json"),
  );
  (globalThis as RepositoryGlobal).__tex64DocumentRepository = repository;
  await repository.createDocument(USER_ID, structuredClone(SAMPLE_DOCUMENT));
});

afterEach(async () => {
  delete (globalThis as RepositoryGlobal).__tex64DocumentRepository;
  delete (globalThis as RepositoryGlobal).AI_SDK_DEFAULT_PROVIDER;
  delete process.env.AI_GATEWAY_API_KEY;
  delete process.env.TEX64_AI_MODEL;
  await rm(temporaryDirectory, { recursive: true, force: true });
});

describe("conversation turn", () => {
  it("answers a question without touching the document", async () => {
    installModel(answeringModel("その式は正しいです。"));
    await repository.createRun({
      id: TURN_ONE,
      userId: USER_ID,
      documentId: SAMPLE_DOCUMENT.id,
      prompt: "この式は合っていますか？",
      idempotencyKey: TURN_ONE,
      baseRevision: 1,
    });

    const frames = await collect(TURN_ONE, "この式は合っていますか？");

    expect(frames).toContainEqual({ type: "done", status: "completed" });
    expect(frames.filter((frame) => frame.type === "text")).toEqual([
      { type: "text", delta: "その式は正しいです。" },
    ]);
    // No edit, no revision, and no typesetting: answering is a normal outcome.
    expect(frames.some((frame) => frame.type === "revision")).toBe(false);
    expect(frames.some((frame) => frame.type === "compiled")).toBe(false);
    const document = await repository.getDocument(USER_ID, SAMPLE_DOCUMENT.id);
    expect(document?.currentRevision).toBe(1);
    await expect(
      repository.getRun(USER_ID, TURN_ONE),
    ).resolves.toMatchObject({ status: "completed", stage: "ready" });
  });

  it("replays the whole thread to the model on the next turn", async () => {
    installModel(answeringModel("はい。"));
    for (const [turnId, prompt] of [
      [TURN_ONE, "序論の方針を相談させて"],
      [TURN_TWO, "さっきの方針で続けて"],
    ] as const) {
      await repository.createRun({
        id: turnId,
        userId: USER_ID,
        documentId: SAMPLE_DOCUMENT.id,
        prompt,
        idempotencyKey: turnId,
        baseRevision: 1,
      });
      await collect(turnId, prompt);
    }

    const secondCall = calls.at(-1);
    const roles = secondCall?.prompt.map((message) => message.role);
    expect(roles).toEqual(["system", "user", "assistant", "user"]);
    expect(JSON.stringify(secondCall?.prompt)).toContain("序論の方針を相談させて");
    expect(JSON.stringify(secondCall?.prompt)).toContain("はい。");

    const stored = await repository.listConversationMessages(
      USER_ID,
      SAMPLE_DOCUMENT.id,
    );
    expect(stored.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
  });
});
