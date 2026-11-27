"use strict";

// The desktop review uses applied writes and actual compile receipts. Never
// derive an approval or a successful build from the assistant's final prose.
const recordAppliedChange = (service, id, entry, proposal) => {
  if (!id.startsWith("tex64-ai-mode:") || !entry?.runId) return;
  const meta = service.sessionMetaByConversation?.get(id) ?? { createdAt: Date.now() };
  const prior = meta.changeReview?.runId === entry.runId ? meta.changeReview : null;
  const change = {
    path: entry.path,
    type: entry.type,
    ...(entry.oldPath ? { oldPath: entry.oldPath } : {}),
  };
  if (entry.type === "write" && !entry.wasBinary && proposal.encoding !== "base64") {
    const before = (entry.previousBuffer?.toString("utf8") || "").split(/\r?\n/);
    const after = String(proposal.content ?? "").split(/\r?\n/);
    let first = 0;
    while (first < Math.min(before.length, after.length) && before[first] === after[first]) first++;
    let tail = 0;
    while (tail < Math.min(before.length, after.length) - first &&
        before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
    const excerpt = (lines) => {
      const end = lines.length - tail;
      const preview = lines.slice(first, Math.min(first + 3, end)).join("\n");
      return end > first + 3 || preview.length > 380 ? preview.slice(0, 380) + "…" : preview;
    };
    change.line = first + 1;
    change.before = excerpt(before);
    change.after = excerpt(after);
  }
  meta.changeReview = {
    runId: entry.runId,
    build: "unconfirmed",
    changes: [...(prior?.changes ?? []), change].slice(-32),
    count: (prior?.count ?? 0) + 1,
  };
  service.sessionMetaByConversation?.set(id, meta);
};

const acceptChangeReview = async (service, conversationId, expectedRunId) => {
  await service.ensureSessionsRestored();
  const meta = service.sessionMetaByConversation.get(conversationId);
  const review = meta?.changeReview;
  if (!expectedRunId || review?.runId !== expectedRunId) {
    return { ok: false, error: "対象の変更が更新されました。最新の結果を確認してください。" };
  }
  const accepted = { ...review, accepted: true };
  meta.changeReview = accepted;
  try {
    if (await service.persistSession(conversationId) === true) return { ok: true };
  } catch { /* Keep the card available to retry a failed save. */ }
  if (meta.changeReview === accepted) meta.changeReview = review;
  return { ok: false, error: "採用した結果を保存できませんでした。もう一度お試しください。" };
};

module.exports = { acceptChangeReview, recordAppliedChange };
