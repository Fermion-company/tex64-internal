import { gateway } from "@ai-sdk/gateway";
import { jsonSchema, tool, type ModelMessage } from "ai";
import { z } from "zod";

import { DOCUMENT_PATCH_REFERENCE } from "./document-patch-reference";

import {
  DocumentColumnCountSchema,
  DocumentCitationStyleNameSchema,
  DocumentLayoutPresetSchema,
  DocumentPageSizeSchema,
  DocumentPatchSchema,
  DocumentSchema,
  type DocumentModel,
  type DocumentPatch,
} from "./document-contract";
import {
  toolLoopDocumentApproval,
  workflowNeedsApproval,
} from "./policy";
import { serializableToolSchema } from "./language-model";

const gatewayTools = gateway.tools;

export const SearchSourcesInputSchema = z
  .object({
    query: z.union([
      z.string().trim().min(1).max(500),
      z.array(z.string().trim().min(1).max(500)).min(1).max(3),
    ]),
  })
  .strict();

function createSearchSourcesTool() {
  const providerTool = gatewayTools.perplexitySearch({
    maxResults: 5,
    maxTokensPerPage: 768,
    maxTokens: 6_000,
  });
  // Perplexity's runtime input also accepts max_results/max_tokens overrides.
  // Replace that schema so only the fixed server-side args above are usable.
  return {
    ...providerTool,
    inputSchema: SearchSourcesInputSchema,
  };
}

export const DocumentToolContextSchema = z
  .object({
    documentId: z.string().uuid(),
    runId: z.string().min(1).max(200),
    actorId: z.string().min(1).max(200),
  })
  .strict();

export type DocumentToolContext = z.infer<typeof DocumentToolContextSchema>;

/**
 * Stable execution metadata supplied by AI SDK for one model response. The
 * message list is identical for tool calls emitted in the same response and
 * grows between agent turns, allowing durable steps to serialize mutations by
 * response without trusting model-provided fields.
 */
export type DocumentToolExecution = {
  toolCallId: string;
  messages: ModelMessage[];
};

export const ReadDocumentInputSchema = z
  .object({
    revision: z.number().int().nonnegative().optional(),
  })
  .strict();

export const ApplyDocumentPatchInputSchema = z
  .object({
    patch: DocumentPatchSchema,
    summary: z.string().min(1).max(500),
  })
  .strict();

/**
 * Model-facing schema for apply_document_patch. The zod-derived JSON Schema
 * inlines the recursive node/math AST into ~130KB (~110k tokens) — resent
 * on every agent step, it dominates the run's token budget and empirically
 * pushes smaller writer models into degenerate read loops. The model gets
 * this compact grammar plus DOCUMENT_PATCH_REFERENCE in the description;
 * ApplyDocumentPatchInputSchema stays the execution-time validation gate,
 * and zod errors return as repairable tool errors.
 */
const ApplyDocumentPatchModelInputSchema = jsonSchema<
  z.infer<typeof ApplyDocumentPatchInputSchema>
>(
  {
    type: "object",
    additionalProperties: false,
    required: ["patch", "summary"],
    properties: {
      patch: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "documentId",
          "baseRevision",
          "createdAt",
          "operations",
        ],
        properties: {
          id: { type: "string", description: "新しいUUID" },
          documentId: { type: "string" },
          baseRevision: {
            type: "integer",
            minimum: 0,
            description: "read_documentで読んだ最新revision",
          },
          createdAt: { type: "string", description: "ISO 8601" },
          operations: {
            type: "array",
            minItems: 1,
            maxItems: 1000,
            items: {
              type: "object",
              description:
                "insert/update/move/delete/setMetadata。形はツール説明のリファレンスに従う",
              required: ["op"],
              properties: {
                op: {
                  type: "string",
                  enum: ["insert", "update", "move", "delete", "setMetadata"],
                },
              },
              additionalProperties: true,
            },
          },
        },
      },
      summary: {
        type: "string",
        minLength: 1,
        maxLength: 500,
        description: "この編集の一文要約",
      },
    },
  },
  {
    validate: (value) => {
      const parsed = ApplyDocumentPatchInputSchema.safeParse(value);
      return parsed.success
        ? { success: true, value: parsed.data }
        : { success: false, error: parsed.error };
    },
  },
);

export const CheckDocumentInputSchema = z
  .object({
    revision: z.number().int().nonnegative().optional(),
    checks: z
      .array(z.enum(["structure", "references"]))
      .min(1)
      .max(2)
      .default(["structure", "references"]),
  })
  .strict();

