import { describe, expect, it } from "vitest";
import {
  ProductionConfigurationError,
  assertProductionMutationReady,
} from "@/server/config/production";

const VALID_PRODUCTION = {
  NODE_ENV: "production",
  VERCEL: "1",
  WORKFLOW_TARGET_WORLD: "vercel",
  TEX64_SESSION_SECRET: "a-production-secret-with-at-least-32-characters",
  DATABASE_URL: "postgresql://app:password@db.example/tex64",
  TEX64_AI_MODEL: "openai/gpt-5.6-sol",
  TEX64_SANDBOX_IMAGE: "tex64-texlive:latest",
  TEX64_COMPILER: "auto",
  TEX64_ALLOW_ANONYMOUS_PRODUCTION: "true",
  TEX64_GLOBAL_RUNS_PER_HOUR: "100",
} as const;

describe("production mutation preflight", () => {
  it("keeps local and Workflow-local development zero-config", () => {
    expect(assertProductionMutationReady({ NODE_ENV: "development" })).toMatchObject({
      identityRunsPerHour: 20,
      networkRunsPerHour: 40,
    });
    expect(() =>
      assertProductionMutationReady({
        NODE_ENV: "production",
        WORKFLOW_TARGET_WORLD: "local",
        TEX64_LOCAL_DEVELOPMENT: "true",
      }),
    ).toThrow(ProductionConfigurationError);
  });

  it("accepts a complete hosted configuration", () => {
    expect(assertProductionMutationReady(VALID_PRODUCTION)).toEqual({
      identityRunsPerHour: 20,
      networkRunsPerHour: 40,
      globalRunsPerHour: 100,
    });
  });

  it("accepts hosted runtime OIDC without a persisted token", () => {
    expect(
      assertProductionMutationReady({
        ...VALID_PRODUCTION,
        VERCEL_OIDC_TOKEN: undefined,
        AI_GATEWAY_API_KEY: undefined,
        BLOB_READ_WRITE_TOKEN: undefined,
      }),
    ).toBeDefined();
  });

  it("never lets a local world override hosted Vercel signals", () => {
    expect(() =>
      assertProductionMutationReady({
        ...VALID_PRODUCTION,
        WORKFLOW_TARGET_WORLD: "local",
      }),
    ).toThrow(ProductionConfigurationError);
  });

  it.each([
    "TEX64_SESSION_SECRET",
    "DATABASE_URL",
    "TEX64_AI_MODEL",
    "TEX64_SANDBOX_IMAGE",
    "TEX64_ALLOW_ANONYMOUS_PRODUCTION",
    "TEX64_GLOBAL_RUNS_PER_HOUR",
  ] as const)("rejects production when %s is absent", (name) => {
    const environment: Record<string, string | undefined> = { ...VALID_PRODUCTION };
    delete environment[name];
    expect(() => assertProductionMutationReady(environment)).toThrow(
      ProductionConfigurationError,
    );
  });

  it("requires explicit service credentials and a trusted header outside Vercel", () => {
    const environment: Record<string, string | undefined> = {
      ...VALID_PRODUCTION,
      VERCEL: undefined,
      WORKFLOW_TARGET_WORLD: undefined,
    };
    expect(() => assertProductionMutationReady(environment)).toThrow(
      "AI_GATEWAY_API_KEY",
    );
    environment.AI_GATEWAY_API_KEY = "gateway-key";
    environment.BLOB_READ_WRITE_TOKEN = "blob-token";
    environment.VERCEL_TOKEN = "sandbox-token";
    environment.VERCEL_TEAM_ID = "team-id";
    environment.VERCEL_PROJECT_ID = "project-id";
    environment.TEX64_TRUSTED_CLIENT_IP_HEADER = "x-platform-client-ip";
    expect(assertProductionMutationReady(environment)).toBeDefined();
  });

  it.each([
    "AI_GATEWAY_API_KEY",
    "BLOB_READ_WRITE_TOKEN",
    "VERCEL_TOKEN",
    "VERCEL_TEAM_ID",
    "VERCEL_PROJECT_ID",
  ] as const)("requires %s outside Vercel", (name) => {
    const environment: Record<string, string | undefined> = {
      ...VALID_PRODUCTION,
      VERCEL: undefined,
      WORKFLOW_TARGET_WORLD: undefined,
      AI_GATEWAY_API_KEY: "gateway-key",
      BLOB_READ_WRITE_TOKEN: "blob-token",
      VERCEL_TOKEN: "sandbox-token",
      VERCEL_TEAM_ID: "team-id",
      VERCEL_PROJECT_ID: "project-id",
      TEX64_TRUSTED_CLIENT_IP_HEADER: "x-platform-client-ip",
    };
    delete environment[name];
    expect(() => assertProductionMutationReady(environment)).toThrow(name);
  });
});
