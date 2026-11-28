type Passage = {
  page: number;
  endPage?: number;
  text: string;
  source?: { path: string; line: number };
  outlineId?: string;
  previous: boolean;
};

function displaySelection(request: string, quote: string, location: string) {
  const chars = Array.from(quote.trim().replace(/\s+/gu, " "));
  const excerpt = chars.length > 100 ? chars.slice(0, 100).join("") + "…" : chars.join("");
  return `${request}\n\n「${excerpt}」（${location}）`;
}

export function paperSelectionRequest(prompt: string, passage: Passage) {
  const { page, endPage, text } = passage;
  const pages = endPage && endPage !== page ? `${page}〜${endPage}ページ` : `${page}ページ`;
  const request = prompt.trim() || "添付ファイルを確認してください。";
  const target = passage.previous
    ? `更新前の紙面からの引用（現在の位置は未確認）\n${JSON.stringify(text)}`
    : passage.outlineId
      ? `原稿の見出し（${pages}）\n${JSON.stringify({ ...passage.source, heading: text })}`
      : `紙面の選択範囲（${pages}）\n${JSON.stringify(text)}`;
  return {
    prompt: `${request}\n\n${target}`,
    displayText: displaySelection(request, text, passage.previous ? "更新前の紙面" : pages),
  };
}

/** Older transcripts stored only the model prompt. Match the exact suffix the app wrote. */
export function legacyPaperDisplayText(prompt: string): string | undefined {
  const separator = prompt.lastIndexOf("\n\n");
  if (separator < 1) return;
  const tail = prompt.slice(separator + 2);
  const line = tail.indexOf("\n");
  if (line < 0) return;
  const label = tail.slice(0, line);
  const previous = label === "更新前の紙面からの引用（現在の位置は未確認）";
  const match = /^(原稿の見出し|紙面の選択範囲)（([1-9]\d*(?:〜[1-9]\d*)?ページ)）$/u.exec(label);
  if (!previous && !match) return;
  try {
    const value: unknown = JSON.parse(tail.slice(line + 1));
    const quote = match?.[1] === "原稿の見出し"
      ? value && typeof value === "object" && "heading" in value && value.heading
      : value;
    if (typeof quote !== "string" || !quote.trim()) return;
    return displaySelection(prompt.slice(0, separator), quote, previous ? "更新前の紙面" : match![2]!);
  } catch {
    return;
  }
}
