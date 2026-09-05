"use client";

import {
  getNativeHost,
  hostMessageBody,
  requestFromHost,
  type HostMessage,
} from "./native-host";
import { attachmentKindOf, splitAttachmentBlock } from "./attachments";
import type { AgentProposal, AgentQuestion, ChatMessage, MessagePart, TurnFrame } from "./types";

/** The AI mode's own threads on the desktop agent, separate from Code mode's. */
export const AI_MODE_CONVERSATION_ID = "tex64-ai-mode";

function normalizeMainFile(mainFile: string): string {
  return mainFile.replaceAll("\\", "/").replace(/^\.\//, "");
}

/** A thread belongs to both the workspace and the document. */
export function conversationIdFor(workspaceId: string, mainFile: string): string {
  const workspace = encodeURIComponent(workspaceId || "workspace");
  const document = encodeURIComponent(normalizeMainFile(mainFile) || "main.tex");
  return `${AI_MODE_CONVERSATION_ID}:${workspace}:${document}`;
}

/**
 * Conversation history survives reopening a workspace, but an in-flight turn
 * does not: generation makes the live UI session stricter than the persisted
 * conversation id while keeping the transcript stable.
 */
export function nativeThreadSessionKey(
  workspaceId: string,
  workspaceGeneration: number,
  mainFile: string | null | undefined,
): string | null {
  const documentMainFile = typeof mainFile === "string" ? normalizeMainFile(mainFile) : "";
  if (!workspaceId || !documentMainFile || !Number.isSafeInteger(workspaceGeneration)) {
    return null;
  }
  return `${conversationIdFor(workspaceId, documentMainFile)}:generation:${workspaceGeneration}`;
}

export type NativeConversationRestoreMode = "idle" | "active" | "reattach";

/** Never mistake this component's live turn for an orphan found in history. */
export function nativeConversationRestoreMode(
  running: boolean,
  sessionKey: string,
  activeSessionKey: string | null,
): NativeConversationRestoreMode {
  // The state reply can have been captured immediately before a new local run
  // started. Local ownership therefore wins even when that stale reply says
  // `idle`.
  if (activeSessionKey === sessionKey) return "active";
  return running ? "reattach" : "idle";
}

type AbortControllerLike = { abort: () => void };

/** Shared stop button policy for native, reattached, and hosted turns. */
export function stopWorkspaceTurn(input: {
  activeNativeController: AbortControllerLike | null;
  attachedConversationId: string | null;
  fallbackController: AbortControllerLike | null;
  abortAttached: (conversationId: string) => void;
}): "native" | "attached" | "fallback" | "idle" {
  if (input.activeNativeController) {
    input.activeNativeController.abort();
    return "native";
  }
  if (input.attachedConversationId) {
    input.abortAttached(input.attachedConversationId);
    return "attached";
  }
  if (input.fallbackController) {
    input.fallbackController.abort();
    return "fallback";
  }
  return "idle";
}

/**
 * A reattached run has no local AbortController. Keep its UI blocked until the
 * host acknowledges abort, but recover if that acknowledgement is lost.
 */
export function scheduleAttachedAbortFallback(
  conversationId: string,
  isStillAttached: (conversationId: string) => boolean,
  onTimeout: () => void,
  timeoutMs = 10_000,
): () => void {
  const timer = setTimeout(() => {
    if (isStillAttached(conversationId)) onTimeout();
  }, timeoutMs);
  return () => clearTimeout(timer);
}

type AgentEventBody = {
  conversationId?: unknown;
  text?: unknown;
  proposals?: unknown;
  question?: unknown;
  name?: unknown;
  label?: unknown;
  summary?: unknown;
  state?: unknown;
  message?: unknown;
};

export type NativeTurnResult = {
  status: "completed" | "aborted" | "failed";
  /** The persisted final message, preferred over assembled stream deltas. */
  finalText: string;
  /** Next steps the agent recorded with its final message, if any. */
  proposals: AgentProposal[] | null;
  /** The agent stopped to ask this instead of finishing. */
  question: AgentQuestion | null;
};

/** A question as the host sends it; malformed parts are dropped. */
export function parseQuestion(value: unknown): AgentQuestion | null {
  if (typeof value === "string") {
    const question = value.trim();
    return question ? { question } : null;
  }
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const question = typeof item.question === "string" ? item.question.trim() : "";
  if (!question) return null;
  const fields = Array.isArray(item.fields)
    ? item.fields
        .map((entry) => {
          if (!entry || typeof entry !== "object") return null;
          const field = entry as Record<string, unknown>;
          const key = typeof field.key === "string" ? field.key.trim() : "";
          const label = typeof field.label === "string" ? field.label.trim() : "";
          if (!key || !label) return null;
          const placeholder =
            typeof field.placeholder === "string" ? field.placeholder.trim() : "";
          return { key, label, ...(placeholder ? { placeholder } : {}) };
        })
        .filter((field): field is { key: string; label: string; placeholder?: string } => field !== null)
    : [];
  const options = Array.isArray(item.options)
    ? item.options.filter((option): option is string => typeof option === "string" && option.trim() !== "")
    : [];
  return {
    question,
    ...(fields.length > 0 ? { fields } : {}),
    ...(options.length > 0 ? { options } : {}),
  };
}

/** Structured next steps as the host sends them; anything malformed is dropped. */
export function parseProposals(value: unknown): AgentProposal[] | null {
  if (!Array.isArray(value)) return null;
  const proposals: AgentProposal[] = [];
  value.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") return;
    const item = entry as Record<string, unknown>;
    const title = typeof item.title === "string" ? item.title.trim() : "";
    const request = typeof item.request === "string" ? item.request.trim() : "";
    if (!title || !request) return;
    const scope = typeof item.scope === "string" ? item.scope.trim() : "";
    const asks = parseQuestion(item.asks);
    const line = typeof item.line === "number" && Number.isInteger(item.line) && item.line > 0 ? item.line : null;
    proposals.push({
      id: typeof item.id === "string" && item.id ? item.id : `p${index + 1}`,
      title,
      request,
      ...(scope ? { scope } : {}),
      ...(asks ? { asks } : {}),
      ...(line ? { line } : {}),
    });
  });
  return proposals.length > 0 ? proposals : null;
}

