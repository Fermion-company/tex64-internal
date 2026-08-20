import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { start } from "workflow/api";
import { requireSession } from "@/server/auth";
import { handleRouteError, rateLimitResponse } from "@/server/http/responses";
import { assertSameOrigin } from "@/server/http/origin";
import { readJsonBody } from "@/server/http/request";
import { createAndStartDocumentRun } from "@/server/http/start-document-run";
import { DocumentNotFoundError, getDocumentRepository } from "@/server/persistence";
import { presentAgentRun } from "@/server/presentation/document-view";
import {
  MAX_DOCUMENT_AGENT_PROMPT_CHARS,
  runDocumentAgentWorkflow,
} from "@/workflows/document-agent";
import { assertProductionMutationReady } from "@/server/config/production";
import { agentRunRateLimitInput, takeRateLimits } from "@/server/http/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const IdempotencyKeySchema = z
  .string()
  .trim()
  .min(8)
  .max(200)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value));

const StartRunSchema = z
  .object({
    prompt: z
      .string()
      .trim()
      .min(1)
      .max(MAX_DOCUMENT_AGENT_PROMPT_CHARS),
    replyToRunId: z.string().uuid().optional(),
    targetNodeId: z.string().uuid().optional(),
    idempotencyKey: IdempotencyKeySchema.optional(),
  })
  .strict();

export async function POST(
  request: Request,
  context: { params: Promise<{ documentId: string }> },
) {
  try {
    assertSameOrigin(request);
    const quota = assertProductionMutationReady();
    const { userId } = await requireSession();

    const { documentId } = await context.params;
    z.string().uuid().parse(documentId);
    const input = StartRunSchema.parse(await readJsonBody(request));
    const repository = getDocumentRepository();
    const document = await repository.getDocument(userId, documentId);
    if (!document) throw new DocumentNotFoundError();

    const requestedRunId = randomUUID();
    const headerKey = request.headers.get("Idempotency-Key");
    const idempotencyKey = headerKey
      ? IdempotencyKeySchema.parse(headerKey)
      : (input.idempotencyKey ?? requestedRunId);
    const prompt = input.prompt;
    await repository.validateRunReplyTarget({
      id: requestedRunId,
      userId,
      documentId,
      prompt,
      idempotencyKey,
      baseRevision: document.currentRevision,
      replyToRunId: input.replyToRunId ?? null,
      targetNodeId: input.targetNodeId ?? null,
    });
    const limit = await takeRateLimits(
      agentRunRateLimitInput({
        request,
        userId,
        documentId,
        idempotencyKey,
        quota,
      }),
    );
    if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds);
    const run = await createAndStartDocumentRun({
      repository,
      requestedRunId,
      userId,
      documentId,
      prompt,
      idempotencyKey,
      baseRevision: document.currentRevision,
      replyToRunId: input.replyToRunId ?? null,
      targetNodeId: input.targetNodeId ?? null,
      startWorkflow: async (workflowInput) => {
        const workflowRun = await start(runDocumentAgentWorkflow, [workflowInput]);
        return { runId: workflowRun.runId };
      },
    });
    return NextResponse.json(
      { run: presentAgentRun(run) },
      { status: 202 },
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
