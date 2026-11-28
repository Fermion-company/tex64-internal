import { randomUUID } from "node:crypto";
import { z } from "zod";

import { requireSession } from "@/server/auth";
import { runDocumentTurn, type TurnFrame } from "@/server/agent/turn";
import { assertProductionMutationReady } from "@/server/config/production";
import { assertSameOrigin } from "@/server/http/origin";
import { agentRunRateLimitInput, takeRateLimits } from "@/server/http/rate-limit";
import { readJsonBody } from "@/server/http/request";
import { handleRouteError, rateLimitResponse } from "@/server/http/responses";
import { DocumentNotFoundError, getDocumentRepository } from "@/server/persistence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Long enough for a full writing turn; the client can stop it any time. */
export const maxDuration = 800;

const MAX_TURN_PROMPT_CHARS = 20_000;

const SendMessageSchema = z
  .object({
    prompt: z.string().trim().min(1).max(MAX_TURN_PROMPT_CHARS),
    targetNodeId: z.string().uuid().optional(),
  })
  .strict();

/**
 * Send one message and read the agent's reply as it happens. The response is
 * newline-delimited JSON frames; closing the connection interrupts the turn.
 */
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
    const input = SendMessageSchema.parse(await readJsonBody(request));

    const repository = getDocumentRepository();
    const document = await repository.getDocument(userId, documentId);
    if (!document) throw new DocumentNotFoundError();

    const turnId = randomUUID();
    const limit = await takeRateLimits(
      agentRunRateLimitInput({
        request,
        userId,
        documentId,
        idempotencyKey: turnId,
        quota,
      }),
    );
    if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds);

    await repository.createRun({
      id: turnId,
      userId,
      documentId,
      prompt: input.prompt,
      idempotencyKey: turnId,
      baseRevision: document.currentRevision,
      targetNodeId: input.targetNodeId ?? null,
    });
    await repository.updateRun(userId, turnId, {
      status: "running",
      stage: "writing",
    });

    return new Response(
      turnFrameStream({
        userId,
        documentId,
        turnId,
        prompt: input.prompt,
        targetNodeId: input.targetNodeId ?? null,
        abortSignal: request.signal,
      }),
      {
        headers: {
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
          // Proxies that buffer would defeat the point of streaming.
          "X-Accel-Buffering": "no",
        },
      },
    );
  } catch (error) {
    return handleRouteError(error);
  }
}

function turnFrameStream(input: {
  userId: string;
  documentId: string;
  turnId: string;
  prompt: string;
  targetNodeId: string | null;
  abortSignal: AbortSignal;
}): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const disconnected = new AbortController();
  const abortSignal = AbortSignal.any([input.abortSignal, disconnected.signal]);
  return new ReadableStream<Uint8Array>({
    cancel() {
      disconnected.abort();
    },
    async start(controller) {
      const write = (frame: TurnFrame) => {
        if (disconnected.signal.aborted) return;
        controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
      };
      try {
        for await (const frame of runDocumentTurn({ ...input, abortSignal })) write(frame);
      } catch (error) {
        // Setup can fail before the runner reaches its own finalization.
        const message = error instanceof Error && error.name === "AgentRuntimeConfigurationError"
          ? error.message
          : "処理が最後まで進みませんでした。もう一度お試しください。";
        const aborted = abortSignal.aborted;
        try {
          await getDocumentRepository().updateRun(input.userId, input.turnId, {
            status: aborted ? "cancelled" : "failed",
            stage: "failed",
            ...(aborted ? {} : { errorMessage: message }),
          });
        } finally {
          if (!aborted) write({ type: "error", message });
          write({ type: "done", status: aborted ? "aborted" : "failed" });
        }
      } finally {
        if (!disconnected.signal.aborted) controller.close();
      }
    },
  });
}