export type NativeTerminalState = "idle" | "error" | "resumable";

/** A resumable host state is a failure when an agent:error preceded it. */
export function nativeTerminalFailed(
  state: NativeTerminalState,
  failurePending: boolean,
): boolean {
  return state === "error" || failurePending;
}

export type NativeTurnInput = {
  prompt: string;
  onFrame: (frame: TurnFrame) => void;
  signal: AbortSignal;
  conversationId: string;
  /** "survey": the app opened the document and asks where to start (read-only).
   *  "step": the user picked an offered step; the agent gathers the brief before writing. */
  origin?: "survey" | "step";
  /** With "step": a writing step withholds the edit tools on its first turn. */
  stepKind?: "mechanical" | "writing";
  /** Attached files as message parts: text extracts and inline images. */
  parts?: MessagePart[];
  activeFilePath?: string;
  workspaceRoot: string;
  workspaceId: string;
  workspaceGeneration: number;
  documentMainFile: string;
};

export function buildNativeAgentRunPayload(input: NativeTurnInput) {
  const documentMainFile = normalizeMainFile(input.documentMainFile);
  return {
    message: input.prompt,
    ...(input.parts && input.parts.length > 0 ? { parts: input.parts } : {}),
    conversationId: input.conversationId,
    workspaceId: input.workspaceId,
    workspaceGeneration: input.workspaceGeneration,
    documentMainFile,
    context: {
      ...(input.activeFilePath ? { activeFilePath: input.activeFilePath } : {}),
      ...(input.origin ? { turnOrigin: input.origin } : {}),
      ...(input.origin === "step" && input.stepKind ? { stepKind: input.stepKind } : {}),
      workspaceRoot: input.workspaceRoot,
      workspaceId: input.workspaceId,
      workspaceGeneration: input.workspaceGeneration,
      documentMainFile,
    },
  };
}

/**
 * Translates desktop-agent events into the frames the chat renders. Abort
 * waits for a host terminal event before another prompt may start.
 */
