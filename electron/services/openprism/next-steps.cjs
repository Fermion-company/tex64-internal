"use strict";
const fallbackNextSteps = (locale, task) => {
  const ja = !locale || locale === "ja";
  const pending = task?.steps?.filter((step) => step.status !== "done") || [];
  if (pending.length) return pending.slice(0, 3).map((step, index) => ({
    id: `remaining-${index}`, title: step.title.slice(0, 80), kind: "writing",
    request: ja ? `未完了の「${step.title}」を進めてください。保存済みの作業記録と現在の文書を確認し、確認済みの作業は繰り返さないでください。` : `Continue the unfinished step: ${step.title}. Use the saved task and current document; do not repeat completed checks.`,
  }));
  // Optional suggestions come from observed content in the model's current
  // turn. Filling empty slots with generic commands is not agentic behavior.
  return [];
};
module.exports = { fallbackNextSteps };
