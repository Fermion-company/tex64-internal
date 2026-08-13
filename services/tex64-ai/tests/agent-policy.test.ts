import { describe, expect, it } from "vitest";

import {
  CheckDocumentInputSchema,
  FormatDocumentInputSchema,
  SearchSourcesInputSchema,
  createDocumentTools,
  type DocumentToolHandlers,
} from "@/server/agent/document-tools";
import {
  canApprovePendingDocumentPatch,
  containsDeleteOperation,
  evaluateAgentPolicy,
  isExplicitApprovalPrompt,
  toolLoopDocumentApproval,
  workflowNeedsApproval,
} from "@/server/agent/policy";
import {
  ACTIVE_DOCUMENT_TOOLS,
  prepareDocumentAgentStep,
} from "@/server/agent/workflow-agent";
import { DOCUMENT_AGENT_SYSTEM_INSTRUCTIONS } from "@/server/agent/instructions";

describe("document agent approval policy", () => {
  it("exposes only tools whose production behavior is implemented", () => {
    expect(ACTIVE_DOCUMENT_TOOLS).toEqual([
      "read_document",
      "search_sources",
      "resolve_source",
      "apply_document_patch",
      "format_document",
      "check_document",
      "request_input",
    ]);

    const tools = createDocumentTools({} as DocumentToolHandlers, {
      approvalMode: "external_run",
    });
    expect(tools.search_sources).toMatchObject({
      type: "provider",
      id: "gateway.perplexity_search",
      isProviderExecuted: true,
      args: {
        maxResults: 5,
        maxTokensPerPage: 768,
        maxTokens: 6_000,
      },
    });
    expect(tools.search_sources.inputSchema).toBe(SearchSourcesInputSchema);
    expect(tools.check_document.description).toBe(
      "文書モデルの構造、参照先の存在、引用と参考文献のID対応を検証する。文章の品質、主張の事実性、出典内容、紙面の見た目は検証しない。",
    );
    expect(tools.format_document.description).toContain("安全なプリセット");
  });

  it("offers only the structural and reference checks the handler implements", () => {
    expect(CheckDocumentInputSchema.parse({})).toEqual({
      checks: ["structure", "references"],
    });
    expect(
      CheckDocumentInputSchema.safeParse({ checks: ["clarity"] }).success,
    ).toBe(false);
    expect(
      CheckDocumentInputSchema.safeParse({ checks: ["citations"] }).success,
    ).toBe(false);
    expect(
      CheckDocumentInputSchema.safeParse({ checks: ["layout"] }).success,
    ).toBe(false);
  });

  it("accepts only allowlisted document layout controls", () => {
    expect(
      FormatDocumentInputSchema.parse({
        baseRevision: 3,
        preset: "academic",
        pageSize: "B5",
        columns: 2,
        citationStyle: "apa7",
      }),
    ).toEqual({
      baseRevision: 3,
      preset: "academic",
      pageSize: "B5",
      columns: 2,
      citationStyle: "apa7",
    });
    expect(
      FormatDocumentInputSchema.safeParse({
        baseRevision: 3,
        preset: "custom",
        documentClass: String.raw`article]{}\input{/etc/passwd}`,
        citationStyle: "custom.csl",
      }).success,
    ).toBe(false);
  });

  it("forbids invented assets and empty figure placeholders", () => {
    expect(DOCUMENT_AGENT_SYSTEM_INSTRUCTIONS).toContain(
      "UUIDを生成して画像が存在するように装ってはいけません",
    );
    expect(DOCUMENT_AGENT_SYSTEM_INSTRUCTIONS).toContain(
      "altTextとcaptionだけの空の図を完成物にしてはいけません",
    );
    expect(DOCUMENT_AGENT_SYSTEM_INSTRUCTIONS).toContain("flowDiagram");
    expect(DOCUMENT_AGENT_SYSTEM_INSTRUCTIONS).toContain("line/bar chart");
  });

  it("forces the persisted document read on the first model step", () => {
    expect(prepareDocumentAgentStep({ stepNumber: 0 })).toEqual({
      toolChoice: { type: "tool", toolName: "read_document" },
    });
    // The step iterator carries toolChoice overrides forward, so every
    // later step must reset it or the read force becomes permanent.
    expect(prepareDocumentAgentStep({ stepNumber: 1 })).toEqual({
      toolChoice: "auto",
    });
  });

  it("prevents runtime overrides of the fixed source-search limits", () => {
    expect(SearchSourcesInputSchema.parse({ query: "selective attention" })).toEqual({
      query: "selective attention",
    });
    expect(
      SearchSourcesInputSchema.parse({ query: ["attention", "working memory", "review"] }),
    ).toEqual({ query: ["attention", "working memory", "review"] });
    expect(
      SearchSourcesInputSchema.safeParse({
        query: "attention",
        max_results: 50,
      }).success,
    ).toBe(false);
    expect(
      SearchSourcesInputSchema.safeParse({
        query: "attention",
        max_tokens: 100_000,
      }).success,
    ).toBe(false);
    expect(
      SearchSourcesInputSchema.safeParse({ query: ["a", "b", "c", "d"] }).success,
    ).toBe(false);
    expect(
      SearchSourcesInputSchema.safeParse({ query: "x".repeat(501) }).success,
    ).toBe(false);
  });

  it("removes source tools after their cumulative call caps", () => {
    const afterSearchCap = prepareDocumentAgentStep({
      stepNumber: 2,
      steps: [
        {
          toolCalls: [
            { toolName: "search_sources" },
            { toolName: "search_sources" },
            { toolName: "search_sources" },
          ],
        },
      ],
    });
    expect(afterSearchCap?.activeTools).not.toContain("search_sources");
    expect(afterSearchCap?.activeTools).toContain("resolve_source");

    const afterResolveCap = prepareDocumentAgentStep({
      stepNumber: 3,
      steps: [
        {
          toolCalls: Array.from({ length: 8 }, () => ({
            toolName: "resolve_source",
          })),
        },
      ],
    });
    expect(afterResolveCap?.activeTools).not.toContain("resolve_source");
    expect(afterResolveCap?.activeTools).toContain("search_sources");
  });

  it("recognizes only a dedicated explicit approval message", () => {
    expect(isExplicitApprovalPrompt("承認します")).toBe(true);
    expect(isExplicitApprovalPrompt("この変更を承認します。 ")).toBe(true);
    expect(isExplicitApprovalPrompt("はい、前の削除を承認します")).toBe(true);
    expect(isExplicitApprovalPrompt("承認について説明して")).toBe(false);
    expect(isExplicitApprovalPrompt("必要なら承認しますが、まず直して")).toBe(
      false,
    );
    expect(isExplicitApprovalPrompt("削除して")).toBe(false);
  });

  it("limits separate-run approval to a pending semantic deletion", () => {
    const deletePatch = {
      operations: [{
        op: "delete",
        nodeId: "40c7df69-05ef-4fe0-bb2d-a21779510c9a",
      }],
    };
    expect(
      canApprovePendingDocumentPatch({
        approvalPrompt: "この変更を承認します",
        patch: deletePatch,
      }),
    ).toBe(true);
    expect(
      canApprovePendingDocumentPatch({
        approvalPrompt: "削除して",
        patch: deletePatch,
      }),
    ).toBe(false);
    expect(
      canApprovePendingDocumentPatch({
        approvalPrompt: "承認します",
        patch: { operations: [{ op: "update" }] },
      }),
    ).toBe(false);
  });

  it("automatically permits read-only and reversible edits", () => {
    expect(evaluateAgentPolicy({ action: "read_document" })).toEqual({
      outcome: "auto",
      reason: "read_only",
    });
    expect(evaluateAgentPolicy({ action: "request_input" })).toEqual({
      outcome: "auto",
      reason: "read_only",
    });
    expect(
      evaluateAgentPolicy({
        action: "apply_document_patch",
        input: {
          operations: [
            { type: "update_block", blockId: "b-1", text: "更新後" },
            { type: "insert_block", afterId: "b-1", text: "追記" },
          ],
        },
      }),
    ).toEqual({ outcome: "auto", reason: "reversible_edit" });
    expect(
      evaluateAgentPolicy({
        action: "apply_document_patch",
        input: {
          patch: {
            operations: Array.from({ length: 51 }, (_, index) => ({
              op: "insert",
              index,
            })),
          },
        },
      }),
    ).toEqual({ outcome: "auto", reason: "reversible_edit" });
  });

  it("can disable WorkflowAgent suspension until an approval API is connected", () => {
    const handlers = {} as DocumentToolHandlers;
    const tools = createDocumentTools(handlers, {
      approvalMode: "external_run",
    });

    expect(tools.apply_document_patch.needsApproval).toBe(false);
    expect(tools.delete_document.needsApproval).toBe(false);
    expect(tools.publish_document.needsApproval).toBe(false);
    expect(tools.run_expensive_task.needsApproval).toBe(false);
    expect(tools.request_input.needsApproval).toBeUndefined();

    const suspendable = createDocumentTools(handlers, {
      approvalMode: "workflow_suspend",
    });
    expect(typeof suspendable.apply_document_patch.needsApproval).toBe(
      "function",
    );
    expect(suspendable.delete_document.needsApproval).toBe(true);
  });

  it("requires approval for delete, publish, and expensive work", () => {
    expect(
      workflowNeedsApproval("apply_document_patch", {
        patch: { operations: [{ kind: "delete_block", blockId: "b-1" }] },
      }),
    ).toBe(true);
    expect(workflowNeedsApproval("delete_document")).toBe(true);
    expect(workflowNeedsApproval("publish_document")).toBe(true);
    expect(workflowNeedsApproval("run_expensive_task")).toBe(true);
  });

  it("classifies nested delete operations without trusting a risk flag", () => {
    expect(
      containsDeleteOperation({
        risk: "reversible",
        changes: [{ op: "remove-section", id: "s-1" }],
      }),
    ).toBe(true);
  });

  it("fails closed for an unknown tool and shares the ToolLoop decision", () => {
    expect(
      toolLoopDocumentApproval({
        toolCall: { toolName: "unknown_external_tool", input: {} },
      }),
    ).toBe("user-approval");
    expect(
      toolLoopDocumentApproval({
        toolCall: { toolName: "check_document", input: {} },
      }),
    ).toBeUndefined();
  });
});
