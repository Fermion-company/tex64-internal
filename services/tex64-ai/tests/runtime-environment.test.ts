import { describe, expect, it } from "vitest";

import {
  isProductionRuntime,
  isTrustedLocalWorkflowRuntime,
} from "@/server/config/runtime-environment";

describe("runtime environment classification", () => {
  it("recognizes only the dev-script-marked local Workflow child", () => {
    const environment = {
      NODE_ENV: "production",
      WORKFLOW_TARGET_WORLD: "local",
      TEX64_LOCAL_DEVELOPMENT: "true",
    };
    expect(isTrustedLocalWorkflowRuntime(environment)).toBe(true);
    expect(isProductionRuntime(environment)).toBe(false);
  });

  it("treats a bare self-hosted local-world flag as production", () => {
    const environment = {
      NODE_ENV: "production",
      WORKFLOW_TARGET_WORLD: "local",
    };
    expect(isTrustedLocalWorkflowRuntime(environment)).toBe(false);
    expect(isProductionRuntime(environment)).toBe(true);
  });

  it("lets hosted Vercel signals override the local development marker", () => {
    const environment = {
      NODE_ENV: "production",
      WORKFLOW_TARGET_WORLD: "local",
      TEX64_LOCAL_DEVELOPMENT: "true",
      VERCEL: "1",
    };
    expect(isTrustedLocalWorkflowRuntime(environment)).toBe(false);
    expect(isProductionRuntime(environment)).toBe(true);
  });
});
