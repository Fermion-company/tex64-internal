import type { StopCondition, ToolSet } from "ai";

// One structured section patch (headings, paragraphs, aligned derivations)
// regularly runs past 16k tokens of JSON; a mid-call cut truncates the tool
// call and kills the run, so the cap leaves real headroom.
export const MAX_AGENT_OUTPUT_TOKENS_PER_STEP = 32_000;
// A runaway-loop safety valve, not a billing control (billing quotas are
// enforced server-side). Writing a full multi-section paper in one run —
// each tool step re-reading the document model — legitimately passes 120k.
export const MAX_AGENT_TOTAL_TOKENS_PER_RUN = 400_000;

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

function cachedTokenCount(usage: AgentTokenUsage): number {
  const detail = usage.inputTokenDetails?.cacheReadTokens;
  const fromDetail = tokenCount(detail);
  if (fromDetail !== undefined) return fromDetail;
  const inputs = usage.inputTokens;
  if (inputs && typeof inputs === "object" && typeof inputs.cacheRead === "number") {
    return inputs.cacheRead;
  }
  return tokenCount(usage.cachedInputTokens) ?? 0;
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
  // Cached prompt reads re-bill the whole shared prefix on every step; the
  // safety valve measures fresh work, so they do not count against it.
  const discount = cachedTokenCount(step.usage);
  const total = tokenCount(step.usage.totalTokens);
  if (validTokenCount(total)) return Math.max(0, total - discount);
  const inputTokens = tokenCount(step.usage.inputTokens);
  const outputTokens = tokenCount(step.usage.outputTokens);
  if (validTokenCount(inputTokens) && validTokenCount(outputTokens)) {
    return Math.max(0, inputTokens + outputTokens - discount);
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
 * Unmeasurable usage does NOT stop the turn: the step count is the primary
 * bound, and a provider that reports usage in a shape this code cannot read
 * must not silently reduce every turn to a single step.
 */
export function isAgentTokenBudget(
  maximumTokens: number,
): StopCondition<ToolSet> {
  return ({ steps }) => {
    const usage = summarizeAgentTokenUsage(steps, maximumTokens);
    return usage.measurable && usage.budgetReached;
  };
}
