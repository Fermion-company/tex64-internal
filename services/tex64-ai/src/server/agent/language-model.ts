import { createOpenAI } from "@ai-sdk/openai";
import { asSchema, jsonSchema, type Schema } from "@ai-sdk/provider-utils";
import type { LanguageModel } from "ai";
import type { z } from "zod";

import { hasVercelRuntimeSignal } from "@/server/config/runtime-environment";

/**
 * Chooses the transport behind the agent runtime's model string.
 *
 * The canonical path is the Vercel AI Gateway: a plain `provider/model`
 * string resolves through the AI SDK's gateway provider using gateway
 * credentials (API key or OIDC). For local development without gateway
 * credentials, a plain OPENAI_API_KEY drives the same `openai/...` model ids
 * directly against the OpenAI API. Gateway-only affordances (the
 * search_sources provider tool, PDF visual review) degrade explicitly via
 * usesDirectOpenAiTransport().
 */
export function usesDirectOpenAiTransport(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const hasGatewayIdentity = Boolean(
    environment.AI_GATEWAY_API_KEY?.trim() ||
      environment.VERCEL_OIDC_TOKEN?.trim() ||
      hasVercelRuntimeSignal(environment),
  );
  return !hasGatewayIdentity && Boolean(environment.OPENAI_API_KEY?.trim());
}

const OPENAI_MODEL_PREFIX = "openai/";

/**
 * The direct transport keeps model references as PLAIN STRINGS everywhere —
 * the durable workflow serializes models across step boundaries and can
 * rehydrate strings but not provider instances. Instead, the AI SDK's global
 * default provider (consulted wherever a string model resolves, in every
 * bundle world that imports this module) maps `openai/...` ids straight to
 * the OpenAI API.
 */
let directProviderInstalled = false;

function ensureDirectOpenAiProvider(): void {
  if (directProviderInstalled || !usesDirectOpenAiTransport()) return;
  const openaiProvider = createOpenAI({
    apiKey: process.env.OPENAI_API_KEY?.trim(),
  });
  const strip = (modelId: string): string =>
    modelId.startsWith(OPENAI_MODEL_PREFIX)
      ? modelId.slice(OPENAI_MODEL_PREFIX.length)
      : modelId;
  (globalThis as { AI_SDK_DEFAULT_PROVIDER?: unknown }).AI_SDK_DEFAULT_PROVIDER =
    {
      languageModel: (modelId: string) =>
        openaiProvider.languageModel(strip(modelId)),
      textEmbeddingModel: (modelId: string) =>
        openaiProvider.textEmbeddingModel(strip(modelId)),
      imageModel: (modelId: string) => openaiProvider.imageModel(strip(modelId)),
    };
  // The durable-agent stream step (@ai-sdk/workflow doStreamStep) resolves
  // string model ids through the gateway singleton directly, bypassing the
  // global default provider; patches/@ai-sdk+workflow makes it consult
  // globalThis.AI_SDK_DEFAULT_PROVIDER first, which is process-wide and
  // therefore reaches every bundle world.
  directProviderInstalled = true;
}
ensureDirectOpenAiProvider();

export function agentLanguageModel(model: string): LanguageModel {
  ensureDirectOpenAiProvider();
  return model;
}

/**
 * Structured extraction/planning/review calls are few and small but schema-
 * heavy; TEX64_AI_STRUCTURED_MODEL lets them run on a steadier tier while
 * the writer keeps the cheaper default. Unset = same model everywhere.
 */
export function structuredAgentModel(fallback: string): string {
  return process.env.TEX64_AI_STRUCTURED_MODEL?.trim() || fallback;
}

/**
 * Build-graph-independent structured-output reader. Some server bundles
 * leave `result.output` unset even though the model returned valid JSON
 * (generateText only parses output when its internal finishReason is the
 * string "stop", which compatibility-wrapped providers do not always
 * produce). The raw text is then the source of truth.
 */
export function agentOutputJson(result: {
  output?: unknown;
  text?: string;
}): unknown {
  try {
    if (result.output !== undefined && result.output !== null) {
      return result.output;
    }
  } catch {
    // result.output is a throwing getter on builds that skipped parsing.
  }
  const text = (result.text ?? "")
    .trim()
    .replace(/^```(?:json)?\s*/u, "")
    .replace(/\s*```$/u, "");
  return JSON.parse(text);
}

function stripJsonSchemaFormats(node: unknown): void {
  if (Array.isArray(node)) {
    for (const entry of node) stripJsonSchemaFormats(entry);
    return;
  }
  if (!node || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  // Only a string-valued `format` is the JSON Schema annotation; an object
  // under the same key is a user property named "format" inside `properties`.
  if (typeof record.format === "string") delete record.format;
  for (const value of Object.values(record)) stripJsonSchemaFormats(value);
}

/**
 * Durable-agent tools cross workflow step boundaries as plain JSON Schema
 * and are re-validated there by a bare Ajv instance, which hard-fails on
 * `format` annotations (zod emits `format: "uuid"` etc.). Serialize the
 * schema without formats while keeping the zod schema as the actual
 * validation gate on this side of the boundary.
 */
export function serializableToolSchema<SCHEMA extends z.ZodType>(
  schema: SCHEMA,
): Schema<z.output<SCHEMA>> {
  const converted = structuredClone(asSchema(schema).jsonSchema);
  stripJsonSchemaFormats(converted);
  return jsonSchema<z.output<SCHEMA>>(converted, {
    validate: (value) => {
      const parsed = schema.safeParse(value);
      return parsed.success
        ? { success: true, value: parsed.data }
        : { success: false, error: parsed.error };
    },
  });
}

/**
 * OpenAI's strict structured-output grammar rejects constructs zod's
 * discriminated unions produce (`oneOf`, optional-property layouts), which
 * the AI Gateway normalizes away. On the direct transport, non-strict
 * json_schema keeps the schema as model guidance while zod remains the
 * actual validation gate downstream. Applies to tool schemas too.
 */
export function agentProviderOptions():
  | { openai: { strictJsonSchema: false } }
  | undefined {
  return usesDirectOpenAiTransport()
    ? { openai: { strictJsonSchema: false } }
    : undefined;
}
