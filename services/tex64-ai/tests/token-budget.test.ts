import { describe, expect, it } from "vitest";

import {
  MAX_AGENT_TOTAL_TOKENS_PER_RUN,
  isAgentTokenBudget,
  summarizeAgentTokenUsage,
} from "@/server/agent/token-budget";

describe("agent token budget", () => {
  it("caps one multi-step turn at 100k and counts cached input", () => {
    expect(MAX_AGENT_TOTAL_TOKENS_PER_RUN).toBe(100_000);
    expect(
      summarizeAgentTokenUsage(
        [
          {
            usage: {
              totalTokens: 70_000,
              inputTokenDetails: { cacheReadTokens: 60_000 },
            },
          },
          { usage: { totalTokens: 30_000 } },
        ],
        MAX_AGENT_TOTAL_TOKENS_PER_RUN,
      ),
    ).toMatchObject({
      measurable: true,
      totalTokens: 100_000,
      budgetReached: true,
    });
  });

  it("fails closed when provider usage is not measurable", () => {
    const stop = isAgentTokenBudget(MAX_AGENT_TOTAL_TOKENS_PER_RUN);
    expect(stop({ steps: [{ usage: undefined }] } as never)).toBe(true);
  });
});
