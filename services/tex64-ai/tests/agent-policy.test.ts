import { describe, expect, it } from "vitest";

import {
  CheckDocumentInputSchema,
  FormatDocumentInputSchema,
  SearchSourcesInputSchema,
  createDocumentTools,
  type DocumentToolHandlers,
} from "@/server/agent/document-tools";
import {
  containsDeleteOperation,
  evaluateAgentPolicy,
  requiresApproval,
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

    const tools = createDocumentTools({} as DocumentToolHandlers);
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

  it("requires approval for a destructive patch", () => {
    expect(
      workflowNeedsApproval("apply_document_patch", {
        patch: { operations: [{ kind: "delete_block", blockId: "b-1" }] },
      }),
    ).toBe(true);
  });

  it("classifies nested delete operations without trusting a risk flag", () => {
    expect(
      containsDeleteOperation({
        risk: "reversible",
        changes: [{ op: "remove-section", id: "s-1" }],
      }),
    ).toBe(true);
  });

  it("fails closed for an unknown action", () => {
    expect(
      requiresApproval({ action: "unknown_external_tool", input: {} }),
    ).toBe(true);
    expect(requiresApproval({ action: "check_document", input: {} })).toBe(
      false,
    );
  });
});
