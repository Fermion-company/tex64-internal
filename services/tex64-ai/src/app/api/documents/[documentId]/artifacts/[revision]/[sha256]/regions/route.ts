import { z } from "zod";

import { requireSession } from "@/server/auth";
import { artifactViewableByOwner, getArtifactStore } from "@/server/artifacts";
import { RegionMapSchema } from "@/server/compiler/synctex-regions";
import { handleRouteError, jsonError } from "@/server/http/responses";
import { getDocumentRepository } from "@/server/persistence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * Element-region map for one exact PDF. Same visibility as the PDF itself
 * (released, or the owner's current-revision draft); schema-validated on the
 * way out so a corrupt stored map degrades to 404 instead of reaching the UI.
 */
export async function GET(
  _request: Request,
  context: {
    params: Promise<{
      documentId: string;
      revision: string;
      sha256: string;
    }>;
  },
) {
  try {
    const { userId } = await requireSession();
    const {
      documentId,
      revision: revisionInput,
      sha256: sha256Input,
    } = await context.params;
    z.string().uuid().parse(documentId);
    const revision = z.coerce.number().int().positive().parse(revisionInput);
    const sha256 = Sha256Schema.parse(sha256Input);
    const repository = getDocumentRepository();
    const [document, artifact, completedRun] = await Promise.all([
      repository.getDocument(userId, documentId),
      repository.getArtifact(userId, documentId, revision),
      repository.getCompletedRunForRevision(userId, documentId, revision),
    ]);
    if (
      !artifactViewableByOwner({ document, completedRun, artifact, sha256 })
    ) {
      return jsonError("見つかりませんでした。", 404, "not_found");
    }

    const stored = await getArtifactStore().readRegions({
      userId,
      documentId,
      revision,
      pdfSha256: sha256,
    });
    if (!stored) return jsonError("見つかりませんでした。", 404, "not_found");

    let regions: unknown;
    try {
      regions = RegionMapSchema.parse(JSON.parse(stored));
    } catch {
      return jsonError("見つかりませんでした。", 404, "not_found");
    }

    return Response.json(
      { regions },
      {
        headers: {
          "Cache-Control": "private, max-age=31536000, immutable",
          "X-Content-Type-Options": "nosniff",
        },
      },
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
