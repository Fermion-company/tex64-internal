import { z } from "zod";

import { requireSession } from "@/server/auth";
import {
  artifactViewableByOwner,
  getArtifactStore,
  readVerifiedPdfArtifact,
} from "@/server/artifacts";
import { handleRouteError, jsonError } from "@/server/http/responses";
import { getDocumentRepository } from "@/server/persistence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * Owner-facing PDF preview. Unlike the release-gated sibling route, this also
 * serves the owner's current-revision draft artifact (manual-edit compiles,
 * restores) so the preview never goes dark between agent runs. Bytes are
 * digest-verified exactly like the released path.
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
      !artifact ||
      !artifactViewableByOwner({ document, completedRun, artifact, sha256 })
    ) {
      return jsonError("見つかりませんでした。", 404, "not_found");
    }

    const verified = await readVerifiedPdfArtifact(
      getArtifactStore(),
      artifact,
    );
    if (!verified) {
      return jsonError("見つかりませんでした。", 404, "not_found");
    }

    return new Response(Buffer.from(verified.body), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Length": String(verified.byteSize),
        "Content-Disposition": `inline; filename="document-${revision}.pdf"`,
        "Cache-Control": "private, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
        ETag: `"${sha256}"`,
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
