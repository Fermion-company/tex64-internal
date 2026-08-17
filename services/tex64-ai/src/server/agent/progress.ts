/**
 * User-facing progress is deliberately semantic. Compiler output, generated
 * filenames, provider traces, and other implementation details belong in
 * server-side observability, never in this event contract.
 */
export const SEMANTIC_PROGRESS_LABELS = {
  understanding: "ご要望を整理しています",
  planning: "文書の構成を考えています",
  writing: "本文を作成しています",
  checking: "文書を確認しています",
  formatting: "文書を整えています",
  ready: "文書ができました",
  needs_input: "確認したいことがあります",
  failed: "文書の作成を完了できませんでした",
} as const;
