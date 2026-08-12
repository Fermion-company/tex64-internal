import { describe, expect, it } from "vitest";

import {
  SEMANTIC_PROGRESS_STATES,
  SemanticProgressEventSchema,
  canTransitionProgress,
  createProgressEvent,
  isTerminalProgressState,
  transitionProgress,
} from "@/server/agent/progress";

describe("semantic agent progress", () => {
  it("exposes every semantic state with fixed user-facing copy", () => {
    expect(SEMANTIC_PROGRESS_STATES).toEqual([
      "understanding",
      "planning",
      "writing",
      "checking",
      "formatting",
      "ready",
      "needs_input",
      "failed",
    ]);

    for (const state of SEMANTIC_PROGRESS_STATES) {
      const event = createProgressEvent(state);
      expect(SemanticProgressEventSchema.safeParse(event).success).toBe(true);
      expect(event.label).not.toMatch(/\.tex|LaTeX|LuaLaTeX|ログ|stack/i);
    }

    expect(
      SemanticProgressEventSchema.safeParse({
        type: "agent.progress",
        state: "writing",
        label: "main.tex を処理しています",
        sequence: 1,
      }).success,
    ).toBe(false);
  });

  it("supports the normal lifecycle and increments the sequence", () => {
    let event = createProgressEvent("understanding", { sequence: 4 });
    for (const state of [
      "planning",
      "writing",
      "checking",
      "formatting",
      "ready",
    ] as const) {
      event = transitionProgress(event, state);
    }

    expect(event).toMatchObject({ state: "ready", sequence: 9 });
    expect(isTerminalProgressState(event.state)).toBe(true);
  });

  it("allows repair loops but rejects impossible terminal transitions", () => {
    expect(canTransitionProgress("checking", "writing")).toBe(true);
    expect(canTransitionProgress("ready", "writing")).toBe(false);

    const ready = createProgressEvent("ready");
    expect(() => transitionProgress(ready, "writing")).toThrow(
      /Invalid semantic progress transition/,
    );
  });
});
