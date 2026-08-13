import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/server/auth";
import { handleRouteError, rateLimitResponse } from "@/server/http/responses";
import {
  documentMutationRateLimitInput,
  takeRateLimits,
} from "@/server/http/rate-limit";
import { assertSameOrigin } from "@/server/http/origin";
import { readJsonBody } from "@/server/http/request";
import { DocumentNotFoundError, getDocumentRepository } from "@/server/persistence";
import { ClientDocumentPatchSchema, createDomainPatchFromClient } from "@/server/presentation/document-view";
import { loadDocumentDetail } from "@/server/presentation/load-document";
import { assertProductionMutationReady } from "@/server/config/production";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ documentId: string }> },
) {
  try {
    assertSameOrigin(request);
    assertProductionMutationReady();
    const { userId } = await requireSession();
    const { documentId } = await context.params;
    z.string().uuid().parse(documentId);
    const input = ClientDocumentPatchSchema.parse(await readJsonBody(request));
    const requestKey = request.headers.get("Idempotency-Key");
    if (requestKey) z.string().uuid().parse(requestKey);
    const limit = await takeRateLimits(
      documentMutationRateLimitInput({
        request,
        userId,
        action: "patch",
        ...(requestKey ? { reservationKey: `${documentId}:${requestKey}` } : {}),
      }),
    );
    if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds);

    const repository = getDocumentRepository();
    const current = await repository.getDocument(userId, documentId);
    if (!current) throw new DocumentNotFoundError();
    const converted = createDomainPatchFromClient({ current, patch: input });
    if (converted) {
      await repository.commitDocument({
        commitId: converted.patch.id,
        userId,
        documentId,
        expectedRevision: input.baseRevision,
        document: converted.next.document,
        actor: "user",
        summary: "文書を編集",
        operations: converted.patch.operations,
      });
    }
    return NextResponse.json({ document: await loadDocumentDetail(userId, documentId) });
  } catch (error) {
    return handleRouteError(error);
  }
}
