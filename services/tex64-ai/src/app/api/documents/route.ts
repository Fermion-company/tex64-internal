import { randomUUID } from "node:crypto";
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
import { getDocumentRepository } from "@/server/persistence";
import { createEmptyDocument, toDocumentSummary } from "@/server/presentation/document-view";
import { loadDocumentDetail } from "@/server/presentation/load-document";
import { assertProductionMutationReady } from "@/server/config/production";
import { pageMetadata, parsePageRequest } from "@/server/http/pagination";
import { runReleasesArtifact } from "@/server/artifacts/release";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CreateDocumentSchema = z
  .object({
    prompt: z.string().trim().min(1).max(20_000),
    kind: z.enum(["proposal", "report", "paper", "memo"]),
  })
  .strict();

class DocumentCreationReplayError extends Error {}

export async function GET(request: Request) {
  try {
    const { userId } = await requireSession();
    const repository = getDocumentRepository();
    const page = parsePageRequest(request);
    const documents = await repository.listDocuments(userId, page);
    const revisionTargets = documents.map((document) => ({
      documentId: document.id,
      revision: document.currentRevision,
    }));
    const [artifacts, completedRuns] = await Promise.all([
      repository.listArtifactsForRevisions(userId, revisionTargets),
      Promise.all(
        revisionTargets.map(({ documentId, revision }) =>
          repository.getCompletedRunForRevision(userId, documentId, revision),
        ),
      ),
    ]);
    const artifactByKey = new Map<string, (typeof artifacts)[number]>(
      artifacts.map((artifact) => [
        `${artifact.documentId}:${artifact.revision}`,
        artifact,
      ]),
    );
    const completedRunByKey = new Map<
      string,
      NonNullable<(typeof completedRuns)[number]>
    >(
      completedRuns.flatMap((run) =>
        run && run.resultRevision !== null
          ? [[`${run.documentId}:${run.resultRevision}`, run] as const]
          : [],
      ),
    );
    const summaries = documents.map((document) => {
      const key = `${document.id}:${document.currentRevision}`;
      return toDocumentSummary(
        document,
        runReleasesArtifact(
          completedRunByKey.get(key) ?? null,
          artifactByKey.get(key) ?? null,
        ),
      );
    });
    return NextResponse.json({
      documents: summaries,
      page: pageMetadata(page, summaries.length),
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    assertProductionMutationReady();
    const { userId } = await requireSession();
    const input = CreateDocumentSchema.parse(await readJsonBody(request));
    const requestedId = request.headers.get("Idempotency-Key");
    const documentId = requestedId ? z.string().uuid().parse(requestedId) : randomUUID();
    const limit = await takeRateLimits(
      documentMutationRateLimitInput({
        request,
        userId,
        action: "create",
        ...(requestedId ? { reservationKey: documentId } : {}),
      }),
    );
    if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds);

    const document = createEmptyDocument({ id: documentId, prompt: input.prompt, kind: input.kind });
    const repository = getDocumentRepository();
    const existing = await repository.getDocument(userId, documentId);
    if (existing) {
      assertDocumentCreationReplay(existing.document, document);
      return NextResponse.json({ document: await loadDocumentDetail(userId, documentId) });
    }
    try {
      await repository.createDocument(userId, document);
    } catch (error) {
      const raced = await repository.getDocument(userId, documentId);
      if (!raced) throw error;
      assertDocumentCreationReplay(raced.document, document);
    }
    return NextResponse.json({ document: await loadDocumentDetail(userId, document.id) }, { status: 201 });
  } catch (error) {
    if (error instanceof DocumentCreationReplayError) {
      return NextResponse.json(
        { error: { code: "request_conflict", message: "この作成依頼は別の内容です。" } },
        { status: 409 },
      );
    }
    return handleRouteError(error);
  }
}

function assertDocumentCreationReplay(
  existing: ReturnType<typeof createEmptyDocument>,
  requested: ReturnType<typeof createEmptyDocument>,
): void {
  if (
    existing.metadata.title !== requested.metadata.title ||
    existing.metadata.documentType !== requested.metadata.documentType
  ) {
    throw new DocumentCreationReplayError();
  }
}
