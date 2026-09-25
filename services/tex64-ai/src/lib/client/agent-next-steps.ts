import type { AgentProposal } from "./types";

export function agentErrorMessage(error: string): string {
  if (/API error 5\d\d\b|fetch failed|Failed to fetch|ECONNREFUSED|ENOTFOUND|network error/i.test(error)) {
    return "AIサービスに接続できませんでした。少し待ってから再開してください。";
  }
  return error;
}

/** Recover an actual failed request; never fabricate findings for an unread document. */
export function defaultNextSteps(failed: boolean, request?: string): AgentProposal[] {
  if (!failed || !request?.trim()) return [];
  return [{
    id: "local-resume",
    title: "中断した依頼を再開",
    reason: "前の依頼がエラーで中断しました。",
    change: request,
    request: `中断した次の依頼を完了してください。保存済みの作業記録を使い、済んだ編集や検証は繰り返さないでください。\n\n${request}`,
    kind: "writing",
  }];
}
