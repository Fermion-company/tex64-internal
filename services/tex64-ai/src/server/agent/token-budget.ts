import type { StopCondition, ToolSet } from "ai";

// One structured section patch (headings, paragraphs, aligned derivations)
// regularly runs past 16k tokens of JSON; a mid-call cut truncates the tool
// call and kills the run, so the cap leaves real headroom.
export const MAX_AGENT_OUTPUT_TOKENS_PER_STEP = 32_000;
// A runaway-loop safety valve, not a billing control (billing quotas are
// enforced server-side). Writing a full multi-section paper in one run —
// each tool step re-reading the document model — legitimately passes 120k.
export const MAX_AGENT_TOTAL_TOKENS_PER_RUN = 400_000;

export type AgentTokenUsage = {
  totalTokens: number | undefined;
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  inputTokenDetails?: {
    cacheReadTokens?: number | undefined;
  };
};

export type AgentTokenUsageStep = {
  usage?: AgentTokenUsage;
};

export type AgentTokenUsageSummary = {
  measurable: boolean;
  totalTokens: number;
  budgetReached: boolean;
  budgetExceeded: boolean;
};

function validTokenCount(value: number | undefined): value is number {
  return Number.isInteger(value) && (value ?? -1) >= 0;
}

function measuredStepTokens(step: AgentTokenUsageStep): number | null {
  if (!step.usage) return null;
  // Cached prompt reads re-bill the whole shared prefix on every step; the
  // safety valve measures fresh work, so they do not count against it.
  const cacheReadTokens = step.usage.inputTokenDetails?.cacheReadTokens;
  const discount = validTokenCount(cacheReadTokens) ? cacheReadTokens : 0;
  if (validTokenCount(step.usage.totalTokens)) {
    return Math.max(0, step.usage.totalTokens - discount);
  }
  if (
    validTokenCount(step.usage.inputTokens) &&
    validTokenCount(step.usage.outputTokens)
  ) {
    return Math.max(
      0,
      step.usage.inputTokens + step.usage.outputTokens - discount,
    );
  }
  return null;
}

/**
 * Reduces provider usage without estimating missing values. An unmeasurable
 * step is fail-closed so the agent cannot continue outside its cost boundary.
 */
export function summarizeAgentTokenUsage(
  steps: readonly AgentTokenUsageStep[],
  maximumTokens: number,
): AgentTokenUsageSummary {
  if (!Number.isInteger(maximumTokens) || maximumTokens < 1) {
    throw new RangeError("Agent token budget must be a positive integer.");
  }

  let totalTokens = 0;
  for (const step of steps) {
    const measured = measuredStepTokens(step);
    if (measured === null) {
      return {
        measurable: false,
        totalTokens,
        budgetReached: false,
        budgetExceeded: false,
      };
    }
    totalTokens += measured;
  }

  return {
    measurable: steps.length > 0,
    totalTokens,
    budgetReached: totalTokens >= maximumTokens,
    budgetExceeded: totalTokens > maximumTokens,
  };
}

/** Stops the tool loop once its measured usage reaches the assigned budget. */
export function isAgentTokenBudget(
  maximumTokens: number,
): StopCondition<ToolSet> {
  return ({ steps }) => {
    const usage = summarizeAgentTokenUsage(steps, maximumTokens);
    return !usage.measurable || usage.budgetReached;
  };
}
