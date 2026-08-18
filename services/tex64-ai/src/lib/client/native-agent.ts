"use client";

import { getNativeHost, type HostMessage } from "./native-host";
import type { TurnFrame } from "./types";

/** The AI mode's own thread on the desktop agent, separate from Code mode's. */
export const AI_MODE_CONVERSATION_ID = "tex64-ai-mode";

type AgentEvent = HostMessage & {
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

  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = (status: "completed" | "aborted" | "failed") => {
      if (settled) return;
      settled = true;
      unsubscribe();
      input.signal.removeEventListener("abort", onAbort);
      input.onFrame({ type: "done", status });
      resolve();
    };

    const onAbort = () => {
      host.send("agent:abort", { conversationId: AI_MODE_CONVERSATION_ID });
      finish("aborted");
    };

    const unsubscribe = host.onMessage((raw: AgentEvent) => {
      if (
        typeof raw.conversationId === "string" &&
        raw.conversationId !== AI_MODE_CONVERSATION_ID
      ) {
        return;
      }
      switch (raw.type) {
        case "agent:messageDelta":
          if (typeof raw.text === "string" && raw.text) {
            input.onFrame({ type: "text", delta: raw.text });
          }
          break;
        case "agent:tool": {
          if (typeof raw.name !== "string") break;
          const summary = typeof raw.summary === "string" ? raw.summary : "";
          input.onFrame({
            type: "tool",
            name: typeof raw.label === "string" && raw.label ? raw.label : raw.name,
            state:
              summary === "running" ? "start" : summary === "ok" ? "ok" : "error",
          });
          break;
        }
        case "agent:error":
          input.onFrame({
            type: "error",
            message:
              typeof raw.message === "string" && raw.message
                ? raw.message
                : "処理が最後まで進みませんでした。もう一度お試しください。",
          });
          finish("failed");
          break;
        case "agent:status":
          // The agent reports idle once the turn is finished, including the
          // turns that only answered.
          if (raw.state === "idle") finish("completed");
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
