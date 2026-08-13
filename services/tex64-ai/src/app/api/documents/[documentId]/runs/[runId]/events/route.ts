import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/server/auth";
import { handleRouteError } from "@/server/http/responses";
import { DocumentNotFoundError, getDocumentRepository } from "@/server/persistence";
import { presentRunEvents } from "@/server/presentation/document-view";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const AfterSequenceSchema = z.coerce.number().int().nonnegative().optional();

const MAX_EVENTS_PER_PAGE = 200;

export async function GET(
  request: Request,
  context: { params: Promise<{ documentId: string; runId: string }> },
) {
  try {
    const { userId } = await requireSession();
    const { documentId, runId } = await context.params;
    z.string().uuid().parse(documentId);
    z.string().uuid().parse(runId);

    const repository = getDocumentRepository();
    const run = await repository.getRun(userId, runId);
    if (!run || run.documentId !== documentId) throw new DocumentNotFoundError();

    const after = AfterSequenceSchema.parse(
      new URL(request.url).searchParams.get("after") ?? undefined,
    );
    const events = await repository.listRunEvents(
      userId,
      runId,
      after,
      MAX_EVENTS_PER_PAGE,
    );
    return NextResponse.json({ events: presentRunEvents(events) });
  } catch (error) {
    return handleRouteError(error);
  }
}
