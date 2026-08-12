import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/server/auth";
import { handleRouteError } from "@/server/http/responses";
import { loadDocumentDetail } from "@/server/presentation/load-document";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ documentId: string }> },
) {
  try {
    const { userId } = await requireSession();
    const { documentId } = await context.params;
    z.string().uuid().parse(documentId);
    return NextResponse.json({ document: await loadDocumentDetail(userId, documentId) });
  } catch (error) {
    return handleRouteError(error);
  }
}
