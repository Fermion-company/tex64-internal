import { describe, expect, it } from "vitest";
import { createSessionCookie, verifySessionCookie } from "@/server/auth/session";

describe("anonymous workspace session", () => {
  it("round-trips a signed identifier", () => {
    const userId = "7f1a4dbf-cbc7-42f6-a779-d8c3709fe27c";
    expect(verifySessionCookie(createSessionCookie(userId))).toBe(userId);
  });

  it("rejects a modified identifier", () => {
    const value = createSessionCookie("7f1a4dbf-cbc7-42f6-a779-d8c3709fe27c");
    expect(verifySessionCookie(value.replace("7f1a", "8f1a"))).toBeNull();
  });

  it("rejects an expired server-side session", () => {
    const value = createSessionCookie("7f1a4dbf-cbc7-42f6-a779-d8c3709fe27c", 100);
    expect(verifySessionCookie(value, 100 + 366 * 24 * 60 * 60)).toBeNull();
  });
});