export const FormatDocumentInputSchema = z
  .object({
    baseRevision: z.number().int().nonnegative(),
    preset: DocumentLayoutPresetSchema,
    pageSize: DocumentPageSizeSchema.optional(),
    columns: DocumentColumnCountSchema.optional(),
    citationStyle: DocumentCitationStyleNameSchema.optional(),
  })
  .strict();

export const RequestInputInputSchema = z
  .object({
    question: z.string().trim().min(1).max(500),
  })
  .strict();

export const ResolveSourceInputSchema = z
  .object({
    locator: z.string().trim().min(1).max(4_096),
  })
  .strict();

export const ResolvedSourceMetadataSchema = z
  .object({
    authors: z.array(z.string().min(1).max(1_000)).min(1).max(100),
    title: z.string().min(1).max(1_000),
    year: z.string().regex(/^\d{4}[a-z]?$/),
    publication: z.string().min(1).max(1_000).optional(),
    publisher: z.string().min(1).max(1_000).optional(),
    volume: z.string().min(1).max(1_000).optional(),
    issue: z.string().min(1).max(1_000).optional(),
    pages: z.string().min(1).max(1_000).optional(),
    sourceType: z
      .enum([
        "journal_article",
        "proceedings_article",
        "book",
        "book_chapter",
        "report",
        "thesis",
        "web",
        "other",
      ])
      .optional(),
    sourceLanguage: z
      .string()
      .regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/)
      .optional(),
    doi: z.string().min(1).max(1_000).optional(),
    url: z.string().url().max(2_000).optional(),
  })
  .strict();

const ResolvedSourceResultSchema = z
  .object({
    status: z.literal("resolved"),
    sourceId: z.string().uuid(),
    canonicalLocator: z.string().url().max(2_048),
    metadata: ResolvedSourceMetadataSchema.nullable(),
    evidenceScope: z.enum(["full_text", "abstract", "none"]),
    excerpt: z.string().max(12_000).nullable(),
    contentSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    usableForClaims: z.boolean(),
    citationReady: z.boolean(),
  })
  .strict()
  .superRefine((result, context) => {
    if (
      result.usableForClaims &&
      (result.evidenceScope === "none" ||
        result.excerpt === null ||
        result.contentSha256 === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["usableForClaims"],
        message: "Claim-usable sources require bounded evidence and a digest.",
      });
    }
    if (
      !result.usableForClaims &&
      (result.excerpt !== null || result.contentSha256 !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["usableForClaims"],
        message: "Unusable sources cannot expose evidence content.",
      });
    }
    if (
      result.citationReady &&
      (!result.usableForClaims || result.metadata === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["citationReady"],
        message: "Citation-ready sources require usable evidence and metadata.",
      });
    }
  });

const UnavailableSourceResultSchema = z
  .object({
    status: z.literal("unavailable"),
    message: z.literal(
      "資料を確認できませんでした。別の候補を選んでください。",
    ),
  })
  .strict();

export const ResolveSourceResultSchema = z.discriminatedUnion("status", [
  ResolvedSourceResultSchema,
  UnavailableSourceResultSchema,
]);

export type ResolveSourceResult = z.infer<typeof ResolveSourceResultSchema>;

export const DeleteDocumentInputSchema = z
  .object({
    reason: z.string().min(1).max(500),
  })
  .strict();

export const PublishDocumentInputSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    visibility: z.enum(["private_link", "public"]),
  })
  .strict();

export const RunExpensiveTaskInputSchema = z
  .object({
    task: z.enum([
      "deep_research",
      "full_document_rewrite",
      "visual_quality_review",
      "bulk_citation_check",
    ]),
    objective: z.string().min(1).max(2_000),
  })
  .strict();

export const DocumentMutationResultSchema = z
  .object({
    ok: z.literal(true),
    revision: z.number().int().nonnegative(),
    summary: z.string().min(1).max(1_000),
  })
  .strict();

export type DocumentMutationResult = z.infer<
  typeof DocumentMutationResultSchema
>;

export const DocumentCheckResultSchema = z
  .object({
    ok: z.boolean(),
    revision: z.number().int().nonnegative(),
    issues: z
      .array(
        z
          .object({
            code: z.string().min(1).max(100),
            message: z.string().min(1).max(1_000),
            nodeId: z.string().uuid().optional(),
          })
          .strict(),
      )
      .max(1_000),
  })
  .strict();

export type DocumentCheckResult = z.infer<typeof DocumentCheckResultSchema>;

export const PublicationResultSchema = z
  .object({
    ok: z.literal(true),
    revision: z.number().int().nonnegative(),
    url: z.string().url(),
  })
  .strict();

