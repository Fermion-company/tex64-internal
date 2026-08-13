import { FatalError } from "workflow";

import type {
  DocumentRepository,
  StoredAgentRun,
} from "@/server/persistence";

const MAX_SOURCE_PROMPT_CHAIN_RUNS = 8;

async function requireRun(
  repository: DocumentRepository,
  userId: string,
  runId: string,
): Promise<StoredAgentRun> {
  const run = await repository.getRun(userId, runId);
  if (!run) throw new FatalError("確認履歴を安全に読み取れませんでした。");
  return run;
}

/**
 * Builds the source-authorization surface only from the current durable reply
 * chain. Unrelated prior runs and AI SDK messages are intentionally excluded.
 */
export async function trustedSourcePromptForRun(
  repository: DocumentRepository,
  currentRun: StoredAgentRun,
): Promise<string> {
  if (currentRun.decision !== null) {
    throw new FatalError("確認履歴を安全に読み取れませんでした。");
  }

  const newestFirst = [currentRun.prompt];
  const visited = new Set<string>([currentRun.id]);
  let cursor = currentRun;

  while (cursor.replyToRunId !== null) {
    if (newestFirst.length >= MAX_SOURCE_PROMPT_CHAIN_RUNS) {
      throw new FatalError("確認履歴が長すぎるため、資料を確認できません。");
    }
    if (visited.has(cursor.replyToRunId)) {
      throw new FatalError("確認履歴を安全に読み取れませんでした。");
    }
    visited.add(cursor.replyToRunId);

    const parent = await requireRun(
      repository,
      currentRun.userId,
      cursor.replyToRunId,
    );
    if (
      parent.userId !== currentRun.userId ||
      parent.documentId !== currentRun.documentId ||
      parent.decision !== null
    ) {
      throw new FatalError("確認履歴が現在の文書と一致しません。");
    }
    newestFirst.push(parent.prompt);
    cursor = parent;
  }

  return newestFirst.reverse().join("\n");
}
