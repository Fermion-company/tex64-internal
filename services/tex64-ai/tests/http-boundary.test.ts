import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertSameOrigin, InvalidOriginError } from "@/server/http/origin";
import { readJsonBody, InvalidRequestBodyError } from "@/server/http/request";
import { handleRouteError } from "@/server/http/responses";
import {
  AgentRunConflictError,
  ArtifactConflictError,
  IdempotencyConflictError,
  InvalidAgentRunTransitionError,
  PendingDocumentActionConflictError,
  RunReplyConflictError,
} from "@/server/persistence";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("mutation request boundary", () => {
  it("keeps origin, rate, bounded JSON, and Zod checks on every mutation route", async () => {
    const apiRoot = fileURLToPath(new URL("../src/app/api", import.meta.url));
    const routeFiles = await collectRouteFiles(apiRoot);
    let mutationRoutes = 0;

    for (const routeFile of routeFiles) {
      const source = await readFile(routeFile, "utf8");
      if (!/export async function (?:POST|PATCH|PUT|DELETE)\s*\(/u.test(source)) continue;
      mutationRoutes += 1;
      expect(source, routeFile).toContain("assertSameOrigin(request)");
      expect(source, routeFile).toMatch(/takeRateLimits?\(/u);
      expect(source, routeFile).toContain("assertProductionMutationReady()");
      expect(source, routeFile).toContain("readJsonBody(request)");
      expect(source, routeFile).toMatch(/Schema\.parse\(await readJsonBody\(request\)\)/u);
    }

    expect(mutationRoutes).toBeGreaterThan(0);
  });

  it("accepts only same-origin browser mutations", () => {
    const sameOrigin = new Request("https://tex64.example/api/documents", {
      method: "POST",
      headers: { Origin: "https://tex64.example", "Sec-Fetch-Site": "same-origin" },
    });
    expect(() => assertSameOrigin(sameOrigin)).not.toThrow();

    const crossOrigin = new Request("https://tex64.example/api/documents", {
      method: "POST",
      headers: { Origin: "https://attacker.example", "Sec-Fetch-Site": "cross-site" },
    });
    expect(() => assertSameOrigin(crossOrigin)).toThrow(InvalidOriginError);
  });

  it("treats loopback host aliases as one origin outside production", () => {
    const aliased = new Request("http://localhost:3100/api/documents", {
      method: "POST",
      headers: { Origin: "http://127.0.0.1:3100", "Sec-Fetch-Site": "same-origin" },
    });
    expect(() => assertSameOrigin(aliased)).not.toThrow();

    const portMismatch = new Request("http://localhost:3100/api/documents", {
      method: "POST",
      headers: { Origin: "http://127.0.0.1:4000", "Sec-Fetch-Site": "same-origin" },
    });
    expect(() => assertSameOrigin(portMismatch)).toThrow(InvalidOriginError);

    vi.stubEnv("NODE_ENV", "production");
    expect(() => assertSameOrigin(aliased.clone())).toThrow(InvalidOriginError);
    vi.unstubAllEnvs();
  });

  it("rejects production mutations when browser origin metadata is absent", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() =>
      assertSameOrigin(new Request("https://tex64.example/api/documents", { method: "POST" })),
    ).toThrow(InvalidOriginError);
  });

  it("streams and validates a bounded JSON request body", async () => {
    const valid = new Request("https://tex64.example/api/documents", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ prompt: "本文を作成" }),
    });
    await expect(readJsonBody(valid)).resolves.toEqual({ prompt: "本文を作成" });

    const malformed = new Request("https://tex64.example/api/documents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    await expect(readJsonBody(malformed)).rejects.toMatchObject({ kind: "invalid_json" });

    const tooLarge = new Request("https://tex64.example/api/documents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "長い入力" }),
    });
    await expect(readJsonBody(tooLarge, 4)).rejects.toMatchObject({ kind: "too_large" });

    const wrongType = new Request("https://tex64.example/api/documents", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "{}",
    });
    await expect(readJsonBody(wrongType)).rejects.toBeInstanceOf(InvalidRequestBodyError);
  });
});

async function collectRouteFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) return collectRouteFiles(target);
      return entry.isFile() && entry.name === "route.ts" ? [target] : [];
    }),
  );
  return files.flat();
}

describe("safe API errors", () => {
  it.each([
    new IdempotencyConflictError("agent_run", "private-key"),
    new AgentRunConflictError(1, 2),
    new InvalidAgentRunTransitionError("queued -> completed"),
    new ArtifactConflictError(),
    new RunReplyConflictError("private reply detail"),
    new PendingDocumentActionConflictError("private pending detail"),
  ])("maps persistence conflicts to a detail-free 409 response", async (error) => {
    const response = handleRouteError(error);
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body).toHaveProperty("error.message");
    expect(JSON.stringify(body)).not.toContain("private-key");
    expect(JSON.stringify(body)).not.toContain("queued -> completed");
    expect(body.error).not.toHaveProperty("detail");
  });

  it("does not expose Zod field metadata", async () => {
    let validationError: z.ZodError;
    try {
      z.object({ secretField: z.string() }).parse({});
      throw new Error("expected validation to fail");
    } catch (error) {
      validationError = error as z.ZodError;
    }

    const response = handleRouteError(validationError);
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).not.toContain("secretField");
  });
});
