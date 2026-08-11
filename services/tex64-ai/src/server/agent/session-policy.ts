import type { DocumentAgentSession } from "@/domain/brief";
import type {
  DocumentModel,
  DocumentNode,
  DocumentPatch,
} from "@/domain/document";

export type DocumentMutationReadiness =
  | {
      allowed: true;
      reason: "confirmed_brief" | "scoped_legacy_edit";
    }
  | {
      allowed: false;
      reason:
        | "missing_brief"
        | "unconfirmed_brief"
        | "brief_changed"
        | "wrong_phase";
    };

const CONTRACT_CHANGING_EDIT_PATTERN =
  /(?:全面|全体|全編|書き直|改稿|主題|テーマ|ページ(?:数)?|文字数|構成|章立て|節構成|出典|引用|参考文献|図表|グラフ|チャート|文体|口調|語調|テンプレート|フォーマット|数式|式変形|証明|読者|対象者|目的|範囲|要約|翻訳|追加|削除)/u;

const EXACT_TEXT_REPLACEMENT_PATTERN =
  /^(?:本文(?:中)?の)?[「『"]([^」』"\n]{1,120})[」』"]を[「『"]([^」』"\n]{1,120})[」』"]に(?:置換|修正|訂正|直)(?:して|する|してください)?[。.!！]?$/u;
export type ScopedLegacyEditContract =
  | { kind: "exact_text_replacement"; before: string; after: string }
  | { kind: "section_punctuation"; sectionOrdinal: number };

const KANJI_DIGITS: Readonly<Record<string, number>> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};

function sectionOrdinal(value: string): number | null {
  if (/^\d+$/u.test(value)) {
    const parsed = Number.parseInt(value, 10);
    return parsed >= 1 && parsed <= 999 ? parsed : null;
  }
  if (KANJI_DIGITS[value] !== undefined) return KANJI_DIGITS[value];
  const tens = value.match(/^十([一二三四五六七八九])?$/u);
  if (tens) return 10 + (tens[1] ? KANJI_DIGITS[tens[1]] ?? 0 : 0);
  const compound = value.match(/^([二三四五六七八九])十([一二三四五六七八九])?$/u);
  if (!compound) return null;
  return (KANJI_DIGITS[compound[1]!] ?? 0) * 10 +
    (compound[2] ? KANJI_DIGITS[compound[2]] ?? 0 : 0);
}

export function parseStronglyScopedLegacyEdit(
  promptValue: string,
): ScopedLegacyEditContract | null {
  const prompt = promptValue.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (prompt.length === 0 || prompt.length > 500) return null;
  if (CONTRACT_CHANGING_EDIT_PATTERN.test(prompt)) return null;
  const replacement = prompt.match(EXACT_TEXT_REPLACEMENT_PATTERN);
  if (replacement?.[1] && replacement[2] && replacement[1] !== replacement[2]) {
    return {
      kind: "exact_text_replacement",
      before: replacement[1],
      after: replacement[2],
    };
  }
  const punctuation = prompt.match(
    /^第(\d{1,3}|[一二三四五六七八九十百]+)(?:章|節)(?:の|にある)(?:句読点|句点と読点)(?:だけ|のみ)(?:を)?(?:直して|修正して|整えて)(?:ください)?[。.!！]?$/u,
  );
  const ordinal = punctuation?.[1] ? sectionOrdinal(punctuation[1]) : null;
  return ordinal === null
    ? null
    : { kind: "section_punctuation", sectionOrdinal: ordinal };
}

/**
 * Only edits whose target and operation are completely determined may bypass
 * intake for a pre-existing document. Ambiguity deliberately returns false.
 */
export function isStronglyScopedLegacyEdit(promptValue: string): boolean {
  return parseStronglyScopedLegacyEdit(promptValue) !== null;
}

function mapInlineText(value: unknown, transform: (text: string) => string): unknown {
  if (Array.isArray(value)) return value.map((item) => mapInlineText(item, transform));
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (record.type === "text" && typeof record.text === "string") {
    return { ...record, text: transform(record.text) };
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, child]) => [key, mapInlineText(child, transform)]),
  );
}

function nodeContainsInlineText(node: DocumentNode, target: string): boolean {
  let found = false;
  mapInlineText(node, (text) => {
    if (text.includes(target)) found = true;
    return text;
  });
  return found;
}

function nodeWithExactReplacement(
  node: DocumentNode,
  before: string,
  after: string,
): DocumentNode {
  return mapInlineText(node, (text) => text.replaceAll(before, after)) as DocumentNode;
}

const PUNCTUATION_PATTERN = /[、。，．,.!?！？；;：:]/gu;

