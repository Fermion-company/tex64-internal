import { describe, expect, it } from "vitest";

import {
  containsUnsafeUserFacingCopy,
  normalizeUserFacingResultNote,
} from "@/lib/user-facing-copy";
import { CompileFailure } from "@/server/compiler";
import { handleRouteError } from "@/server/http/responses";
import { InvalidRequestBodyError } from "@/server/http/request";
import { ResourceLimitExceededError } from "@/server/persistence";

describe("agent closing messages", () => {
  it("keeps a plain reply and drops one that leaks internals", () => {
    expect(normalizeUserFacingResultNote("序論を書きました。")).toBe(
      "序論を書きました。",
    );

    const unsafe = "apply_document_patch で \\section を書き換えました";
    expect(containsUnsafeUserFacingCopy(unsafe)).toBe(true);
    expect(normalizeUserFacingResultNote(unsafe)).toBeNull();
  });
});

describe("plain API recovery copy", () => {
  it.each([
    [
      new InvalidRequestBodyError("content_type"),
      "入力を送信できませんでした。画面を更新して、もう一度お試しください。",
    ],
    [
      new ResourceLimitExceededError("documents"),
      "保存上限に達しました。続けるには管理者にお問い合わせください。",
    ],
    [
      new CompileFailure("private compiler detail", []),
      "文書を仕上げられませんでした。もう一度お試しください。",
    ],
  ])("returns an actionable message without implementation terms", async (error, message) => {
    const response = handleRouteError(error);
    const body = await response.json();
    expect(body.error.message).toBe(message);
    expect(JSON.stringify(body)).not.toContain("private compiler detail");
    expect(JSON.stringify(body)).not.toMatch(/送信形式|作業領域/u);
  });
});
