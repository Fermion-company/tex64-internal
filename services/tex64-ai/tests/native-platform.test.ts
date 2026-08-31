import { describe, expect, it } from "vitest";

import {
  canRunNativePlatform,
  parseNativeAgentModel,
  parseNativeTokenUsage,
} from "@/lib/client/use-native-platform";
import { nativeModelAction } from "@/components/native-platform-controls";

describe("native AI platform state", () => {
  it("exposes only the two public Axiom models", () => {
    expect(parseNativeAgentModel("Axiom1.0")).toBe("Axiom1.0");
    expect(parseNativeAgentModel("Axiom1.0-pro")).toBe("Axiom1.0-pro");
    expect(parseNativeAgentModel("codex")).toBeNull();
    expect(parseNativeAgentModel("gpt-5")).toBeNull();
  });

  it("waits for host confirmation, access, and Pro entitlement", () => {
    const base = {
      model: "Axiom1.0" as const,
      modelReady: true,
      accessAllowed: true,
      isPro: false,
    };
    expect(canRunNativePlatform(base)).toBe(true);
    expect(canRunNativePlatform({ ...base, modelReady: false })).toBe(false);
    expect(canRunNativePlatform({ ...base, accessAllowed: false })).toBe(false);
    expect(
      canRunNativePlatform({ ...base, model: "Axiom1.0-pro", isPro: false }),
    ).toBe(false);
    expect(
      canRunNativePlatform({ ...base, model: "Axiom1.0-pro", isPro: true }),
    ).toBe(true);
  });

  it("uses the anonymous Free quota without exposing internal cost", () => {
    expect(
      parseNativeTokenUsage({
        limitTokens: 200_000,
        usedTokens: 12_345,
        remainingTokens: 187_655,
        costUsd: 0.04,
      }),
    ).toEqual({
      limitTokens: 200_000,
      usedTokens: 12_345,
      remainingTokens: 187_655,
    });
    expect(parseNativeTokenUsage({ remainingTokens: 100 })).toBeNull();
  });

  it("turns the visible locked Pro model into a real upgrade path", () => {
    expect(nativeModelAction("Axiom1.0", false)).toBe("select");
    expect(nativeModelAction("Axiom1.0-pro", false)).toBe("plans");
    expect(nativeModelAction("Axiom1.0-pro", true)).toBe("select");
  });
});
