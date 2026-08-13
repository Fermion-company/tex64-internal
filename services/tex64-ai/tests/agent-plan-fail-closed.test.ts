import { describe, expect, it, vi } from "vitest";

const generateTextMock = vi.hoisted(() => vi.fn());

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return { ...actual, generateText: generateTextMock };
});

import { createDocumentAgentSession } from "@/domain/brief";
import {
  DocumentPlanGenerationError,
  createDocumentPlan,
} from "@/server/agent/plan-generator";

describe("production plan generation", () => {
  it("does not hide an AI/schema failure behind the generic local plan", async () => {
    generateTextMock.mockRejectedValueOnce(new Error("provider unavailable"));
    const session = createDocumentAgentSession({
      sessionId: "76000000-0000-4000-8000-000000000001",
      documentId: "76000000-0000-4000-8000-000000000002",
      rootRunId: "76000000-0000-4000-8000-000000000003",
      deliverable: "paper",
      now: "2026-08-08T00:00:00.000Z",
    });

    await expect(
      createDocumentPlan({
        brief: session.brief,
        briefVersion: session.briefVersion,
        now: session.createdAt,
        runtime: {
          provider: "ai_gateway",
          model: "openai/gpt-5.6-sol",
        },
      }),
    ).rejects.toBeInstanceOf(DocumentPlanGenerationError);
    expect(generateTextMock).toHaveBeenCalledOnce();
  });
});
