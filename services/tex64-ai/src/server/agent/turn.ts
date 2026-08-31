import { isStepCount, streamText, type ModelMessage } from "ai";

import { artifactReleaseBinding } from "@/server/artifacts";
import { compileDocumentRevision } from "@/server/compiler/compile-document-revision";
import {
  DocumentNotFoundError,
  getDocumentRepository,
  type StoredConversationMessage,
} from "@/server/persistence";
import { normalizeUserFacingResultNote } from "@/lib/user-facing-copy";

import { createDocumentTools } from "./document-tools";
import { createDocumentAgentInstructions } from "./instructions";
import {
  agentLanguageModel,
  agentProviderOptions,
  usesDirectOpenAiTransport,
} from "./language-model";
import { resolveAgentRuntimeFromProcessEnvironment } from "./runtime";
import {
  MAX_AGENT_OUTPUT_TOKENS_PER_STEP,
  MAX_AGENT_TOTAL_TOKENS_PER_RUN,
  isAgentTokenBudget,
  summarizeAgentTokenUsage,
} from "./token-budget";
import type { ToolScope } from "./tool-handlers";

/** Tool calls one turn may make before it has to answer the user. */
export const MAX_TURN_STEPS = 24;

/**
 * search_sources is an AI Gateway provider tool (Perplexity executes inside
 * the gateway); without gateway credentials a call would fail, so the tool
 * disappears from the active set instead.
 */
const ALL_TOOLS = [
  "read_document",
  "search_sources",
  "resolve_source",
  "apply_document_patch",
  "format_document",
  "check_document",
  "compile_document",
] as const;

function activeToolNames(): (typeof ALL_TOOLS)[number][] {
  return usesDirectOpenAiTransport()
    ? ALL_TOOLS.filter((name) => name !== "search_sources")
    : [...ALL_TOOLS];
}

const NO_SEARCH_RULE =
  "この環境ではsearch_sourcesは使えません。出典が必要なときは、あなたが確実に知っているarXivのURLかDOIを自分で挙げ、resolve_sourceで確認します。確認できた出典だけを引用し、候補を挙げられないときは出典なしで進めてよいかユーザーに聞いてください。";

/** What the client renders while a turn runs. */
export type TurnFrame =
  | { type: "text"; delta: string }
  | { type: "tool"; name: string; state: "start" | "ok" | "error" }
  | { type: "revision"; revision: number }
  | { type: "compiled"; revision: number; pageCount: number }
  | { type: "error"; message: string }
  | { type: "done"; status: "completed" | "aborted" | "failed" };

export type RunDocumentTurnInput = {
  userId: string;
  documentId: string;
  turnId: string;
  prompt: string;
  targetNodeId: string | null;
  abortSignal: AbortSignal;
};

/**
 * How much of the thread one turn replays. Message count alone is a poor
 * bound: a single tool result can carry the whole document, and every step of
 * the turn resends the lot. Oldest messages fall off first.
 */
const MAX_REPLAYED_THREAD_CHARS = 48_000;

/** Placeholder left in place of a document snapshot that a later read replaced. */
const SUPERSEDED_DOCUMENT_SNAPSHOT =
  "（この時点の文書内容。以降の read_document がより新しい内容を返しています）";

type ContentPart = { type?: unknown; toolName?: unknown };

function contentParts(content: unknown): ContentPart[] | null {
  return Array.isArray(content) ? (content as ContentPart[]) : null;
}

/**
 * Reasoning is a within-response artifact: replaying it on later turns costs
 * real tokens (measured at half of this thread) and tells the model nothing
 * its own messages and tool results do not already say.
 *
 * Dropping it means the provider item identity has to go with it. The
 * Responses API rejects a message item whose sibling reasoning item is
 * missing ("was provided without its required 'reasoning' item"), so the
 * replayed parts are sent as plain content with no item ids attached.
 */
