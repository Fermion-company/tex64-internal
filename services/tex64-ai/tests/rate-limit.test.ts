import { describe, expect, it } from "vitest";
import {
  agentRunRateLimitInput,
  documentMutationRateLimitInput,
  takeRateLimit,
  takeRateLimits,
  trustedClientAddress,
} from "@/server/http/rate-limit";

describe("application rate limit", () => {
  it("limits within a window and resets afterwards", async () => {
    const key = `test:${crypto.randomUUID()}`;
    expect((await takeRateLimit({ key, limit: 2, windowMs: 1_000, now: 10 })).allowed).toBe(true);
    expect((await takeRateLimit({ key, limit: 2, windowMs: 1_000, now: 20 })).allowed).toBe(true);
    expect((await takeRateLimit({ key, limit: 2, windowMs: 1_000, now: 30 })).allowed).toBe(false);
    expect((await takeRateLimit({ key, limit: 2, windowMs: 1_000, now: 1_100 })).allowed).toBe(true);
  });

  it("bounds process memory when clients continually rotate identities", async () => {
    const prefix = crypto.randomUUID();
    const oldestKey = `${prefix}:oldest`;
    expect((await takeRateLimit({ key: oldestKey, limit: 1, windowMs: 60_000, now: 1 })).allowed).toBe(true);

    for (let index = 0; index < 10_002; index += 1) {
      await takeRateLimit({ key: `${prefix}:${index}`, limit: 1, windowMs: 60_000, now: 1 });
    }

    expect((await takeRateLimit({ key: oldestKey, limit: 1, windowMs: 60_000, now: 2 })).allowed).toBe(true);
  });

  it("does not consume quota twice for an idempotent paid-run replay", async () => {
    const prefix = crypto.randomUUID();
    const policies = [
      {
        action: "agent:start",
        kind: "global" as const,
        key: prefix,
        limit: 1,
        windowMs: 60_000,
      },
    ];
    expect(
      (await takeRateLimits({ policies, reservationKey: `${prefix}:request-1`, now: 10 })).allowed,
    ).toBe(true);
    expect(
      (await takeRateLimits({ policies, reservationKey: `${prefix}:request-1`, now: 20 })).allowed,
    ).toBe(true);
    expect(
      (await takeRateLimits({ policies, reservationKey: `${prefix}:request-2`, now: 30 })).allowed,
    ).toBe(false);
  });

  it("checks identity, network, and global buckets atomically", async () => {
    const prefix = crypto.randomUUID();
    const policies = (identity: string, network: string) => [
      { action: "agent:start", kind: "identity" as const, key: identity, limit: 2, windowMs: 60_000 },
      { action: "agent:start", kind: "network" as const, key: network, limit: 1, windowMs: 60_000 },
      { action: "agent:start", kind: "global" as const, key: prefix, limit: 2, windowMs: 60_000 },
    ];

    expect((await takeRateLimits({ policies: policies("user", "network-a"), now: 10 })).allowed).toBe(true);
    expect((await takeRateLimits({ policies: policies("user", "network-a"), now: 20 })).allowed).toBe(false);
    // The denied second reservation rolled back its identity/global increments.
    expect((await takeRateLimits({ policies: policies("user", "network-b"), now: 30 })).allowed).toBe(true);
  });

  it("keeps network quota stable when anonymous cookies rotate", async () => {
    const environment = { NODE_ENV: "test" };
    const request = new Request("http://localhost/api", {
      headers: { "x-forwarded-for": "203.0.113.8" },
    });
    const first = agentRunRateLimitInput({
      request,
      userId: crypto.randomUUID(),
      documentId: crypto.randomUUID(),
      idempotencyKey: crypto.randomUUID(),
      quota: { identityRunsPerHour: 10, networkRunsPerHour: 2, globalRunsPerHour: 10 },
      environment,
    });
    const second = agentRunRateLimitInput({
      request,
      userId: crypto.randomUUID(),
      documentId: crypto.randomUUID(),
      idempotencyKey: crypto.randomUUID(),
      quota: { identityRunsPerHour: 10, networkRunsPerHour: 2, globalRunsPerHour: 10 },
      environment,
    });
    const third = agentRunRateLimitInput({
      request,
      userId: crypto.randomUUID(),
      documentId: crypto.randomUUID(),
      idempotencyKey: crypto.randomUUID(),
      quota: { identityRunsPerHour: 10, networkRunsPerHour: 2, globalRunsPerHour: 10 },
      environment,
    });

    expect((await takeRateLimits({ ...first, environment, now: 100 })).allowed).toBe(true);
    expect((await takeRateLimits({ ...second, environment, now: 200 })).allowed).toBe(true);
    expect((await takeRateLimits({ ...third, environment, now: 300 })).allowed).toBe(false);
  });

  it("protects document creation by network and global buckets", async () => {
    const environment = { NODE_ENV: "test" };
    const request = new Request("http://localhost/api/documents", {
      headers: { "x-forwarded-for": "203.0.113.44" },
    });
    let denied = false;
    for (let index = 0; index < 61; index += 1) {
      const result = await takeRateLimits({
        ...documentMutationRateLimitInput({
          request,
          userId: crypto.randomUUID(),
          action: "create",
          environment,
        }),
        environment,
        now: 500,
      });
      if (!result.allowed) denied = true;
    }
    expect(denied).toBe(true);
  });

  it("uses only Vercel's anti-spoofing client address header in production", () => {
    const request = new Request("https://example.test/api", {
      headers: {
        "x-forwarded-for": "198.51.100.1",
        "x-vercel-forwarded-for": "203.0.113.9",
      },
    });
    expect(trustedClientAddress(request, { VERCEL: "1" })).toBe("203.0.113.9");
  });
});