export type PublicationResult = z.infer<typeof PublicationResultSchema>;

export const ExpensiveTaskResultSchema = z
  .object({
    ok: z.literal(true),
    summary: z.string().min(1).max(2_000),
    suggestedPatch: DocumentPatchSchema.optional(),
  })
  .strict();

export type ExpensiveTaskResult = z.infer<typeof ExpensiveTaskResultSchema>;

type MaybePromise<T> = T | PromiseLike<T>;

export interface DocumentToolHandlers {
  /**
   * Workflow callers should implement mutating handlers as module-level
   * functions containing `use step` so executions are durable and retryable.
   */
  readDocument(
    input: z.infer<typeof ReadDocumentInputSchema>,
    context: DocumentToolContext,
  ): MaybePromise<DocumentModel>;
  applyDocumentPatch(
    input: z.infer<typeof ApplyDocumentPatchInputSchema>,
    context: DocumentToolContext,
    execution?: DocumentToolExecution,
  ): MaybePromise<DocumentMutationResult>;
  checkDocument(
    input: z.infer<typeof CheckDocumentInputSchema>,
    context: DocumentToolContext,
  ): MaybePromise<DocumentCheckResult>;
  formatDocument(
    input: z.infer<typeof FormatDocumentInputSchema>,
    context: DocumentToolContext,
    execution?: DocumentToolExecution,
  ): MaybePromise<DocumentMutationResult>;
  requestInput(
    input: z.infer<typeof RequestInputInputSchema>,
    context: DocumentToolContext,
    execution?: DocumentToolExecution,
  ): MaybePromise<{ ok: true }>;
  resolveSource(
    input: z.infer<typeof ResolveSourceInputSchema>,
    context: DocumentToolContext,
    execution?: DocumentToolExecution,
  ): MaybePromise<ResolveSourceResult>;
  deleteDocument(
    input: z.infer<typeof DeleteDocumentInputSchema>,
    context: DocumentToolContext,
    execution?: DocumentToolExecution,
  ): MaybePromise<{ ok: true }>;
  publishDocument(
    input: z.infer<typeof PublishDocumentInputSchema>,
    context: DocumentToolContext,
    execution?: DocumentToolExecution,
  ): MaybePromise<PublicationResult>;
  runExpensiveTask(
    input: z.infer<typeof RunExpensiveTaskInputSchema>,
    context: DocumentToolContext,
    execution?: DocumentToolExecution,
  ): MaybePromise<ExpensiveTaskResult>;
}

export type DocumentWorkflowApprovalMode =
  | "workflow_suspend"
  | "external_run";

export interface CreateDocumentToolsOptions {
  /**
   * Suspending approval is only safe after its response API is connected.
   * External-run mode leaves approval persistence to the durable handlers.
   * @default "external_run"
   */
  approvalMode?: DocumentWorkflowApprovalMode;
}

function assertDocumentScope(
  patch: DocumentPatch,
  context: DocumentToolContext,
): void {
  if (patch.documentId !== context.documentId) {
    throw new Error("Document patch is outside the active document scope");
  }
}

/**
 * Shared AI SDK tool set. WorkflowAgent reads `needsApproval`; ToolLoopAgent
 * uses the exported `documentToolLoopApproval` policy below.
 */