export function runNativeTurn(input: NativeTurnInput): Promise<NativeTurnResult> {
  const host = getNativeHost();
  if (!host) return Promise.reject(new Error("No desktop host is available."));
  const conversationId = input.conversationId;
  const FIRST_EVENT_TIMEOUT_MS = 30_000;
  const ABORT_ACK_TIMEOUT_MS = 10_000;
  const ERROR_TERMINAL_GRACE_MS = 1_000;

  return new Promise<NativeTurnResult>((resolve) => {
    let settled = false;
    let heard = false;
    let abortRequested = input.signal.aborted;
    let streamedText = "";
    let canonicalText = "";
    let proposals: AgentProposal[] | null = null;
    let question: AgentQuestion | null = null;
    let abortTimer: ReturnType<typeof setTimeout> | null = null;
    let errorTimer: ReturnType<typeof setTimeout> | null = null;
    let failurePending = false;

    const finish = (status: NativeTurnResult["status"]) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      clearTimeout(silenceTimer);
      if (abortTimer !== null) clearTimeout(abortTimer);
      if (errorTimer !== null) clearTimeout(errorTimer);
      input.signal.removeEventListener("abort", onAbort);
      input.onFrame({ type: "done", status });
      resolve({ status, finalText: canonicalText || streamedText, proposals, question });
    };

    const onAbort = () => {
      if (settled || abortRequested) return;
      abortRequested = true;
      host.send("agent:abort", { conversationId });
      abortTimer = setTimeout(() => finish("aborted"), ABORT_ACK_TIMEOUT_MS);
    };

    const silenceTimer = setTimeout(() => {
      if (heard || settled) return;
      failurePending = true;
      host.send("agent:abort", { conversationId });
      input.onFrame({
        type: "error",
        message: "デスクトップ側の応答がありません。AI の設定とログイン状態を確認してください。",
      });
      abortTimer = setTimeout(() => finish("failed"), ABORT_ACK_TIMEOUT_MS);
    }, FIRST_EVENT_TIMEOUT_MS);

    const unsubscribe = host.onMessage((raw: HostMessage) => {
      const body = hostMessageBody(raw) as AgentEventBody;
      if (
        raw.type !== "agent:messageDelta" &&
        raw.type !== "agent:message" &&
        raw.type !== "agent:tool" &&
        raw.type !== "agent:error" &&
        raw.type !== "agent:status"
      ) {
        return;
      }
      // Every turn event must name its thread. Accepting an unscoped model or
      // Code-mode event here can both finish the wrong turn and suppress the
      // no-response timeout.
      if (body.conversationId !== conversationId) return;
      heard = true;
      switch (raw.type) {
        case "agent:messageDelta":
          if (typeof body.text === "string" && body.text) {
            streamedText += body.text;
            input.onFrame({ type: "text", delta: body.text });
          }
          break;
        case "agent:message":
          if (typeof body.text === "string") canonicalText = body.text;
          proposals = parseProposals(body.proposals);
          question = parseQuestion(body.question);
          break;
        case "agent:tool": {
          if (typeof body.name !== "string") break;
          const summary = typeof body.summary === "string" ? body.summary : "";
          const failed = /(?:error|failed|失敗)/i.test(summary);
          input.onFrame({
            type: "tool",
            name: body.name,
            state: summary === "running" ? "start" : failed ? "error" : "ok",
          });
          break;
        }
        case "agent:error":
          failurePending = true;
          input.onFrame({
            type: "error",
            message:
              typeof body.message === "string" && body.message
                ? body.message
                : "処理が最後まで進みませんでした。もう一度お試しください。",
          });
          // A fatal backend error normally has a following status event. Give
          // it a brief chance to arrive; if it does not, abort and wait for an
          // idle acknowledgement before allowing another prompt to start.
          if (errorTimer === null) {
            errorTimer = setTimeout(() => {
              host.send("agent:abort", { conversationId });
              abortTimer = setTimeout(
                () => finish(abortRequested ? "aborted" : "failed"),
                ABORT_ACK_TIMEOUT_MS,
              );
            }, ERROR_TERMINAL_GRACE_MS);
          }
          break;
        case "agent:status":
          if (body.state === "stopping") {
            abortRequested = true;
            if (abortTimer !== null) clearTimeout(abortTimer);
            abortTimer = null;
          } else if (body.state === "idle" || body.state === "resumable") {
            finish(
              nativeTerminalFailed(body.state, failurePending)
                ? "failed"
                : abortRequested
                  ? "aborted"
                  : "completed",
            );
          } else if (body.state === "error") {
            finish(abortRequested ? "aborted" : "failed");
          }
          break;
        default:
          break;
      }
    });

    input.signal.addEventListener("abort", onAbort);
    if (abortRequested) {
      host.send("agent:abort", { conversationId });
      abortTimer = setTimeout(() => finish("aborted"), ABORT_ACK_TIMEOUT_MS);
      return;
    }
    host.send("agent:run", buildNativeAgentRunPayload(input));
  });
}

type PersistedAgentMessage = {
  role?: unknown;
  content?: unknown;
  text?: unknown;
  createdAt?: unknown;
  hidden?: unknown;
  proposals?: unknown;
  question?: unknown;
};

export type NativeConversationState = {
  messages: ChatMessage[];
  undoCount: number;
  undoUnavailableReason: string | null;
  running: boolean;
  stopping: boolean;
};

function parseMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) return [];
  const messages: ChatMessage[] = [];
  value.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") return;
    const item = entry as PersistedAgentMessage;
    if (item.role !== "user" && item.role !== "assistant") return;
    // The opening read is the app's question, not the user's.
    if (item.hidden === true) return;
    const text =
      typeof item.content === "string"
        ? item.content
        : typeof item.text === "string"
          ? item.text
          : "";
    if (!text) return;
    const proposals = item.role === "assistant" ? parseProposals(item.proposals) : null;
    const question = item.role === "assistant" ? parseQuestion(item.question) : null;
    // A user turn that carried files keeps their extracted contents for the
    // model; the chat shows the message and the file names, not the dump.
    const shown = item.role === "user" ? splitAttachmentBlock(text) : null;
    const attachments =
      shown && shown.names.length > 0
        ? shown.names.map((name) => ({
            name,
            kind: attachmentKindOf(new File([], name)) ?? ("file" as const),
          }))
        : null;
    messages.push({
      id: `native-${index}-${text.length}`,
      role: item.role,
      text: shown && (shown.body || attachments) ? shown.body : text,
      createdAt:
        typeof item.createdAt === "string"
          ? item.createdAt
          : new Date(0).toISOString(),
      ...(attachments ? { attachments } : {}),
      ...(proposals ? { proposals } : {}),
      ...(question ? { question } : {}),
    });
  });
  return messages;
}

/** Restores a persisted desktop-agent transcript and undo availability. */
export async function loadNativeConversation(
  conversationId: string,
): Promise<NativeConversationState> {
  const host = getNativeHost();
  if (!host) {
    return {
      messages: [],
      undoCount: 0,
      undoUnavailableReason: null,
      running: false,
      stopping: false,
    };
  }
  const answer = await requestFromHost(host, {
    type: "agent:state:get",
    resultType: "agent:state",
    payload: { conversationId },
    timeoutMs: 8_000,
  });
  const sessions = Array.isArray(answer.sessions) ? answer.sessions : [];
  const session = sessions.find((entry) => {
    if (!entry || typeof entry !== "object") return false;
    return (entry as Record<string, unknown>).conversationId === conversationId;
  }) as Record<string, unknown> | undefined;
  const status = session?.status;
  const undo =
    session?.undoAvailability ??
    (status && typeof status === "object" ? status : null);
  const statusState =
    status && typeof status === "object"
      ? (status as Record<string, unknown>).state
      : null;
  return {
    messages: parseMessages(session?.messages),
    undoCount: (() => {
      if (!undo || typeof undo !== "object") return 0;
      const values = undo as Record<string, unknown>;
      const count =
        typeof values.count === "number" ? values.count : values.undoCount;
      return typeof count === "number" && Number.isFinite(count)
        ? Math.max(0, Math.trunc(count))
        : 0;
    })(),
    undoUnavailableReason:
      status &&
      typeof status === "object" &&
      typeof (status as Record<string, unknown>).undoUnavailableReason === "string"
        ? ((status as Record<string, unknown>).undoUnavailableReason as string)
        : null,
    running: statusState === "running" || statusState === "stopping",
    stopping: statusState === "stopping",
  };
}

/** Requests one document-scoped undo and waits for the correlated result. */
export async function undoNativeConversation(
  conversationId: string,
  signal?: AbortSignal,
): Promise<{ ok: boolean; aborted?: boolean; error?: string }> {
  const host = getNativeHost();
  if (!host) return { ok: false, error: "デスクトップ側に接続できません。" };
  if (signal?.aborted) return { ok: false, aborted: true };
  const answer = await requestFromHost(host, {
    type: "agent:undoLastRunApply",
    resultType: "agent:undoResult",
    payload: { conversationId },
    // A real TeX build can legitimately exceed three minutes. Completion is
    // correlated by request id; cancellation below supplies the bounded exit.
    timeoutMs: null,
    ...(signal
      ? {
          abort: {
            signal,
            onAbort: () =>
              host.send("agent:abort", {
                conversationId,
                reason: "user-stop-undo",
              }),
            isAcknowledgement: (message: HostMessage) => {
              if (message.type !== "agent:status") return false;
              const body = hostMessageBody(message);
              return (
                body.conversationId === conversationId &&
                (body.state === "stopping" ||
                  body.state === "idle" ||
                  body.state === "error" ||
                  body.state === "resumable")
              );
            },
          },
        }
      : {}),
  });
  return {
    ok: answer.ok === true,
    ...(signal?.aborted ? { aborted: true } : {}),
    ...(typeof answer.error === "string" ? { error: answer.error } : {}),
  };
}
