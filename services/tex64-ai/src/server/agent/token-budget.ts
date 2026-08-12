import type { StopCondition, ToolSet } from "ai";

export const MAX_AGENT_OUTPUT_TOKENS_PER_STEP = 16_000;
export const MAX_AGENT_TOTAL_TOKENS_PER_RUN = 120_000;

export type AgentTokenUsage = {
  totalTokens: number | undefined;
  inputTokens: number | undefined;
  outputTokens: number | undefined;
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
  if (validTokenCount(step.usage.totalTokens)) {
    return step.usage.totalTokens;
  }
  if (
    validTokenCount(step.usage.inputTokens) &&
    validTokenCount(step.usage.outputTokens)
  ) {
    return step.usage.inputTokens + step.usage.outputTokens;
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
