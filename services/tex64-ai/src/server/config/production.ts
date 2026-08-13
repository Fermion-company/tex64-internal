import {
  hasVercelRuntimeSignal,
  isProductionRuntime,
  type RuntimeEnvironment,
} from "./runtime-environment";

const DEFAULT_IDENTITY_RUNS_PER_HOUR = 20;
const DEFAULT_NETWORK_RUNS_PER_HOUR = 40;
const MAX_CONFIGURED_RUNS_PER_HOUR = 100_000;

export type AgentRunQuotaConfiguration = {
  identityRunsPerHour: number;
  networkRunsPerHour: number;
  globalRunsPerHour: number;
};

export class ProductionConfigurationError extends Error {
  constructor(message = "Production configuration is incomplete or unsafe.") {
    super(message);
    this.name = "ProductionConfigurationError";
  }
}

/**
 * Validate every paid-runtime dependency before a mutation can create durable
 * state. Local development and tests intentionally keep their zero-config path.
 */
export function assertProductionMutationReady(
  environment: RuntimeEnvironment = process.env,
): AgentRunQuotaConfiguration {
  if (
    environment.NODE_ENV === "production" &&
    environment.WORKFLOW_TARGET_WORLD === "local"
  ) {
    throw new ProductionConfigurationError(
      "The local Workflow world is forbidden at a production HTTP boundary.",
    );
  }
  if (!isProductionRuntime(environment)) {
    return localQuotaConfiguration(environment);
  }

  if (environment.WORKFLOW_TARGET_WORLD === "local") {
    throw new ProductionConfigurationError(
      "The local Workflow world is forbidden in production.",
    );
  }

  requireSecret(environment.TEX64_SESSION_SECRET, "TEX64_SESSION_SECRET");
  requirePostgresUrl(environment.DATABASE_URL);
  requireModel(environment.TEX64_AI_MODEL);
  if (!hasVercelRuntimeSignal(environment)) {
    requireNonEmpty(environment.AI_GATEWAY_API_KEY, "AI_GATEWAY_API_KEY");
    requireNonEmpty(environment.BLOB_READ_WRITE_TOKEN, "BLOB_READ_WRITE_TOKEN");
    requireNonEmpty(environment.VERCEL_TOKEN, "VERCEL_TOKEN");
    requireNonEmpty(environment.VERCEL_TEAM_ID, "VERCEL_TEAM_ID");
    requireNonEmpty(environment.VERCEL_PROJECT_ID, "VERCEL_PROJECT_ID");
  }
  requireNonEmpty(environment.TEX64_SANDBOX_IMAGE, "TEX64_SANDBOX_IMAGE");

  const compiler = environment.TEX64_COMPILER?.trim() || "auto";
  if (compiler !== "auto" && compiler !== "sandbox") {
    throw new ProductionConfigurationError(
      "TEX64_COMPILER must use isolated sandbox compilation in production.",
    );
  }

  if (environment.TEX64_ALLOW_ANONYMOUS_PRODUCTION !== "true") {
    throw new ProductionConfigurationError(
      "Anonymous production access requires an explicit operator opt-in.",
    );
  }
  if (
    !hasVercelRuntimeSignal(environment) &&
    !/^[a-z0-9-]{1,100}$/.test(
      environment.TEX64_TRUSTED_CLIENT_IP_HEADER?.trim().toLowerCase() ?? "",
    )
  ) {
    throw new ProductionConfigurationError(
      "TEX64_TRUSTED_CLIENT_IP_HEADER is required outside Vercel.",
    );
  }

  return {
    identityRunsPerHour: optionalPositiveInteger(
      environment.TEX64_IDENTITY_RUNS_PER_HOUR,
      "TEX64_IDENTITY_RUNS_PER_HOUR",
      DEFAULT_IDENTITY_RUNS_PER_HOUR,
    ),
    networkRunsPerHour: optionalPositiveInteger(
      environment.TEX64_NETWORK_RUNS_PER_HOUR,
      "TEX64_NETWORK_RUNS_PER_HOUR",
      DEFAULT_NETWORK_RUNS_PER_HOUR,
    ),
    globalRunsPerHour: requiredPositiveInteger(
      environment.TEX64_GLOBAL_RUNS_PER_HOUR,
      "TEX64_GLOBAL_RUNS_PER_HOUR",
    ),
  };
}

function localQuotaConfiguration(
  environment: RuntimeEnvironment,
): AgentRunQuotaConfiguration {
  return {
    identityRunsPerHour: optionalPositiveInteger(
      environment.TEX64_IDENTITY_RUNS_PER_HOUR,
      "TEX64_IDENTITY_RUNS_PER_HOUR",
      DEFAULT_IDENTITY_RUNS_PER_HOUR,
    ),
    networkRunsPerHour: optionalPositiveInteger(
      environment.TEX64_NETWORK_RUNS_PER_HOUR,
      "TEX64_NETWORK_RUNS_PER_HOUR",
      DEFAULT_NETWORK_RUNS_PER_HOUR,
    ),
    globalRunsPerHour: optionalPositiveInteger(
      environment.TEX64_GLOBAL_RUNS_PER_HOUR,
      "TEX64_GLOBAL_RUNS_PER_HOUR",
      MAX_CONFIGURED_RUNS_PER_HOUR,
    ),
  };
}

function requireSecret(value: string | undefined, name: string): string {
  const normalized = requireNonEmpty(value, name);
  if (
    normalized.length < 32 ||
    normalized.includes("<") ||
    /local-development|change-me|placeholder/i.test(normalized)
  ) {
    throw new ProductionConfigurationError(`${name} is not a production secret.`);
  }
  return normalized;
}

function requirePostgresUrl(value: string | undefined): void {
  const normalized = requireNonEmpty(value, "DATABASE_URL");
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new ProductionConfigurationError("DATABASE_URL is invalid.");
  }
  if (!new Set(["postgres:", "postgresql:"]).has(parsed.protocol)) {
    throw new ProductionConfigurationError("DATABASE_URL must use PostgreSQL.");
  }
}

function requireModel(value: string | undefined): void {
  const normalized = requireNonEmpty(value, "TEX64_AI_MODEL");
  if (!/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:/-]*$/i.test(normalized)) {
    throw new ProductionConfigurationError("TEX64_AI_MODEL is invalid.");
  }
}

function requireNonEmpty(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new ProductionConfigurationError(`${name} is required.`);
  return normalized;
}

function optionalPositiveInteger(
  value: string | undefined,
  name: string,
  fallback: number,
): number {
  return value?.trim() ? requiredPositiveInteger(value, name) : fallback;
}

function requiredPositiveInteger(value: string | undefined, name: string): number {
  const normalized = value?.trim();
  if (!normalized || !/^[1-9]\d*$/.test(normalized)) {
    throw new ProductionConfigurationError(`${name} must be a positive integer.`);
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed > MAX_CONFIGURED_RUNS_PER_HOUR) {
    throw new ProductionConfigurationError(`${name} is outside the supported range.`);
  }
  return parsed;
}