function withoutReasoning(content: unknown): unknown {
  const parts = contentParts(content);
  if (!parts) return content;
  return parts
    .filter((part) => part.type !== "reasoning")
    .map((part) => {
      if (!("providerOptions" in part)) return part;
      const rest: Record<string, unknown> = { ...part };
      delete rest.providerOptions;
      return rest;
    });
}

function isDocumentSnapshot(message: { role: string; content: unknown }): boolean {
  const parts = contentParts(message.content);
  return (
    message.role === "tool" &&
    parts !== null &&
    parts.some(
      (part) =>
        part.type === "tool-result" && part.toolName === "read_document",
    )
  );
}

/**
 * Only the newest document snapshot is worth replaying; the older ones are
 * stale by construction and, on a real manuscript, each one is the whole
 * document again.
 */
function collapseSupersededSnapshot(content: unknown): unknown {
  const parts = contentParts(content);
  if (!parts) return content;
  return parts.map((part) =>
    part.type === "tool-result" && part.toolName === "read_document"
      ? {
          ...part,
          output: { type: "text", value: SUPERSEDED_DOCUMENT_SNAPSHOT },
        }
      : part,
  );
}

function storedMessagesToModelMessages(
  stored: readonly StoredConversationMessage[],
): ModelMessage[] {
  const replayed: ModelMessage[] = [];
  let budget = MAX_REPLAYED_THREAD_CHARS;
  let keptSnapshot = false;
  for (let index = stored.length - 1; index >= 0; index -= 1) {
    const message = stored[index];
    if (!message) continue;
    let content = withoutReasoning(message.content);
    if (isDocumentSnapshot({ role: message.role, content })) {
      if (keptSnapshot) content = collapseSupersededSnapshot(content);
      keptSnapshot = true;
    }
    const parts = contentParts(content);
    if (parts && parts.length === 0) continue;
    const size = JSON.stringify(content ?? null).length;
    if (size > budget && replayed.length > 0) break;
    budget -= size;
    replayed.unshift({ role: message.role, content } as ModelMessage);
  }
  // A thread must not start with a dangling tool result whose call was
  // dropped; providers reject that.
  while (replayed[0]?.role === "tool") replayed.shift();
  return replayed;
}

/**
 * The authorization surface for source fetches is what the user themselves
 * wrote — never model output and never document text.
 */
function trustedPromptFromThread(
  stored: readonly StoredConversationMessage[],
  currentPrompt: string,
): string {
  const userText = stored
    .filter((message) => message.role === "user")
    .map((message) =>
      typeof message.content === "string" ? message.content : "",
    )
    .filter(Boolean);
  return [...userText, currentPrompt].join("\n");
}

function userMessageText(prompt: string, targetNodeId: string | null): string {
  if (!targetNodeId) return prompt;
  return `${prompt}\n\n（ユーザーはPDF上でこの要素を選択しています: nodeId=${targetNodeId}。依頼が他の箇所に明示的に触れない限り、変更はこの要素とその直接の文脈に限定してください。）`;
}

/**
 * One conversation turn: the user's message goes to the model with the whole
 * thread, the model works with its tools until it has an answer, and the
 * answer streams back. Nothing here decides in advance whether the document
 * should change — that is the model's call, and "answered without editing" is
 * an ordinary outcome.
 */
