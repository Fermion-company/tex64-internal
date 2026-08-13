import { describe, expect, it } from "vitest";
import { selectArtifactBackend } from "@/server/artifacts";
import { selectCompilerBackend } from "@/server/compiler";
import { createLatexChildEnvironment } from "@/server/compiler/local-compiler";
import { assertValidPdfArtifact } from "@/server/compiler/safety";

describe("compiler runtime selection", () => {
  it("uses the local compiler inside the Workflow local world even after production transforms", () => {
    expect(
      selectCompilerBackend({
        NODE_ENV: "production",
        WORKFLOW_TARGET_WORLD: "local",
        TEX64_LOCAL_DEVELOPMENT: "true",
        TEX64_COMPILER: "auto",
      }),
    ).toBe("local");
  });

  it("defaults an unclassified production runtime to the sandbox", () => {
    expect(
      selectCompilerBackend({ NODE_ENV: "production", TEX64_COMPILER: "auto" }),
    ).toBe("sandbox");
  });

  it("does not trust a bare local-world flag in self-hosted production", () => {
    expect(
      selectCompilerBackend({
        NODE_ENV: "production",
        WORKFLOW_TARGET_WORLD: "local",
        TEX64_COMPILER: "auto",
      }),
    ).toBe("sandbox");
  });

  it("never permits an explicit local compiler in a hosted world", () => {
    expect(() =>
      selectCompilerBackend({
        TEX64_COMPILER: "local",
        WORKFLOW_TARGET_WORLD: "vercel",
      }),
    ).toThrow("disabled in production");
  });

  it("does not honor a local Workflow override when Vercel is present", () => {
    expect(
      selectCompilerBackend({
        TEX64_COMPILER: "auto",
        WORKFLOW_TARGET_WORLD: "local",
        VERCEL: "1",
      }),
    ).toBe("sandbox");
  });
});

describe("artifact runtime selection", () => {
  it("keeps Workflow local artifacts on disk despite a production transform", () => {
    expect(
      selectArtifactBackend({
        NODE_ENV: "production",
        WORKFLOW_TARGET_WORLD: "local",
        TEX64_LOCAL_DEVELOPMENT: "true",
      }),
    ).toBe("local");
  });

  it("does not store locally for a bare local-world flag in production", () => {
    expect(
      selectArtifactBackend({
        NODE_ENV: "production",
        WORKFLOW_TARGET_WORLD: "local",
      }),
    ).toBe("blob");
  });

  it("requires blob storage in hosted and unclassified production runtimes", () => {
    expect(selectArtifactBackend({ WORKFLOW_TARGET_WORLD: "vercel" })).toBe(
      "blob",
    );
    expect(selectArtifactBackend({ NODE_ENV: "production" })).toBe("blob");
  });

  it("does not select local artifacts from a hosted local-world override", () => {
    expect(
      selectArtifactBackend({ WORKFLOW_TARGET_WORLD: "local", VERCEL: "1" }),
    ).toBe("blob");
  });
});

describe("local compiler isolation", () => {
  it("passes only an explicit non-secret environment to LuaLaTeX", () => {
    const environment = createLatexChildEnvironment({
      workDir: "/tmp/job",
      cachePath: "/tmp/job/cache",
      configPath: "/tmp/job/config",
      parentEnvironment: {
        NODE_ENV: "development",
        PATH: "/safe/bin",
        AI_GATEWAY_API_KEY: "provider-secret",
        DATABASE_URL: "database-secret",
        TEX64_SESSION_SECRET: "session-secret",
        BLOB_READ_WRITE_TOKEN: "blob-secret",
      },
    });

    expect(environment.PATH).toBe("/safe/bin");
    expect(environment.HOME).toBe("/tmp/job");
    expect(environment.LANG).toBe("C.UTF-8");
    expect(environment.LC_ALL).toBe("C.UTF-8");
    expect(environment).not.toHaveProperty("AI_GATEWAY_API_KEY");
    expect(environment).not.toHaveProperty("DATABASE_URL");
    expect(environment).not.toHaveProperty("TEX64_SESSION_SECRET");
    expect(environment).not.toHaveProperty("BLOB_READ_WRITE_TOKEN");
  });
});

describe("compiled PDF validation", () => {
  it("accepts a bounded PDF with a header and trailer", () => {
    expect(() => assertValidPdfArtifact(validPdf())).not.toThrow();
  });

  it("rejects a non-PDF body and a truncated PDF", () => {
    expect(() => assertValidPdfArtifact(Buffer.alloc(128, "x"))).toThrow();
    expect(() =>
      assertValidPdfArtifact(Buffer.from(`%PDF-1.7\n${"x".repeat(80)}`)),
    ).toThrow();
  });
});

function validPdf(): Buffer {
  return Buffer.from(`%PDF-1.7\n1 0 obj\n<<>>\nendobj\n${" ".repeat(64)}\n%%EOF\n`);
}
