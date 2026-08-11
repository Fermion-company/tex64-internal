import type { DocumentNode } from "../document";

const GENERIC_CRITERION_ANCHORS = new Set([
  "もの",
  "こと",
  "これ",
  "それ",
  "文書",
  "文章",
  "本文",
  "目的",
  "内容",
  "情報",
  "項目",
  "要件",
  "条件",
  "基準",
  "結果",
  "方法",
  "問題",
  "状態",
  "対象",
  "読者",
  "構造",
  "関係",
  "対応",
  "説明",
  "記述",
  "記載",
  "表現",
  "確認",
  "完成",
  "全体",
  "部分",
  "箇所",
  "最新版",
  "章",
  "節",
  "項",
  "図",
  "表",
  "式",
]);

const CRITERION_ANCHOR_PREFIX = /^(?:この|その|当該|該当|上記|下記)/u;
const CRITERION_ANCHOR_SUFFIX =
  /(?:について|に関して|に関する|として|である|です|の|が|を|に|で|は|へ|と|も)$/u;
const WORD_SEGMENTER = new Intl.Segmenter("ja", { granularity: "word" });

const NON_CONTENT_KEYS = new Set([
  "id",
  "type",
  "kind",
  "operator",
  "format",
  "targetType",
  "style",
  "tone",
  "alignment",
  "orientation",
  "delimiter",
]);

function collectStrings(value: unknown, key: string | null, output: string[]): void {
  if (typeof value === "string") {
    if (
      key !== null &&
      !NON_CONTENT_KEYS.has(key) &&
      !key.endsWith("Id") &&
      !key.endsWith("Ids")
    ) {
      const candidate = value.trim();
      if (candidate.length > 0) output.push(candidate);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectStrings(item, key, output));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [childKey, childValue] of Object.entries(value)) {
    collectStrings(childValue, childKey, output);
  }
}

/** Returns only user-visible/content-bearing strings, never IDs or type tags. */
export function reviewableNodeFragments(node: DocumentNode): string[] {
  const fragments: string[] = [];
  collectStrings(node, null, fragments);
  return [...new Set(fragments)];
}

/** Evidence quotes are exact: normalization cannot make a fabricated quote pass. */
export function nodeContainsExactExcerpt(
  node: DocumentNode,
  excerpt: string,
): boolean {
  const candidate = excerpt.trim();
  return (
    candidate.length >= 2 &&
    reviewableNodeFragments(node).some((fragment) => fragment.includes(candidate))
  );
}

function anchorSemanticCore(anchor: string): string {
  let core = anchor
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{Sm}]+/gu, "");

  // A model must not make a generic word look specific by adding a deictic
  // prefix or a Japanese case/copular suffix (for example, 「この目的」 or
  // 「文書について」).
  for (let index = 0; index < 2; index += 1) {
    const unwrapped = core
      .replace(CRITERION_ANCHOR_PREFIX, "")
      .replace(CRITERION_ANCHOR_SUFFIX, "");
    if (unwrapped === core) break;
    core = unwrapped;
  }
  return core;
}

function occursOnWordBoundaries(text: string, anchor: string): boolean {
  const starts = new Set<number>();
  const ends = new Set<number>();
  for (const segment of WORD_SEGMENTER.segment(text)) {
    if (segment.isWordLike !== true) continue;
    starts.add(segment.index);
    ends.add(segment.index + segment.segment.length);
  }

  let offset = 0;
  while (offset <= text.length - anchor.length) {
    const index = text.indexOf(anchor, offset);
    if (index < 0) return false;
    if (starts.has(index) && ends.has(index + anchor.length)) return true;
    offset = index + 1;
  }
  return false;
}

/**
 * Binds a model-assessed completion criterion to a literal document excerpt.
 *
 * Exact containment alone is not enough: generic Japanese words such as
 * 「文書」 and 「目的」 occur in unrelated passages, while arbitrary shared
 * character slices can cross word boundaries. A valid anchor must therefore
 * be a non-generic lexical span in both the criterion and the exact excerpt.
 * Short but meaningful Japanese terms such as 「数式」 and 「証明」 remain valid.
 */
export function criterionAnchorBindsExcerpt(input: {
  statement: string;
  excerpt: string;
  anchor: string;
}): boolean {
  const anchor = input.anchor.trim();
  const semanticCore = anchorSemanticCore(anchor);
  if (
    Array.from(semanticCore).length < 2 ||
    GENERIC_CRITERION_ANCHORS.has(semanticCore) ||
    !input.statement.includes(anchor) ||
    !input.excerpt.includes(anchor)
  ) {
    return false;
  }

  return (
    occursOnWordBoundaries(input.statement, anchor) &&
    occursOnWordBoundaries(input.excerpt, anchor)
  );
}
