import { DocumentNotFoundError, getDocumentRepository } from "@/server/persistence";
import { presentAgentRuns, toDocumentDetail } from "./document-view";

export async function loadDocumentDetail(userId: string, documentId: string) {
  const repository = getDocumentRepository();
  const stored = await repository.getDocument(userId, documentId);
  if (!stored) throw new DocumentNotFoundError();
  const [revisions, runs, artifact, completedRun] = await Promise.all([
    repository.listRevisions(userId, documentId, { limit: 50 }),
    repository.listRuns(userId, documentId, { limit: 50 }),
    repository.getArtifact(userId, documentId, stored.currentRevision),
    repository.getCompletedRunForRevision(
      userId,
      documentId,
      stored.currentRevision,
    ),
  ]);
  const presentedRuns = await presentAgentRuns(repository, userId, runs);
  return toDocumentDetail({
    stored,
    revisions,
    runs,
    presentedRuns,
    artifact,
    completedRun,
  });
}
