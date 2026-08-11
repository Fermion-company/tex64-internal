import { describe, expect, it } from "vitest";

import {
  isAgentTokenBudget,
  summarizeAgentTokenUsage,
} from "@/server/agent/token-budget";
import { documentAgentExecutionEvidence } from "@/workflows/document-agent/helpers";

const usage = (
  totalTokens: number | undefined,
  inputTokens: number | undefined,
  outputTokens: number | undefined,
) => ({ totalTokens, inputTokens, outputTokens });

describe("document agent token budget", () => {
  it("uses provider totals and falls back only when both components exist", () => {
    expect(
      summarizeAgentTokenUsage(
        [
          { usage: usage(40, 30, 10) },
          { usage: usage(undefined, 20, 5) },
        ],
        100,
      ),
    ).toEqual({
      measurable: true,
      totalTokens: 65,
      budgetReached: false,
      budgetExceeded: false,
    });
  });

  it("fails closed when any provider step omits measurable usage", async () => {
    const summary = summarizeAgentTokenUsage(
      [
        { usage: usage(40, 30, 10) },
        { usage: usage(undefined, 20, undefined) },
      ],
      100,
    );
    expect(summary).toMatchObject({
      measurable: false,
      totalTokens: 40,
    });

    const stop = isAgentTokenBudget(100);
    expect(
      await stop({
        steps: [
          { usage: usage(undefined, undefined, undefined) },
        ] as never,
      }),
    ).toBe(true);
  });

  it("stops at the assigned cumulative threshold", async () => {
    const stop = isAgentTokenBudget(100);
    expect(
      await stop({
        steps: [
          { usage: usage(60, 50, 10) },
          { usage: usage(40, 30, 10) },
        ] as never,
      }),
    ).toBe(true);
    expect(
      summarizeAgentTokenUsage(
        [
          { usage: usage(60, 50, 10) },
          { usage: usage(41, 31, 10) },
        ],
        100,
      ),
    ).toMatchObject({ budgetReached: true, budgetExceeded: true });
  });

  it("includes usage state in trusted workflow evidence", () => {
    expect(
      documentAgentExecutionEvidence({
        finishReason: "tool-calls",
        maxTotalTokens: 100,
        steps: [
          {
            toolCalls: [{ toolName: "read_document" }],
            usage: usage(60, 50, 10),
          },
          {
            toolCalls: [{ toolName: "check_document" }],
            usage: usage(40, 30, 10),
          },
        ],
      }),
    ).toMatchObject({
      usageMeasured: true,
      totalTokens: 100,
      tokenBudgetReached: true,
      tokenBudgetExceeded: false,
      completedNaturally: false,
    });
  });
});