export async function* runDocumentTurn(
  input: RunDocumentTurnInput,
): AsyncGenerator<TurnFrame> {
  const repository = getDocumentRepository();
  const document = await repository.getDocument(input.userId, input.documentId);
  if (!document) throw new DocumentNotFoundError();
  const startingRevision = document.currentRevision;

  const thread = await repository.listConversationMessages(
    input.userId,
    input.documentId,
  );
  const promptText = userMessageText(input.prompt, input.targetNodeId);
  const scope: ToolScope = {
    userId: input.userId,
    documentId: input.documentId,
    turnId: input.turnId,
    trustedPrompt: trustedPromptFromThread(thread, input.prompt),
  };

  const runtime = resolveAgentRuntimeFromProcessEnvironment();
  const activeTools = activeToolNames();
  const result = streamText({
    model: agentLanguageModel(runtime.model),
    instructions: createDocumentAgentInstructions({
      additionalRules: activeTools.includes("search_sources")
        ? undefined
        : [NO_SEARCH_RULE],
    }),
    messages: [
      ...storedMessagesToModelMessages(thread),
      { role: "user", content: promptText },
    ],
    tools: createDocumentTools(scope),
    activeTools,
    providerOptions: agentProviderOptions(),
    maxOutputTokens: MAX_AGENT_OUTPUT_TOKENS_PER_STEP,
    // A failed paid request is ambiguous. Retrying it can purchase the same
    // generation twice, so the user explicitly retries the turn instead.
    maxRetries: 0,
    // Two independent runaway valves: a step count, and measured tokens for
    // the turn. Without the second one, 24 steps over a long thread can cost
    // far more than the step count suggests.
    stopWhen: [
      isStepCount(MAX_TURN_STEPS),
      isAgentTokenBudget(MAX_AGENT_TOTAL_TOKENS_PER_RUN),
    ],
    abortSignal: input.abortSignal,
    onFinish: ({ steps }) => {
      // Cost is invisible unless it is written down. Never user-facing.
      // The SDK's aggregate usage is unreliable across provider
      // specification versions; summing per-step usage ourselves is what the
      // budget valve reads, so log exactly that.
      const measured = summarizeAgentTokenUsage(
        steps,
        MAX_AGENT_TOTAL_TOKENS_PER_RUN,
      );
      console.info(
        `[tex64-ai] turn ${input.turnId} steps=${steps.length} ` +
          `tokens=${measured.measurable ? measured.totalTokens : "unmeasured"} ` +
          `step0=${JSON.stringify(steps[0]?.usage ?? null)}`,
      );
    },
  });

  // Accumulated across steps so an interrupted turn still persists what the
  // user already saw. prepareStep runs before every model call and carries the
  // messages produced by all previous steps.
  let responseMessages: ModelMessage[] = [];
  let pendingText = "";
  let lastAssistantText = "";
  let status: "completed" | "aborted" | "failed" = "completed";
  let failureMessage: string | null = null;

  try {
    for await (const part of result.fullStream) {
      switch (part.type) {
        case "text-delta":
          pendingText += part.text;
          yield { type: "text", delta: part.text };
          break;
        case "tool-call":
          yield { type: "tool", name: part.toolName, state: "start" };
          break;
        case "tool-result": {
          yield { type: "tool", name: part.toolName, state: "ok" };
          const output = part.output as Record<string, unknown> | undefined;
          if (
            (part.toolName === "apply_document_patch" ||
              part.toolName === "format_document") &&
            typeof output?.revision === "number"
          ) {
            yield { type: "revision", revision: output.revision };
          }
          if (
            part.toolName === "compile_document" &&
            output?.ok === true &&
            typeof output.revision === "number" &&
            typeof output.pageCount === "number"
          ) {
            yield {
              type: "compiled",
              revision: output.revision,
              pageCount: output.pageCount,
            };
          }
          break;
        }
        case "tool-error":
          // The model receives the error and repairs from it; the operator
          // needs it too, since tool failures never reach the user's chat.
          console.error(
            `[tex64-ai] tool ${part.toolName} failed:`,
            part.error instanceof Error ? part.error.message : part.error,
          );
          yield { type: "tool", name: part.toolName, state: "error" };
          break;
        case "finish-step":
          if (pendingText.trim()) lastAssistantText = pendingText;
          pendingText = "";
          break;
        case "abort":
          status = "aborted";
          break;
        case "error":
          status = "failed";
          failureMessage = describeStreamError(part.error);
          yield { type: "error", message: failureMessage };
          break;
        default:
          break;
      }
    }
    responseMessages = (await result.responseMessages) as ModelMessage[];
  } catch (error) {
    if (input.abortSignal.aborted) {
      status = "aborted";
    } else {
      status = "failed";
      failureMessage = describeStreamError(error);
      yield { type: "error", message: failureMessage };
    }
  }

  if (responseMessages.length === 0) {
    // The stream ended before the SDK could settle its accumulated messages
    // (an interrupt, or a failure mid-step). Keep whatever the user saw.
    responseMessages = pendingText.trim()
      ? [{ role: "assistant", content: pendingText }]
      : [];
  }
  if (pendingText.trim()) lastAssistantText = pendingText;

  await repository.appendConversationMessages({
    userId: input.userId,
    documentId: input.documentId,
    turnId: input.turnId,
    messages: [
      { role: "user", content: promptText },
      ...responseMessages
        .map((message) => ({
          role: message.role as StoredConversationMessage["role"],
          content: withoutReasoning(message.content),
        }))
        .filter((message) => {
          const parts = contentParts(message.content);
          return !parts || parts.length > 0;
        }),
    ],
  });

  const finalRevision = await ensurePublishedRevision({
    userId: input.userId,
    documentId: input.documentId,
    startingRevision,
  });
  if (finalRevision && finalRevision !== startingRevision) {
    yield { type: "revision", revision: finalRevision };
  }

  await finishRun({
    userId: input.userId,
    documentId: input.documentId,
    turnId: input.turnId,
    status,
    resultNote: normalizeUserFacingResultNote(lastAssistantText),
    failureMessage,
  });

  yield { type: "done", status };
}