function punctuationOnlyNodeChange(before: DocumentNode, after: DocumentNode): boolean {
  let changed = false;
  const compare = (left: unknown, right: unknown): boolean => {
    if (Array.isArray(left) || Array.isArray(right)) {
      if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
        return false;
      }
      return left.every((item, index) => compare(item, right[index]));
    }
    if (!left || !right || typeof left !== "object" || typeof right !== "object") {
      return Object.is(left, right);
    }
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const keys = Object.keys(leftRecord);
    if (
      keys.length !== Object.keys(rightRecord).length ||
      keys.some((key) => !(key in rightRecord))
    ) {
      return false;
    }
    if (
      leftRecord.type === "text" &&
      rightRecord.type === "text" &&
      typeof leftRecord.text === "string" &&
      typeof rightRecord.text === "string"
    ) {
      const leftText = leftRecord.text;
      const rightText = rightRecord.text;
      if (leftText !== rightText) {
        if (
          leftText.replace(PUNCTUATION_PATTERN, "") !==
          rightText.replace(PUNCTUATION_PATTERN, "")
        ) {
          return false;
        }
        changed = true;
      }
      return keys
        .filter((key) => key !== "text")
        .every((key) => compare(leftRecord[key], rightRecord[key]));
    }
    return keys.every((key) => compare(leftRecord[key], rightRecord[key]));
  };
  return compare(before, after) && changed;
}

function sectionSubtreeIds(document: DocumentModel, ordinal: number): Set<string> | null {
  const sections = document.root
    .map((id) => document.nodes.find((node) => node.id === id))
    .filter(
      (node): node is Extract<DocumentNode, { type: "section" }> =>
        node?.type === "section",
    );
  const section = sections[ordinal - 1];
  if (!section) return null;
  const byId = new Map(document.nodes.map((node) => [node.id, node]));
  const ids = new Set<string>();
  const visit = (id: string): void => {
    if (ids.has(id)) return;
    const node = byId.get(id);
    if (!node) return;
    ids.add(id);
    if (node.type === "section" || node.type === "theorem" || node.type === "proof" || node.type === "appendix") {
      node.children.forEach(visit);
    }
  };
  visit(section.id);
  return ids;
}

/** Binds the bypass to the exact proposed patch, not merely to prompt wording. */
export function patchMatchesScopedLegacyEdit(input: {
  contract: ScopedLegacyEditContract;
  document: DocumentModel;
  currentRevision: number;
  patch: DocumentPatch;
}): boolean {
  if (
    input.patch.documentId !== input.document.id ||
    input.patch.baseRevision !== input.currentRevision ||
    input.patch.operations.some((operation) => operation.op !== "update")
  ) {
    return false;
  }
  const byId = new Map(input.document.nodes.map((node) => [node.id, node]));
  const updates = input.patch.operations.filter(
    (operation): operation is Extract<DocumentPatch["operations"][number], { op: "update" }> =>
      operation.op === "update",
  );
  if (new Set(updates.map((operation) => operation.nodeId)).size !== updates.length) {
    return false;
  }

  if (input.contract.kind === "exact_text_replacement") {
    const contract = input.contract;
    const targets = input.document.nodes.filter((node) =>
      nodeContainsInlineText(node, contract.before),
    );
    if (targets.length === 0 || targets.length !== updates.length) return false;
    const targetIds = new Set(targets.map((node) => node.id));
    return updates.every((operation) => {
      const original = byId.get(operation.nodeId);
      return Boolean(
        original &&
          targetIds.has(operation.nodeId) &&
          JSON.stringify(operation.node) ===
            JSON.stringify(
              nodeWithExactReplacement(
                original,
                contract.before,
                contract.after,
              ),
            ),
      );
    });
  }

  const allowedIds = sectionSubtreeIds(
    input.document,
    input.contract.sectionOrdinal,
  );
  return Boolean(
    allowedIds &&
      updates.length > 0 &&
      updates.every((operation) => {
        const original = byId.get(operation.nodeId);
        return Boolean(
          original &&
            allowedIds.has(operation.nodeId) &&
            punctuationOnlyNodeChange(original, operation.node),
        );
      }),
  );
}

/**
 * Server-side boundary for document mutation. The model cannot prompt its way
 * around this decision: a new document remains immutable until the current
 * brief has been explicitly confirmed and the workflow enters drafting.
 */
export function documentMutationReadiness(input: {
  session: DocumentAgentSession | null;
  documentHasContent: boolean;
  scopedLegacyEdit?: boolean;
}): DocumentMutationReadiness {
  if (!input.session) {
    if (input.documentHasContent && input.scopedLegacyEdit === true) {
      return { allowed: true, reason: "scoped_legacy_edit" };
    }
    return { allowed: false, reason: "missing_brief" };
  }
  if (input.session.confirmedBriefVersion === null) {
    return { allowed: false, reason: "unconfirmed_brief" };
  }
  if (input.session.confirmedBriefVersion !== input.session.briefVersion) {
    return { allowed: false, reason: "brief_changed" };
  }
  if (
    input.session.phase !== "drafting" &&
    input.session.phase !== "reviewing"
  ) {
    return { allowed: false, reason: "wrong_phase" };
  }
  return { allowed: true, reason: "confirmed_brief" };
}
