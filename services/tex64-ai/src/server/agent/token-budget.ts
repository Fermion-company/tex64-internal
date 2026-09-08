import type { StopCondition, ToolSet } from "ai";

// One structured section patch (headings, paragraphs, aligned derivations)
// regularly runs past 16k tokens of JSON; a mid-call cut truncates the tool
// call and kills the run, so the cap leaves real headroom.
export const MAX_AGENT_OUTPUT_TOKENS_PER_STEP = 32_000;
// One user turn can contain many paid model steps. Keep a hard turn boundary
// in addition to account billing so an agent loop cannot consume a monthly
// allowance in one request.
export const MAX_AGENT_TOTAL_TOKENS_PER_RUN = 100_000;

/**
 * Token counts arrive either as plain numbers or as a detail object
 * (`{ total, cacheRead, ... }`) depending on the provider specification the
 * SDK negotiates. Both shapes are read; neither is assumed.
 */
export type AgentTokenCount =
  | number
  | { total?: number | undefined; cacheRead?: number | undefined }
  | undefined;

export type AgentTokenUsage = {
  totalTokens?: AgentTokenCount;
  inputTokens?: AgentTokenCount;
  outputTokens?: AgentTokenCount;
  cachedInputTokens?: AgentTokenCount;
  inputTokenDetails?: {
    cacheReadTokens?: AgentTokenCount;
  };
};

export function tokenCount(value: AgentTokenCount): number | undefined {
  if (typeof value === "number") return value;
  if (value && typeof value === "object" && typeof value.total === "number") {
    return value.total;
  }
  return undefined;
}

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
  const total = tokenCount(step.usage.totalTokens);
  if (validTokenCount(total)) return total;
  const inputTokens = tokenCount(step.usage.inputTokens);
  const outputTokens = tokenCount(step.usage.outputTokens);
  if (validTokenCount(inputTokens) && validTokenCount(outputTokens)) {
    return inputTokens + outputTokens;
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

/**
 * Stops the tool loop once its measured usage reaches the assigned budget.
 *
 * Unmeasurable usage stops after the current step. Continuing without knowing
 * what was billed would make the cost boundary optional.
 */
export function isAgentTokenBudget(
  maximumTokens: number,
): StopCondition<ToolSet> {
  return ({ steps }) => {
    const usage = summarizeAgentTokenUsage(steps, maximumTokens);
    return !usage.measurable || usage.budgetReached;
  };
}
