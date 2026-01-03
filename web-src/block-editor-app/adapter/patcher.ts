import type { Document, DocumentBlock } from "@/lib/document/types";
import { serializeBlock } from "@/lib/document/serializer";
import type { BlockEntry } from "./blockParser";

export type PatchOperation = {
  entry: BlockEntry;
  replacement: string;
};

const joinWithSpacing = (parts: string[]) => {
  const cleaned = parts.map((part) => part || "").filter((part) => part.length > 0);
  if (cleaned.length === 0) return "";
  return cleaned.reduce((acc, part) => {
    if (!acc) return part;
    const accEndsWithNewline = acc.endsWith("\n");
    const partStartsWithNewline = part.startsWith("\n");
    if (accEndsWithNewline && partStartsWithNewline) return acc + part;
    if (accEndsWithNewline || partStartsWithNewline) return `${acc}\n${part}`;
    return `${acc}\n\n${part}`;
  }, "");
};

const serializeBlocks = (blocks: DocumentBlock[], docClass: string) =>
  joinWithSpacing(blocks.map((block) => serializeBlockForPatch(block, docClass)));

const serializeBlockForPatch = (block: DocumentBlock, docClass: string) => {
  if (block.type === "raw") {
    return block.content.latex || "";
  }
  return serializeBlock(block, docClass);
};

const normalizeForCompare = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(normalizeForCompare);
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => key !== "id")
      .sort();
    const next: Record<string, unknown> = {};
    keys.forEach((key) => {
      next[key] = normalizeForCompare(record[key]);
    });
    return next;
  }
  return value;
};

const isSameBlockContent = (a?: DocumentBlock, b?: DocumentBlock) => {
  if (!a || !b) return false;
  const normalizedA = normalizeForCompare(a);
  const normalizedB = normalizeForCompare(b);
  return JSON.stringify(normalizedA) === JSON.stringify(normalizedB);
};

const buildLcsTable = (a: string[], b: string[]) => {
  const rows = a.length;
  const cols = b.length;
  const table = Array.from({ length: rows + 1 }, () => Array(cols + 1).fill(0));
  for (let i = 1; i <= rows; i += 1) {
    for (let j = 1; j <= cols; j += 1) {
      if (a[i - 1] === b[j - 1]) {
        table[i][j] = table[i - 1][j - 1] + 1;
      } else {
        table[i][j] = Math.max(table[i - 1][j], table[i][j - 1]);
      }
    }
  }
  return table;
};

const buildLcs = (a: string[], b: string[]) => {
  const table = buildLcsTable(a, b);
  const result: string[] = [];
  let i = a.length;
  let j = b.length;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      result.push(a[i - 1]);
      i -= 1;
      j -= 1;
    } else if (table[i - 1][j] >= table[i][j - 1]) {
      i -= 1;
    } else {
      j -= 1;
    }
  }
  return result.reverse();
};

export const buildPatchOperations = (
  entries: BlockEntry[],
  source: Document,
  draft: Document,
): PatchOperation[] => {
  const sourceIds = entries.map((entry) => entry.id);
  const draftIds = draft.blocks.map((block) => block.id);
  const lcsIds = buildLcs(sourceIds, draftIds);
  const stableSet = new Set(lcsIds);
  const docClass = draft.metadata.documentClass || "article";
  const sourceById = new Map(source.blocks.map((block) => [block.id, block]));

  if (stableSet.size === 0 && entries.length > 0) {
    const fullReplacement = serializeBlocks(draft.blocks, docClass);
    const patches: PatchOperation[] = [{ entry: entries[0], replacement: fullReplacement }];
    for (let i = 1; i < entries.length; i += 1) {
      patches.push({ entry: entries[i], replacement: "" });
    }
    return patches;
  }

  const insertBefore = new Map<string, DocumentBlock[]>();
  let pendingNew: DocumentBlock[] = [];
  let lastStableId: string | null = null;

  for (const block of draft.blocks) {
    if (stableSet.has(block.id)) {
      if (pendingNew.length > 0) {
        insertBefore.set(block.id, pendingNew);
        pendingNew = [];
      }
      lastStableId = block.id;
    } else {
      pendingNew.push(block);
    }
  }

  const appendToLast = pendingNew;

  const draftById = new Map(draft.blocks.map((block) => [block.id, block]));

  return entries
    .map((entry) => {
      const prefixBlocks = insertBefore.get(entry.id) ?? [];
      const suffixBlocks = entry.id === lastStableId ? appendToLast : [];
      const prefix = serializeBlocks(prefixBlocks, docClass);
      const suffix = serializeBlocks(suffixBlocks, docClass);

      if (!stableSet.has(entry.id)) {
        const replacement = joinWithSpacing([prefix, suffix]);
        return { entry, replacement };
      }

      const draftBlock = draftById.get(entry.id);
      const sourceBlock = sourceById.get(entry.id);
      const content = draftBlock
        ? sourceBlock && isSameBlockContent(sourceBlock, draftBlock)
          ? entry.snippet
          : serializeBlockForPatch(draftBlock, docClass)
        : "";
      const replacement = joinWithSpacing([prefix, content, suffix]);
      return { entry, replacement };
    })
    .filter((patch) => patch.replacement !== patch.entry.snippet);
};