function describeStreamError(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") {
    return "いったん止めました。";
  }
  return "処理が最後まで進みませんでした。もう一度お試しください。";
}

/**
 * The reader's page must never fall behind the document. The agent is told to
 * compile what it changed; this is the deterministic backstop for the turn
 * where it did not, and it never calls a model.
 */
async function ensurePublishedRevision(input: {
  userId: string;
  documentId: string;
  startingRevision: number;
}): Promise<number | null> {
  const repository = getDocumentRepository();
  const document = await repository.getDocument(input.userId, input.documentId);
  if (!document) return null;
  const revision = document.currentRevision;
  if (revision === input.startingRevision || revision < 1) return revision;
  if (document.document.root.length === 0) return revision;

  const artifact = await repository.getArtifact(
    input.userId,
    input.documentId,
    revision,
  );
  if (artifact) return revision;
  try {
    await compileDocumentRevision({
      userId: input.userId,
      documentId: input.documentId,
      revision,
    });
  } catch {
    // A failed backstop compile keeps the previous page; the conversation
    // already carries whatever the agent said about it.
  }
  return revision;
}

async function finishRun(input: {
  userId: string;
  documentId: string;
  turnId: string;
  status: "completed" | "aborted" | "failed";
  resultNote: string | null;
  failureMessage: string | null;
}): Promise<void> {
  const repository = getDocumentRepository();
  if (input.status !== "completed") {
    await repository.updateRun(input.userId, input.turnId, {
      status: input.status === "aborted" ? "cancelled" : "failed",
      stage: "failed",
      ...(input.failureMessage ? { errorMessage: input.failureMessage } : {}),
    });
    return;
  }

  const document = await repository.getDocument(input.userId, input.documentId);
  const revision = document?.currentRevision ?? 0;
  const artifact =
    revision > 0
      ? await repository.getArtifact(input.userId, input.documentId, revision)
      : null;
  if (!artifact) {
    await repository.updateRun(input.userId, input.turnId, {
      status: "completed",
      stage: "ready",
      resultNote: input.resultNote,
    });
    return;
  }

  // Binding the published PDF to the completed turn is what lets the preview
  // serve it as a released artifact rather than an owner-only draft.
  await repository.completeRunForCurrentRevision({
    userId: input.userId,
    documentId: input.documentId,
    runId: input.turnId,
    revision,
    artifact: artifactReleaseBinding(artifact),
    eventKey: `${input.turnId}:ready`,
    eventMessage: "できました",
    resultNote: input.resultNote,
  });
}
