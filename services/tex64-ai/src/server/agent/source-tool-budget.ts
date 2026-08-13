export const MAX_AGENT_SOURCE_SEARCH_CALLS = 3;
export const MAX_AGENT_SOURCE_RESOLVE_CALLS = 8;

export type SourceToolCallStep = {
  toolCalls: readonly { toolName: string }[];
};

export type SourceToolCallSummary = {
  searchCalls: number;
  resolveCalls: number;
  searchLimitReached: boolean;
  resolveLimitReached: boolean;
  limitExceeded: boolean;
};

export function summarizeSourceToolCalls(
  steps: readonly SourceToolCallStep[],
): SourceToolCallSummary {
  let searchCalls = 0;
  let resolveCalls = 0;
  for (const step of steps) {
    for (const call of step.toolCalls) {
      if (call.toolName === "search_sources") searchCalls += 1;
      if (call.toolName === "resolve_source") resolveCalls += 1;
    }
  }
  return {
    searchCalls,
    resolveCalls,
    searchLimitReached: searchCalls >= MAX_AGENT_SOURCE_SEARCH_CALLS,
    resolveLimitReached: resolveCalls >= MAX_AGENT_SOURCE_RESOLVE_CALLS,
    limitExceeded:
      searchCalls > MAX_AGENT_SOURCE_SEARCH_CALLS ||
      resolveCalls > MAX_AGENT_SOURCE_RESOLVE_CALLS,
  };
}
