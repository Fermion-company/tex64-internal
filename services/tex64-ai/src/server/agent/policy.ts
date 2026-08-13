import { z } from "zod";

export const AgentPolicyActionSchema = z.enum([
  "read_document",
  "apply_document_patch",
  "check_document",
  "format_document",
  "request_input",
  "delete_document",
  "publish_document",
  "run_expensive_task",
]);

export type AgentPolicyAction = z.infer<typeof AgentPolicyActionSchema>;

export const ApprovalPolicyDecisionSchema = z
  .object({
    outcome: z.enum(["auto", "requires_approval"]),
    reason: z.enum([
      "read_only",
      "reversible_edit",
      "destructive_delete",
      "publishing",
      "expensive_operation",
      "unknown_action",
    ]),
  })
  .strict();

export type ApprovalPolicyDecision = z.infer<
  typeof ApprovalPolicyDecisionSchema
>;

export interface AgentPolicyRequest {
  action: AgentPolicyAction | (string & {});
  input?: unknown;
}

const DELETE_MARKER = /(^|[_-])(delete|remove|clear|discard)([_-]|$)/i;

const EXPLICIT_APPROVAL_PROMPT = /^(?:はい[、,\s]*)?(?:(?:この|その|前の|直前の)[\s]*)?(?:(?:変更|操作|削除)[\s]*(?:を)?[\s]*)?承認(?:します|する|しました)?[。.!！\s]*$/;

/**
 * Approval must be a dedicated, unambiguous user message. Merely mentioning
 * approval inside a broader instruction never grants it.
 */
export function isExplicitApprovalPrompt(prompt: string): boolean {
  return EXPLICIT_APPROVAL_PROMPT.test(
    prompt.normalize("NFKC").replace(/\s+/g, " ").trim(),
  );
}

function discriminatorOf(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;

  const candidate = value as Record<string, unknown>;
  for (const key of ["type", "kind", "op", "action", "operation"]) {
    if (typeof candidate[key] === "string") return candidate[key];
  }

  return undefined;
}

/**
 * Detects deletion from validated document operations without trusting a
 * model-supplied risk flag. The domain schema owns validity; this function only
 * classifies a parsed value for approval.
 */
export function containsDeleteOperation(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsDeleteOperation);
  if (!value || typeof value !== "object") return false;

  const record = value as Record<string, unknown>;
  const discriminator = discriminatorOf(record);
  if (discriminator && DELETE_MARKER.test(discriminator)) return true;

  for (const key of ["operations", "patch", "changes"]) {
    if (key in record && containsDeleteOperation(record[key])) return true;
  }

  return false;
}

export function evaluateAgentPolicy(
  request: AgentPolicyRequest,
): ApprovalPolicyDecision {
  switch (request.action) {
    case "read_document":
    case "check_document":
    case "request_input":
      return { outcome: "auto", reason: "read_only" };

    case "apply_document_patch":
      if (containsDeleteOperation(request.input)) {
        return { outcome: "requires_approval", reason: "destructive_delete" };
      }
      return { outcome: "auto", reason: "reversible_edit" };

    case "format_document":
      return { outcome: "auto", reason: "reversible_edit" };

    case "delete_document":
      return { outcome: "requires_approval", reason: "destructive_delete" };

    case "publish_document":
      return { outcome: "requires_approval", reason: "publishing" };

    case "run_expensive_task":
      return { outcome: "requires_approval", reason: "expensive_operation" };

    default:
      return { outcome: "requires_approval", reason: "unknown_action" };
  }
}

export function requiresApproval(request: AgentPolicyRequest): boolean {
  return evaluateAgentPolicy(request).outcome === "requires_approval";
}

/**
 * The external-run flow currently grants only a previously-pending semantic
 * deletion. Publishing, whole-document deletion, expensive work, and unknown
 * actions remain unavailable even after a generic approval message.
 */
export function canApprovePendingDocumentPatch(input: {
  approvalPrompt: string;
  patch: unknown;
}): boolean {
  if (!isExplicitApprovalPrompt(input.approvalPrompt)) return false;
  const decision = evaluateAgentPolicy({
    action: "apply_document_patch",
    input: { patch: input.patch },
  });
  return (
    decision.outcome === "requires_approval" &&
    decision.reason === "destructive_delete"
  );
}

/** WorkflowAgent's tool-level `needsApproval` contract. */
export function workflowNeedsApproval(
  action: AgentPolicyAction,
  input?: unknown,
): boolean {
  return requiresApproval({ action, input });
}

/** ToolLoopAgent's generic `toolApproval` contract. */
export function toolLoopDocumentApproval({
  toolCall,
}: {
  toolCall: { toolName: string; input: unknown };
}): "user-approval" | undefined {
  return requiresApproval({ action: toolCall.toolName, input: toolCall.input })
    ? "user-approval"
    : undefined;
}
