import { WorkflowAgent } from "@ai-sdk/workflow";
import { hasToolCall, isStepCount, type LanguageModel } from "ai";

import {
  createDocumentTools,
  createDocumentToolsContext,
  type DocumentToolContext,
  type DocumentToolHandlers,
  type DocumentWorkflowApprovalMode,
} from "./document-tools";
import { createDocumentAgentInstructions } from "./instructions";
import {
  isAgentTokenBudget,
  MAX_AGENT_OUTPUT_TOKENS_PER_STEP,
  MAX_AGENT_TOTAL_TOKENS_PER_RUN,
} from "./token-budget";
import { summarizeSourceToolCalls } from "./source-tool-budget";

export const ACTIVE_DOCUMENT_TOOLS = [
  "read_document",
  "search_sources",
  "resolve_source",
  "apply_document_patch",
  "format_document",
  "check_document",
  "request_input",
] as const;

export interface CreateDocumentWorkflowAgentOptions {
  model: LanguageModel;
  handlers: DocumentToolHandlers;
  context: DocumentToolContext;
  additionalInstructions?: readonly string[];
  maxSteps?: number;
  maxOutputTokens?: number;
  maxTotalTokens?: number;
  approvalMode?: DocumentWorkflowApprovalMode;
}

/** The first model turn must observe the persisted document, not infer it. */
export function prepareDocumentAgentStep(input: {
  stepNumber: number;
  steps?: readonly { toolCalls: readonly { toolName: string }[] }[];
}) {
  const sourceCalls = summarizeSourceToolCalls(input.steps ?? []);
  const activeTools = ACTIVE_DOCUMENT_TOOLS.filter(
    (toolName) =>
      !(toolName === "search_sources" && sourceCalls.searchLimitReached) &&
      !(toolName === "resolve_source" && sourceCalls.resolveLimitReached),
  );
  const limitsChangedTools =
    activeTools.length !== ACTIVE_DOCUMENT_TOOLS.length;

  if (input.stepNumber === 0) {
    return {
      toolChoice: { type: "tool", toolName: "read_document" },
      ...(limitsChangedTools ? { activeTools } : {}),
    } as const;
  }
  return limitsChangedTools ? { activeTools } : undefined;
}

/**
 * Creates one durable agent per document run. Only serializable identifiers are
 * placed in tool context, as required by WorkflowAgent replay semantics.
 */
export function createDocumentWorkflowAgent(
  options: CreateDocumentWorkflowAgentOptions,
) {
  const tools = createDocumentTools(options.handlers, {
    approvalMode: options.approvalMode,
  });

  return new WorkflowAgent({
    id: "tex64-document-agent",
    model: options.model,
    instructions: createDocumentAgentInstructions({
      additionalRules: options.additionalInstructions,
    }),
    tools,
    toolsContext: createDocumentToolsContext(options.context),
    activeTools: [...ACTIVE_DOCUMENT_TOOLS],
    maxOutputTokens:
      options.maxOutputTokens ?? MAX_AGENT_OUTPUT_TOKENS_PER_STEP,
    prepareStep: prepareDocumentAgentStep,
    // A clarification is a suspension point, not an invitation for the model
    // to ask another question or keep mutating the document in a later step.
    stopWhen: [
      hasToolCall("request_input"),
      isAgentTokenBudget(
        options.maxTotalTokens ?? MAX_AGENT_TOTAL_TOKENS_PER_RUN,
      ),
      isStepCount(options.maxSteps ?? 12),
    ],
  });
}
