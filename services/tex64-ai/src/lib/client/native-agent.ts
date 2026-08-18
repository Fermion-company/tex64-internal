"use client";

import { getNativeHost, hostMessageBody, type HostMessage } from "./native-host";
import type { TurnFrame } from "./types";

/** The AI mode's own thread on the desktop agent, separate from Code mode's. */
export const AI_MODE_CONVERSATION_ID = "tex64-ai-mode";

/**
 * The desktop bus nests every event's fields under `payload` — the same
 * shape Code mode's own dispatcher reads (electron/main.cjs's sendToRenderer
 * wraps every send as `{ type, payload }`).
 */
type AgentEventBody = {
  conversationId?: unknown;
  text?: unknown;
  name?: unknown;
  label?: unknown;
  summary?: unknown;
  state?: unknown;
  message?: unknown;
};

/**
 * Translates the desktop agent's events into the frames the chat already
 * renders. The agent edits the workspace's own .tex files, so a turn here is
 * the same kind of work Code mode does — the AI mode just shows the page
 * instead of the source.
 */
export function runNativeTurn(input: {
  prompt: string;
  onFrame: (frame: TurnFrame) => void;
  signal: AbortSignal;
}): Promise<void> {
  const host = getNativeHost();
  if (!host) return Promise.reject(new Error("No desktop host is available."));

  // A run the host refuses reports agent:error, but a host that answers
  // nothing at all would leave the composer spinning forever.
  const FIRST_EVENT_TIMEOUT_MS = 30_000;

  return new Promise<void>((resolve) => {
    let settled = false;
    let heard = false;
    const finish = (status: "completed" | "aborted" | "failed") => {
      if (settled) return;
      settled = true;
      unsubscribe();
      clearTimeout(silenceTimer);
      input.signal.removeEventListener("abort", onAbort);
      input.onFrame({ type: "done", status });
      resolve();
    };

    const onAbort = () => {
      host.send("agent:abort", { conversationId: AI_MODE_CONVERSATION_ID });
      finish("aborted");
    };

    const silenceTimer = setTimeout(() => {
      if (heard) return;
      input.onFrame({
        type: "error",
        message: "デスクトップ側の応答がありません。AI の設定とログイン状態を確認してください。",
      });
      finish("failed");
    }, FIRST_EVENT_TIMEOUT_MS);

    const unsubscribe = host.onMessage((raw: HostMessage) => {
      const body = hostMessageBody(raw) as AgentEventBody;
      if (
        typeof body.conversationId === "string" &&
        body.conversationId !== AI_MODE_CONVERSATION_ID
      ) {
        return;
      }
      if (raw.type.startsWith("agent:")) heard = true;
      switch (raw.type) {
        case "agent:messageDelta":
          if (typeof body.text === "string" && body.text) {
            input.onFrame({ type: "text", delta: body.text });
          }
          break;
        case "agent:tool": {
          if (typeof body.name !== "string") break;
          const summary = typeof body.summary === "string" ? body.summary : "";
          input.onFrame({
            type: "tool",
            name: typeof body.label === "string" && body.label ? body.label : body.name,
            state:
              summary === "running" ? "start" : summary === "ok" ? "ok" : "error",
          });
          break;
        }
        case "agent:error":
          input.onFrame({
            type: "error",
            message:
              typeof body.message === "string" && body.message
                ? body.message
                : "処理が最後まで進みませんでした。もう一度お試しください。",
          });
          finish("failed");
          break;
        case "agent:status":
          // The agent reports idle once the turn is finished, including the
          // turns that only answered.
          if (body.state === "idle") finish("completed");
          break;
        default:
          break;
      }
    });

    input.signal.addEventListener("abort", onAbort);
    host.send("agent:run", {
      message: input.prompt,
      conversationId: AI_MODE_CONVERSATION_ID,
      context: {},
    });
  });
}
