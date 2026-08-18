import { hasVercelRuntimeSignal } from "@/server/config/runtime-environment";

export type AgentRuntimeSelection = {
  provider: "ai_gateway";
  model: string;
};

/**
 * User-facing copy for the missing-model configuration failure, shown in the
 * conversation so the fix is obvious instead of a generic error.
 */
export const AGENT_RUNTIME_UNCONFIGURED_MESSAGE =
  "AIモデルが設定されていません。OPENAI_API_KEY か TEX64_AI_MODEL を設定してください。";

export class AgentRuntimeConfigurationError extends Error {
  constructor() {
    super(AGENT_RUNTIME_UNCONFIGURED_MESSAGE);
    this.name = "AgentRuntimeConfigurationError";
  }
}

/**
 * Vercel Functions can provide workload identity to the AI SDK through the
 * request context, so a persisted token is not required there. A plain
 * OPENAI_API_KEY also selects the real runtime; the provider literal stays
 * "ai_gateway" and agentLanguageModel() picks the transport per call.
 *
 * There is no deterministic fallback engine: without a configured model every
 * turn fails with the message above rather than faking a document.
 */
export function selectAgentRuntime(
  environment: Readonly<Record<string, string | undefined>>,
): AgentRuntimeSelection {
  const model = environment.TEX64_AI_MODEL?.trim();
  const hasGatewayIdentity = Boolean(
    environment.AI_GATEWAY_API_KEY?.trim() ||
      environment.VERCEL_OIDC_TOKEN?.trim(),
  );
  if (
    model &&
    (hasGatewayIdentity ||
      hasVercelRuntimeSignal(environment) ||
      Boolean(environment.OPENAI_API_KEY?.trim()))
  ) {
    return { provider: "ai_gateway", model };
  }
  throw new AgentRuntimeConfigurationError();
}

export function resolveAgentRuntimeFromProcessEnvironment(): AgentRuntimeSelection {
  return selectAgentRuntime({
    AI_GATEWAY_API_KEY: process.env.AI_GATEWAY_API_KEY,
    VERCEL_OIDC_TOKEN: process.env.VERCEL_OIDC_TOKEN,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    TEX64_AI_MODEL: process.env.TEX64_AI_MODEL,
    NODE_ENV: process.env.NODE_ENV,
    TEX64_LOCAL_DEVELOPMENT: process.env.TEX64_LOCAL_DEVELOPMENT,
    VERCEL: process.env.VERCEL,
    VERCEL_ENV: process.env.VERCEL_ENV,
    VERCEL_DEPLOYMENT_ID: process.env.VERCEL_DEPLOYMENT_ID,
  });
}
