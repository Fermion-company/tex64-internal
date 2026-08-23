import { NextResponse } from "next/server";
import { z } from "zod";
import { validateDocument } from "@/domain/document";
import { requireSession } from "@/server/auth";
import { assertProductionMutationReady } from "@/server/config/production";
import { assertSameOrigin } from "@/server/http/origin";
import {
  documentMutationRateLimitInput,
  takeRateLimits,
} from "@/server/http/rate-limit";
import { readJsonBody } from "@/server/http/request";
import { handleRouteError, jsonError, rateLimitResponse } from "@/server/http/responses";
import { DocumentNotFoundError, getDocumentRepository } from "@/server/persistence";
import { loadDocumentDetail } from "@/server/presentation/load-document";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RestoreSchema = z
  .object({
    revision: z.number().int().positive(),
  })
  .strict();

/**
 * Restores an earlier revision by committing its snapshot as a NEW revision
 * (actor: user), so history stays linear and nothing is ever overwritten.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ documentId: string }> },
) {
  try {
    assertSameOrigin(request);
    assertProductionMutationReady();
    const { userId } = await requireSession();
    const { documentId } = await context.params;
    z.string().uuid().parse(documentId);
    const input = RestoreSchema.parse(await readJsonBody(request));
    const requestKey = request.headers.get("Idempotency-Key");
    if (requestKey) z.string().uuid().parse(requestKey);

    const limit = await takeRateLimits(
      documentMutationRateLimitInput({
        request,
        userId,
        action: "restore",
        ...(requestKey
          ? { reservationKey: `${documentId}:restore:${requestKey}` }
          : {}),
      }),
    );
    if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds);

    const repository = getDocumentRepository();
    const document = await repository.getDocument(userId, documentId);
    if (!document) throw new DocumentNotFoundError();
    if (input.revision >= document.currentRevision) {
      return jsonError("この版には戻せません。", 409, "invalid_restore_target");
    }
    const recentRuns = await repository.listRuns(userId, documentId, {
      limit: 10,
    });
    if (
      recentRuns.some(
        (run) => run.status === "running",
      )
    ) {
      return jsonError(
        "執筆の処理中です。完了してからもう一度お試しください。",
        409,
        "document_busy",
      );
    }

    const snapshot = await repository.getRevision(
      userId,
      documentId,
      input.revision,
    );
    if (!snapshot) throw new DocumentNotFoundError();
    const restored = validateDocument(snapshot.document);

    await repository.commitDocument({
      commitId: requestKey ?? crypto.randomUUID(),
      userId,
      documentId,
      expectedRevision: document.currentRevision,
      document: restored,
      actor: "user",
      summary: `以前の状態に戻す`,
      operations: [],
    });

    return NextResponse.json({
      document: await loadDocumentDetail(userId, documentId),
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
