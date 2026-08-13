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
  agentProviderOptions,
  usesDirectOpenAiTransport,
} from "./language-model";
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

/**
 * search_sources is an AI Gateway provider tool (Perplexity executes inside
 * the gateway); without gateway credentials a call would fail the whole run,
 * so the tool disappears from the active set instead.
 */
function availableDocumentTools(): (typeof ACTIVE_DOCUMENT_TOOLS)[number][] {
  return usesDirectOpenAiTransport()
    ? [...ACTIVE_DOCUMENT_TOOLS].filter((tool) => tool !== "search_sources")
    : [...ACTIVE_DOCUMENT_TOOLS];
}

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
  const baseTools = availableDocumentTools();
  const sourceCalls = summarizeSourceToolCalls(input.steps ?? []);
  const activeTools = baseTools.filter(
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
  // The step iterator carries the previous prepareStep's toolChoice forward,
  // so the step-0 read_document force must be reset explicitly — otherwise
  // every later step is also forced into read_document and the agent can
  // only loop on reads until it hits its execution limit.
  return { toolChoice: "auto" as const, ...(limitsChangedTools ? { activeTools } : {}) };
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

  const activeTools = availableDocumentTools();
  const additionalRules = activeTools.includes("search_sources")
    ? options.additionalInstructions
    : [
        ...(options.additionalInstructions ?? []),
        "この環境ではsearch_sourcesは利用できません。代わりに、主題の主要文献としてあなたが確実に知っているURL・DOI（arXivの原論文など）を自分で挙げ、必ずresolve_sourceで取得・確認します。引用してよいのはcitationReadyがtrueになった出典だけで、確認に失敗した候補は別のURL・DOIを試します。ユーザーがURL・DOIを示した場合はそれを最優先で確認します。候補を挙げられない場合に限り、出典なしで進めるかrequest_inputで質問します。",
      ];

  return new WorkflowAgent({
    id: "tex64-document-agent",
    model: options.model,
    instructions: createDocumentAgentInstructions({
      additionalRules,
    }),
    tools,
    toolsContext: createDocumentToolsContext(options.context),
    activeTools,
    // Non-strict tool/output schemas on the direct-OpenAI transport.
    providerOptions: agentProviderOptions(),
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