export function createDocumentTools(
  handlers: DocumentToolHandlers,
  options: CreateDocumentToolsOptions = {},
) {
  const usesWorkflowSuspension =
    (options.approvalMode ?? "external_run") === "workflow_suspend";

  return {
    read_document: tool({
      description:
        "現在の構造化文書を読み取る。生成ソースや内部ファイルは返さない。",
      inputSchema: serializableToolSchema(ReadDocumentInputSchema),
      outputSchema: DocumentSchema,
      contextSchema: DocumentToolContextSchema,
      execute: (input, { context }) => handlers.readDocument(input, context),
    }),

    search_sources: createSearchSourcesTool(),

    resolve_source: tool({
      description:
        "検索候補またはユーザーが示したHTTPS URL・DOIを安全に取得し、引用可能性と正規化済み書誌情報を返す。検索snippetだけでは引用できないため、引用前に必ず実行する。",
      inputSchema: serializableToolSchema(ResolveSourceInputSchema),
      outputSchema: ResolveSourceResultSchema,
      contextSchema: DocumentToolContextSchema,
      execute: (input, { context, toolCallId, messages }) =>
        handlers.resolveSource(input, context, { toolCallId, messages }),
    }),

    apply_document_patch: tool({
      description:
        "安定IDを保持した意味的な文書パッチを適用する。TeXや生成ファイルは扱わない。\n\n" +
        DOCUMENT_PATCH_REFERENCE,
      inputSchema: ApplyDocumentPatchModelInputSchema,
      outputSchema: DocumentMutationResultSchema,
      contextSchema: DocumentToolContextSchema,
      needsApproval: usesWorkflowSuspension
        ? (input) => workflowNeedsApproval("apply_document_patch", input)
        : false,
      execute: (input, { context, toolCallId, messages }) => {
        assertDocumentScope(input.patch, context);
        return handlers.applyDocumentPatch(input, context, {
          toolCallId,
          messages,
        });
      },
    }),

    check_document: tool({
      description:
        "文書モデルの構造、参照先の存在、引用と参考文献のID対応を検証する。文章の品質、主張の事実性、出典内容、紙面の見た目は検証しない。",
      inputSchema: serializableToolSchema(CheckDocumentInputSchema),
      outputSchema: DocumentCheckResultSchema,
      contextSchema: DocumentToolContextSchema,
      execute: (input, { context }) => handlers.checkDocument(input, context),
    }),

    format_document: tool({
      description:
        "文書全体の体裁を、標準・学術・ビジネス・コンパクトの安全なプリセット、用紙、段組、引用形式へ整える。内容や生成ソースは変更しない。",
      inputSchema: serializableToolSchema(FormatDocumentInputSchema),
      outputSchema: DocumentMutationResultSchema,
      contextSchema: DocumentToolContextSchema,
      execute: (input, { context, toolCallId, messages }) =>
        handlers.formatDocument(input, context, { toolCallId, messages }),
    }),

    request_input: tool({
      description:
        "回答によって文書の内容が大きく変わる場合に限り、作業を止めて最重要の質問を一つだけ尋ねる。",
      inputSchema: serializableToolSchema(RequestInputInputSchema),
      outputSchema: z.object({ ok: z.literal(true) }).strict(),
      contextSchema: DocumentToolContextSchema,
      execute: (input, { context, toolCallId, messages }) =>
        handlers.requestInput(input, context, { toolCallId, messages }),
    }),

    delete_document: tool({
      description: "現在の文書全体を削除する。必ずユーザー承認を受ける。",
      inputSchema: serializableToolSchema(DeleteDocumentInputSchema),
      outputSchema: z.object({ ok: z.literal(true) }).strict(),
      contextSchema: DocumentToolContextSchema,
      needsApproval: usesWorkflowSuspension,
      execute: (input, { context, toolCallId, messages }) =>
        handlers.deleteDocument(input, context, { toolCallId, messages }),
    }),

    publish_document: tool({
      description: "確定した文書版を公開する。必ずユーザー承認を受ける。",
      inputSchema: serializableToolSchema(PublishDocumentInputSchema),
      outputSchema: PublicationResultSchema,
      contextSchema: DocumentToolContextSchema,
      needsApproval: usesWorkflowSuspension,
      execute: (input, { context, toolCallId, messages }) =>
        handlers.publishDocument(input, context, { toolCallId, messages }),
    }),

    run_expensive_task: tool({
      description:
        "深い調査、全文改稿、全ページ視覚検査など高コスト処理を行う。必ずユーザー承認を受ける。",
      inputSchema: serializableToolSchema(RunExpensiveTaskInputSchema),
      outputSchema: ExpensiveTaskResultSchema,
      contextSchema: DocumentToolContextSchema,
      needsApproval: usesWorkflowSuspension,
      execute: (input, { context, toolCallId, messages }) =>
        handlers.runExpensiveTask(input, context, { toolCallId, messages }),
    }),
  } as const;
}

export type DocumentTools = ReturnType<typeof createDocumentTools>;

export const documentToolLoopApproval = toolLoopDocumentApproval;

export function createDocumentToolLoopSettings(
  handlers: DocumentToolHandlers,
) {
  return {
    tools: createDocumentTools(handlers),
    toolApproval: documentToolLoopApproval,
  } as const;
}

export function createDocumentToolsContext(context: DocumentToolContext) {
  const parsed = DocumentToolContextSchema.parse(context);
  return {
    read_document: parsed,
    resolve_source: parsed,
    apply_document_patch: parsed,
    check_document: parsed,
    format_document: parsed,
    request_input: parsed,
    delete_document: parsed,
    publish_document: parsed,
    run_expensive_task: parsed,
  } satisfies Record<
    Exclude<keyof DocumentTools, "search_sources">,
    DocumentToolContext
  >;
}
