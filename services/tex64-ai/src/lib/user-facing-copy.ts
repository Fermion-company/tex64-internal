export type UserFacingQuestionKind = "clarification_required";

export const USER_FACING_QUESTION_FALLBACKS = Object.freeze({
  clarification_required:
    "文書を完成させるために、不足している内容や希望する方針を教えてください。",
} satisfies Record<UserFacingQuestionKind, string>);

const INTERNAL_TOOL_NAME =
  /(?:^|[^A-Za-z0-9_])(?:read_document|search_sources|resolve_source|apply_document_patch|check_document|format_document|request_input|delete_document|publish_document|run_expensive_task)(?=$|[^A-Za-z0-9_])/iu;

const INTERNAL_FIELD_NAME =
  /(?:^|[^A-Za-z0-9_])(?:workflowRunId|rootRunId|authoringRunId|sourceRunId|responseRunId|reviewRunId|answeredByRunId|toolCallId|storageKey|userId|documentId|artifactId|questionId|criterionId|findingId|eventKey|leaseToken|nodeId|planItemId|sourceId|revisionId|parentRevisionId|sessionId|actorId|requestId|responseId|documentDigest|briefDigest|planDigest|patchDigest|artifactDigest|researchLedgerId|planId|briefId|artifactRelease|idempotencyKey|stateVersion|briefVersion|confirmedBriefVersion|currentRevision|baseRevision|resultRevision|activeQuestionId|providerMetadata|providerTrace|providerOptions|modelId|modelName|modelVersion|workflow_run_id|root_run_id|authoring_run_id|source_run_id|response_run_id|review_run_id|answered_by_run_id|tool_call_id|storage_key|user_id|document_id|artifact_id|question_id|criterion_id|finding_id|event_key|lease_token|node_id|plan_item_id|source_id|revision_id|parent_revision_id|session_id|actor_id|request_id|response_id|document_digest|brief_digest|plan_digest|patch_digest|artifact_digest|research_ledger_id|plan_id|brief_id|artifact_release|idempotency_key|state_version|brief_version|confirmed_brief_version|current_revision|base_revision|result_revision|active_question_id|provider_metadata|provider_trace|provider_options|model_id|model_name|model_version|x-request-id|openai-request-id)(?=$|[^A-Za-z0-9_])/iu;

const PROVIDER_OR_MODEL_METADATA =
  /(?:\bAI[\s_-]*Gateway\b|(?:^|[^A-Za-z0-9_])ai_gateway(?=$|[^A-Za-z0-9_])|["']?(?:provider|model)(?:Metadata|Trace|Options|Id|Name|Version)?["']?\s*[:=]|\b(?:openai|anthropic|google|xai|meta|mistral|cohere|perplexity|deepseek)\/[A-Za-z0-9][A-Za-z0-9._:-]*)/iu;

const INTERNAL_IDENTIFIER =
  /(?:\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b(?:run|call|wf|req|step)[_-][A-Za-z0-9_-]{4,}\b|\b[0-9a-f]{40,64}\b)/iu;

const STACK_OR_ERROR_FRAGMENT =
  /(?:(?:^|\n)\s*(?:Error|TypeError|RangeError|ReferenceError|SyntaxError|ZodError|FatalError):[^\n]*|(?:^|\n)\s*at\s+(?:async\s+)?\S+(?:\s+\([^\n]*:\d+:\d+\)|:\d+:\d+))/iu;

const INTERNAL_PATH_FRAGMENT =
  /(?:file:\/\/|\/(?:Users|home|workspace|tmp|private|var|opt)\/[^\s)\]}>]+|[A-Za-z]:\\[^\r\n]+|(?:^|[\s(])(?:src|app|server|node_modules)\/[^\s:)\]}>]+\.(?:ts|tsx|js|jsx|mjs|cjs|tex)(?::\d+(?::\d+)?)?|(?:^|[\s(])(?:\.\.?\/)?[^\s/()\]}>]+\.tex(?=$|[\s)\]}>]))/iu;

const RAW_TEX_CONTROL_SEQUENCE =
  /\\(?:[A-Za-z@]+|[()[\]{}$%&#_^~\\])/u;

const DISALLOWED_CONTROL_CHARACTER =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

const EXTERNAL_LOCATOR = /https?:\/\/[^\s)\]}>]+/giu;

/**
 * Detects concrete execution details without hiding ordinary domain language.
 * In particular, words such as "tool calling", "ワークフロー", "TeX", and
 * "LaTeX" remain valid subject matter; only exact internal names and raw TeX
 * control sequences are withheld.
 */
export function containsUnsafeUserFacingCopy(value: string): boolean {
  const normalized = value
    .normalize("NFKC")
    .replace(/[\u200b-\u200d\u2060\ufeff]/gu, "");
  const withoutExternalLocators = normalized.replace(
    EXTERNAL_LOCATOR,
    "https://source.invalid",
  );

  return (
    INTERNAL_TOOL_NAME.test(withoutExternalLocators) ||
    INTERNAL_FIELD_NAME.test(withoutExternalLocators) ||
    PROVIDER_OR_MODEL_METADATA.test(withoutExternalLocators) ||
    INTERNAL_IDENTIFIER.test(withoutExternalLocators) ||
    STACK_OR_ERROR_FRAGMENT.test(normalized) ||
    INTERNAL_PATH_FRAGMENT.test(normalized) ||
    RAW_TEX_CONTROL_SEQUENCE.test(normalized) ||
    DISALLOWED_CONTROL_CHARACTER.test(normalized)
  );
}

export function normalizeUserFacingQuestion(
  value: unknown,
  kind: UserFacingQuestionKind,
): string {
  const fallback = USER_FACING_QUESTION_FALLBACKS[kind];
  if (typeof value !== "string") return fallback;

  const normalized = value.normalize("NFC").replace(/\r\n?/gu, "\n").trim();
  if (
    normalized.length === 0 ||
    normalized.length > 500 ||
    containsUnsafeUserFacingCopy(normalized)
  ) {
    return fallback;
  }
  return normalized;
}

/**
 * Sanitizes the agent's closing message for chat display. Fail-closed: any
 * hint of internal detail drops the note entirely (callers fall back to the
 * fixed completion copy).
 */
export function normalizeUserFacingResultNote(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const normalized = value.normalize("NFC").replace(/\r\n?/gu, "\n").trim();
  if (
    normalized.length === 0 ||
    normalized.length > 1_000 ||
    containsUnsafeUserFacingCopy(normalized)
  ) {
    return null;
  }
  return normalized;
}
