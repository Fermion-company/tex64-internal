import { gateway } from "@ai-sdk/gateway";
import { jsonSchema, tool } from "ai";
import { z } from "zod";

import { DOCUMENT_PATCH_REFERENCE } from "./document-patch-reference";

import {
  DocumentColumnCountSchema,
  DocumentCitationStyleNameSchema,
  DocumentLayoutPresetSchema,
  DocumentPageSizeSchema,
  DocumentPatchSchema,
  DocumentSchema,
} from "./document-contract";
import { serializableToolSchema } from "./language-model";
import {
  ToolError,
  applyDocumentPatchTool,
  checkDocument,
  compileDocument,
  formatDocument,
  readDocument,
  resolveSourceTool,
  type ToolScope,
} from "./tool-handlers";

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

// No revision parameter: the agent works on the current document, and an
// invented revision number was just a way for a turn to fail.
export const ReadDocumentInputSchema = z.object({}).strict();

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

export const CheckDocumentInputSchema = z.object({}).strict();

export const FormatDocumentInputSchema = z
  .object({
    baseRevision: z.number().int().nonnegative(),
    preset: DocumentLayoutPresetSchema,
    pageSize: DocumentPageSizeSchema.optional(),
    columns: DocumentColumnCountSchema.optional(),
    citationStyle: DocumentCitationStyleNameSchema.optional(),
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

export const CompileDocumentResultSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      revision: z.number().int().positive(),
      pageCount: z.number().int().positive(),
      warningCount: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      revision: z.number().int().positive(),
      code: z.string().min(1).max(100),
      issueCount: z.number().int().nonnegative(),
      diagnostics: z
        .array(
          z
            .object({
              code: z.string().min(1).max(100),
              message: z.string().min(1).max(2_000),
              line: z.number().int().nonnegative().optional(),
            })
            .strict(),
        )
        .max(50)
        .optional(),
    })
    .strict(),
]);

export type CompileDocumentResult = z.infer<typeof CompileDocumentResultSchema>;

export type ReadDocumentInput = z.infer<typeof ReadDocumentInputSchema>;
export type CheckDocumentInput = z.infer<typeof CheckDocumentInputSchema>;
export type FormatDocumentInput = z.infer<typeof FormatDocumentInputSchema>;
export type ResolveSourceInput = z.infer<typeof ResolveSourceInputSchema>;
export type ApplyDocumentPatchInput = z.infer<
  typeof ApplyDocumentPatchInputSchema
>;

/**
 * The agent's tool set, bound to one turn. Every tool acts on the live
 * document, and every failure comes back as a message the model can read and
 * repair — there is no approval step and no out-of-band question channel.
 */
export function createDocumentTools(scope: ToolScope) {
  return {
    read_document: tool({
      description:
        "現在の構造化文書を読み取る。生成ソースや内部ファイルは返さない。",
      inputSchema: serializableToolSchema(ReadDocumentInputSchema),
      outputSchema: DocumentSchema,
      execute: () => readDocument(scope),
    }),

    search_sources: createSearchSourcesTool(),

    resolve_source: tool({
      description:
        "検索候補またはユーザーが示したHTTPS URL・DOIを安全に取得し、引用可能性と正規化済み書誌情報を返す。検索snippetだけでは引用できないため、引用前に必ず実行する。",
      inputSchema: serializableToolSchema(ResolveSourceInputSchema),
      outputSchema: ResolveSourceResultSchema,
      execute: (input, { messages }) =>
        resolveSourceTool(input, scope, messages),
    }),

    apply_document_patch: tool({
      description:
        "安定IDを保持した意味的な文書パッチを適用する。TeXや生成ファイルは扱わない。\n\n" +
        DOCUMENT_PATCH_REFERENCE,
      inputSchema: ApplyDocumentPatchModelInputSchema,
      outputSchema: DocumentMutationResultSchema,
      execute: (input) => {
        if (input.patch.documentId !== scope.documentId) {
          throw new ToolError("この文書には変更を適用できません。");
        }
        return applyDocumentPatchTool(input, scope);
      },
    }),

    check_document: tool({
      description:
        "文書モデルの構造、参照先の存在、引用と参考文献のID対応を検証する。文章の品質、主張の事実性、出典内容、紙面の見た目は検証しない。",
      inputSchema: serializableToolSchema(CheckDocumentInputSchema),
      outputSchema: DocumentCheckResultSchema,
      execute: () => checkDocument(scope),
    }),

    format_document: tool({
      description:
        "文書全体の体裁を、標準・学術・ビジネス・コンパクトの安全なプリセット、用紙、段組、引用形式へ整える。内容や生成ソースは変更しない。",
      inputSchema: serializableToolSchema(FormatDocumentInputSchema),
      outputSchema: DocumentMutationResultSchema,
      execute: (input) => formatDocument(input, scope),
    }),

    compile_document: tool({
      description:
        "現在の文書を組版してPDFを更新し、ページ数と警告数、失敗時は組版の指摘を返す。書き終えたときと、体裁や分量を自分で確かめたいときに実行する。",
      inputSchema: serializableToolSchema(z.object({}).strict()),
      outputSchema: CompileDocumentResultSchema,
      execute: () => compileDocument(scope),
    }),
  } as const;
}

export type DocumentTools = ReturnType<typeof createDocumentTools>;
