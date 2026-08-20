/**
 * Shared, deterministic helpers that used to live in the (now removed)
 * fallback planner but are load-bearing for the live clarification flow and
 * for replay-stable identifiers in durable workflow steps.
 */

export interface ClarifiedDocumentPromptInput {
  originalPrompt: string;
  question: string;
  answer: string;
}

function normalizePrompt(prompt: string): string {
  return prompt.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function boundedPromptPart(value: string, maximum: number): string {
  return normalizePrompt(value).slice(0, maximum);
}

function isGenericCreationPrompt(prompt: string): boolean {
  return /^(?:(?:論文|文書|レポート|報告書|提案書|メモ)(?:を)?)?(?:書いて|作って|作成して|まとめて)(?:ください)?[。.!！]?$/.test(
    prompt,
  );
}

/**
 * Turns one clarification answer back into a self-contained writing request
 * so the full effective prompt stays reconstructible from the reply chain.
 */
export function buildClarifiedDocumentPrompt(
  input: ClarifiedDocumentPromptInput,
): string {
  const originalPrompt = boundedPromptPart(input.originalPrompt, 20_000);
  const question = boundedPromptPart(input.question, 500);
  const answer = boundedPromptPart(input.answer, 20_000);

  if (!answer) return originalPrompt;

  if (isGenericCreationPrompt(originalPrompt)) {
    const documentKind = /論文/u.test(originalPrompt)
      ? "論文"
      : /レポート|報告書/u.test(originalPrompt)
        ? "レポート"
        : /提案書/u.test(originalPrompt)
          ? "提案書"
          : /メモ/u.test(originalPrompt)
            ? "メモ"
            : "文書";
    const isCompleteWritingRequest =
      /(?:書いて|作って|作成して|まとめて)(?:ください)?/u.test(answer) &&
      /(?:について|に関する|論文|文書|レポート|報告書|提案書|メモ)/u.test(
        answer,
      );
    if (isCompleteWritingRequest) {
      return /(?:論文|文書|レポート|報告書|提案書|メモ)/u.test(answer)
        ? answer
        : `${answer}。${documentKind}として作成して`;
    }

    const subject = answer
      .replace(/^(?:テーマ|題材|内容)(?:は|として)?\s*/u, "")
      .replace(/(?:について)?(?:です|でお願いします)?[。.!！]?$/u, "")
      .trim();
    const normalizedSubject = subject || answer;
    return `${normalizedSubject}について${documentKind}を書いて`;
  }

  // Keeping the original instruction first preserves revision intent (for
  // example, "もっと良くして") while the answer identifies the target.
  return boundedPromptPart(
    `${originalPrompt}。確認事項「${question}」への回答: ${answer}`,
    50_000,
  );
}

function hash32(value: string, seed: number): number {
  let hash = (0x811c9dc5 ^ seed) >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Stable UUIDv4-shaped identifiers keep durable-step output replayable. */
export function deterministicUuid(seed: string): string {
  const hex = [0, 1, 2, 3]
    .map((index) => hash32(`${seed}:${index}`, index * 0x9e3779b9))
    .map((value) => value.toString(16).padStart(8, "0"))
    .join("")
    .split("");

  hex[12] = "4";
  const variant = Number.parseInt(hex[16] ?? "0", 16);
  hex[16] = ((variant & 0x3) | 0x8).toString(16);
  const compact = hex.join("");

  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(
    12,
    16,
  )}-${compact.slice(16, 20)}-${compact.slice(20, 32)}`;
}
