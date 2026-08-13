import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { start } from "workflow/api";
import { requireSession } from "@/server/auth";
import { handleRouteError, rateLimitResponse } from "@/server/http/responses";
import { pageMetadata, parsePageRequest } from "@/server/http/pagination";
import { assertSameOrigin } from "@/server/http/origin";
import { readJsonBody } from "@/server/http/request";
import { createAndStartDocumentRun } from "@/server/http/start-document-run";
import { DocumentNotFoundError, getDocumentRepository } from "@/server/persistence";
import {
  presentAgentRun,
  presentAgentRuns,
} from "@/server/presentation/document-view";
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
      .max(MAX_DOCUMENT_AGENT_PROMPT_CHARS)
      .optional(),
    replyToRunId: z.string().uuid().optional(),
    decision: z.enum(["approve", "reject"]).optional(),
    targetNodeId: z.string().uuid().optional(),
    idempotencyKey: IdempotencyKeySchema.optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.decision && !input.replyToRunId) {
      context.addIssue({
        code: "custom",
        path: ["replyToRunId"],
        message: "A decision must target a pending run.",
      });
    }
    if (!input.decision && !input.prompt) {
      context.addIssue({
        code: "custom",
        path: ["prompt"],
        message: "A writing request or answer is required.",
      });
    }
    if (input.targetNodeId && input.decision) {
      context.addIssue({
        code: "custom",
        path: ["targetNodeId"],
        message: "A decision cannot scope a document element.",
      });
    }
  });

export async function GET(
  request: Request,
  context: { params: Promise<{ documentId: string }> },
) {
  try {
    const { userId } = await requireSession();
    const { documentId } = await context.params;
    z.string().uuid().parse(documentId);
    const repository = getDocumentRepository();
    if (!(await repository.getDocument(userId, documentId))) throw new DocumentNotFoundError();
    const page = parsePageRequest(request);
    const runs = await repository.listRuns(userId, documentId, page);
    const presentedRuns = await presentAgentRuns(repository, userId, runs);
    return NextResponse.json({
      runs: presentedRuns,
      page: pageMetadata(page, presentedRuns.length),
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

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
    const prompt = input.decision
      ? input.decision === "approve"
        ? "変更を承認"
        : "変更を取り消す"
      : (input.prompt as string);
    await repository.validateRunReplyTarget({
      id: requestedRunId,
      userId,
      documentId,
      prompt,
      idempotencyKey,
      baseRevision: document.currentRevision,
      replyToRunId: input.replyToRunId ?? null,
      decision: input.decision ?? null,
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
      decision: input.decision ?? null,
      targetNodeId: input.targetNodeId ?? null,
      startWorkflow: async (workflowInput) => {
        const workflowRun = await start(runDocumentAgentWorkflow, [workflowInput]);
        return { runId: workflowRun.runId };
      },
    });
    return NextResponse.json(
      { run: await presentAgentRun(repository, userId, run) },
      { status: 202 },
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
