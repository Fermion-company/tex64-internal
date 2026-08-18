import { DocumentNotFoundError, getDocumentRepository } from "@/server/persistence";
import { presentConversation, toDocumentDetail } from "./document-view";

export async function loadDocumentDetail(userId: string, documentId: string) {
  const repository = getDocumentRepository();
  const stored = await repository.getDocument(userId, documentId);
  if (!stored) throw new DocumentNotFoundError();
  const [revisions, messages, artifact, completedRun] = await Promise.all([
    repository.listRevisions(userId, documentId, { limit: 50 }),
    repository.listConversationMessages(userId, documentId),
    repository.getArtifact(userId, documentId, stored.currentRevision),
    repository.getCompletedRunForRevision(
      userId,
      documentId,
      stored.currentRevision,
    ),
  ]);
  return toDocumentDetail({
    stored,
    revisions,
    messages: presentConversation(messages),
    artifact,
    completedRun,
  });
}
