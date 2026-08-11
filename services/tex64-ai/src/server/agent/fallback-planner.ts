import { z } from "zod";

import {
  DocumentPatchSchema,
  DocumentSchema,
  type DocumentModel,
  type DocumentNode,
  type DocumentOperation,
  type DocumentPatch,
} from "./document-contract";
import { workflowNeedsApproval } from "./policy";
import { parseStronglyScopedLegacyEdit } from "./session-policy";

const FALLBACK_TIMESTAMP = "1970-01-01T00:00:00.000Z";

export const FallbackNeedsInputPlanSchema = z
  .object({
    status: z.literal("needs_input"),
    provider: z.literal("deterministic_fallback"),
    question: z.string().min(1).max(500),
  })
  .strict();

export const FallbackOperationPlanSchema = z
  .object({
    status: z.literal("planned"),
    provider: z.literal("deterministic_fallback"),
    mode: z.enum(["create", "update"]),
    title: z.string().min(1).max(1_000),
    outline: z.array(z.string().min(1).max(1_000)).max(100),
    summary: z.string().min(1).max(1_000),
    initialDocument: DocumentSchema,
    patch: DocumentPatchSchema,
    requiresApproval: z.boolean(),
  })
  .strict();

export const DeterministicFallbackPlanSchema = z.discriminatedUnion("status", [
  FallbackNeedsInputPlanSchema,
  FallbackOperationPlanSchema,
]);

export type DeterministicFallbackPlan = z.infer<
  typeof DeterministicFallbackPlanSchema
>;

export interface FallbackPlannerInput {
  prompt: string;
  currentDocument?: DocumentModel | null;
  baseRevision?: number;
  now?: string;
}

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

function isGenericRevisionPrompt(prompt: string): boolean {
  return /^(?:もっと)?(?:良くして|よくして|改善して|直して|修正して|書き直して)(?:ください)?[。.!！]?$/.test(
    prompt,
  );
}

/**
 * Turns one clarification answer back into a self-contained writing request.
 * The deterministic runtime needs this because it cannot infer conversational
 * history, while the model runtime receives the three fields separately.
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

/** Stable UUIDv4-shaped identifiers make fallback output replayable. */
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

function textContent(text: string) {
  return [{ type: "text" as const, text: text.slice(0, 100_000), marks: [] }];
}

function replaceInlineTextInNode(
  node: DocumentNode,
  before: string,
  after: string,
): DocumentNode {
  const replace = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(replace);
    if (!value || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") {
      return { ...record, text: record.text.replaceAll(before, after) };
    }
    return Object.fromEntries(
      Object.entries(record).map(([key, child]) => [key, replace(child)]),
    );
  };
  return replace(node) as DocumentNode;
}

function nodeHasInlineText(node: DocumentNode, target: string): boolean {
  return JSON.stringify(replaceInlineTextInNode(node, target, "")) !==
    JSON.stringify(node);
}

function inlineText(node: DocumentNode): string | undefined {
  const content =
    node.type === "section"
      ? node.title
      : node.type === "heading" || node.type === "paragraph"
        ? node.content
        : undefined;

  return content
    ?.map((part) => (part.type === "text" ? part.text : ""))
    .join("")
    .trim();
}

type ParagraphNode = Extract<DocumentNode, { type: "paragraph" }>;

function singlePlainParagraphText(node: ParagraphNode): string | undefined {
  if (node.content.length !== 1) return undefined;
  const content = node.content[0];
  if (content?.type !== "text" || content.marks.length > 0) return undefined;
  const value = content.text.trim();
  return value || undefined;
}

function conciseParagraph(value: string): string {
  const firstSentence = /^.*?[。！？!?](?:\s|$)/u.exec(value)?.[0]?.trim();
  if (firstSentence && firstSentence.length < value.length) return firstSentence;
  if (value.length <= 160) return value;
  return `${value.slice(0, 157).trimEnd()}…`;
}

function formalizeParagraph(value: string): string {
  const formalized = value
    .replace(/を扱う目的と範囲を明確にする/gu, "を論じる目的と範囲を明確に示す")
    .replace(/実行時の留意点/gu, "実行上の留意点")
    .replace(/順に示し/gu, "順序立てて示し")
    .replace(/読み手が判断しやすい形にまとめる/gu, "読者が検討しやすい構成とする")
    .replace(/要点をまとめ、/gu, "要点を整理し、");
  return formalized === value ? `本稿では、${value}` : formalized;
}

type WholeDocumentAction = "concise" | "add_arguments" | "polish_tone";

function wholeDocumentAction(prompt: string): WholeDocumentAction | undefined {
  if (/^(?:文書全体を)?(?:もっと)?短く(?:して|する|まとめて)?(?:ください)?[。.!！]?$/u.test(prompt)) {
    return "concise";
  }
  if (/論点(?:を)?(?:補|追加)|観点(?:を)?追加/u.test(prompt)) {
    return "add_arguments";
  }
  if (/語調(?:を)?(?:整え|統一)|文体(?:を)?(?:整え|統一)/u.test(prompt)) {
    return "polish_tone";
  }
  return undefined;
}

function explicitTitle(prompt: string): string | undefined {
  const quoted = prompt.match(
    /タイトル(?:を|は|:|：)?\s*[「『"“]([^」』"”]{1,1000})[」』"”]/,
  )?.[1];
  if (quoted) return quoted.trim();

  return prompt
    .match(
      /タイトル(?:を|は|:|：)?\s*([^、。\n]{1,1000}?)(?:に|へ)(?:変更|変え|して|する)/,
    )?.[1]
    ?.trim();
}

function subjectFromPrompt(prompt: string): string {
  const topicalInstruction = prompt.match(
    /^(.{1,200}?)について[、,]\s*.*(?:書いて|作って|まとめて|作成して)(?:ください)?[。.!！]?$/u,
  )?.[1];
  if (topicalInstruction?.trim()) return topicalInstruction.trim();

  const about = prompt.match(
    /(?:「([^」]{1,200})」|(.{1,200}?))について(?:の)?(?:レポート|論文|提案書|企画書|文書|記事|資料|説明)?(?:を)?(?:書|作|まとめ|説明|教え)/,
  );
  const regarding = prompt.match(
    /(?:「([^」]{1,200})」|(.{1,200}?))に関する(?:レポート|論文|提案書|企画書|文書|記事|資料)/,
  );
  const candidate =
    about?.[1] ?? about?.[2] ?? regarding?.[1] ?? regarding?.[2];
  if (candidate?.trim()) return candidate.trim().slice(0, 200);

  const quoted = prompt.match(/[「『]([^」』]{1,200})[」』]/)?.[1];
  if (quoted?.trim()) return quoted.trim();

  const cleaned = prompt
    .replace(
      /(?:について)?(?:レポート|論文|提案書|企画書|文書|記事|資料)?(?:を)?(?:書いて|作って|まとめて|作成して)(?:ください)?[。！!]?$/,
      "",
    )
    .trim();
  return (cleaned || "新しい文書").slice(0, 200);
}

function documentTypeFromPrompt(
  prompt: string,
): DocumentModel["metadata"]["documentType"] {
  if (/論文/.test(prompt)) return "paper";
  if (/提案書|企画書|提案/.test(prompt)) return "proposal";
  if (/レポート|報告書/.test(prompt)) return "report";
  if (/手紙|書簡/.test(prompt)) return "letter";
  if (/メモ|ノート|議事録/.test(prompt)) return "notes";
  return "article";
}

function outlineForPrompt(prompt: string): string[] {
  if (/企画|提案/.test(prompt)) return ["目的", "提案内容", "次のステップ"];
  if (/論文/.test(prompt)) return ["はじめに", "考察", "結論"];
  if (/レポート|報告書/.test(prompt)) return ["概要", "背景", "まとめ"];
  if (/手紙|書簡/.test(prompt)) return ["本文"];
  return ["概要", "詳細", "まとめ"];
}

function bodyForSection(
  section: string,
  subject: string,
  concise = false,
): string {
  const short = {
    はじめに: `${subject}を扱う目的と範囲を明確にする。`,
    概要: `${subject}の目的と要点を簡潔に整理する。`,
    背景: `${subject}が求められる背景と前提を整理する。`,
    考察: `${subject}の主要な論点を比較し、その意味を検討する。`,
    詳細: `${subject}の主要な要素と相互の関係を整理する。`,
    結論: `${subject}の要点をまとめ、今後の判断につなげる。`,
    まとめ: `${subject}の要点をまとめ、次に取るべき行動を示す。`,
    目的: `${subject}で達成する目的と対象を明確にする。`,
    提案内容: `${subject}を実現するための方針と具体策を整理する。`,
    次のステップ: `${subject}を進めるための優先順位と次の行動を示す。`,
    本文: `${subject}について、伝えるべき内容を明確かつ簡潔に述べる。`,
  } as const;

  const first =
    short[section as keyof typeof short] ??
    `${subject}について、${section}の観点から要点を整理する。`;
  if (concise) return first;

  return `${first} 背景、主要な論点、実行時の留意点を順に示し、読み手が判断しやすい形にまとめる。`;
}

function createEmptyDocument(
  documentId: string,
  title: string,
  prompt: string,
  now: string,
): DocumentModel {
  return DocumentSchema.parse({
    schemaVersion: 1,
    id: documentId,
    metadata: {
      title,
      language: "ja",
      documentType: documentTypeFromPrompt(prompt),
      authors: [],
      keywords: [],
      createdAt: now,
      updatedAt: now,
    },
    root: [],
    nodes: [],
  });
}

function createSectionOperations(options: {
  seed: string;
  rootIndex: number;
  sectionTitle: string;
  body: string;
}): DocumentOperation[] {
  const sectionId = deterministicUuid(`${options.seed}:section`);
  const paragraphId = deterministicUuid(`${options.seed}:paragraph`);

  return [
    {
      op: "insert",
      node: {
        id: sectionId,
        type: "section",
        title: textContent(options.sectionTitle),
        children: [],
      },
      position: { kind: "root", index: options.rootIndex },
    },
    {
      op: "insert",
      node: {
        id: paragraphId,
        type: "paragraph",
        content: textContent(options.body),
      },
      position: { kind: "section", parentId: sectionId, index: 0 },
    },
  ];
}

function createPlan(
  prompt: string,
  now: string,
  baseRevision: number,
): DeterministicFallbackPlan {
  const subject = subjectFromPrompt(prompt);
  const title = explicitTitle(prompt) ?? subject;
  const documentId = deterministicUuid(`${prompt}:document`);
  const initialDocument = createEmptyDocument(
    documentId,
    title,
    prompt,
    now,
  );
  const outline = outlineForPrompt(prompt);
  const seed = `${documentId}:${baseRevision}:${prompt}`;
  const operations: DocumentOperation[] = [
    { op: "setMetadata", metadata: initialDocument.metadata },
  ];

  for (const [index, sectionTitle] of outline.entries()) {
    operations.push(
      ...createSectionOperations({
        seed: `${seed}:${index}`,
        rootIndex: index,
        sectionTitle,
        body: bodyForSection(sectionTitle, subject),
      }),
    );
  }

  const patch = DocumentPatchSchema.parse({
    id: deterministicUuid(`${seed}:patch`),
    documentId,
    baseRevision,
    createdAt: now,
    operations,
  });

  return FallbackOperationPlanSchema.parse({
    status: "planned",
    provider: "deterministic_fallback",
    mode: "create",
    title,
    outline,
    summary: `${title}の構成と本文の初稿を作成します。`,
    initialDocument,
    patch,
    requiresApproval: false,
  });
}

/** A newly-created service document has metadata but no visible root nodes. */
export function isEmptyDocument(document: DocumentModel): boolean {
  return document.root.length === 0;
}

function createExistingEmptyDocumentPlan(
  prompt: string,
  currentDocument: DocumentModel,
  now: string,
  baseRevision: number,
): DeterministicFallbackPlan {
  const document = DocumentSchema.parse(currentDocument);
  const subject = subjectFromPrompt(prompt);
  const title = explicitTitle(prompt) ?? subject;
  const outline = outlineForPrompt(prompt);
  const seed = `${document.id}:${baseRevision}:${prompt}:initial-content`;
  const metadata = {
    ...document.metadata,
    title,
    updatedAt: now,
  };
  const operations: DocumentOperation[] = [
    { op: "setMetadata", metadata },
  ];

  for (const [index, sectionTitle] of outline.entries()) {
    operations.push(
      ...createSectionOperations({
        seed: `${seed}:${index}`,
        rootIndex: index,
        sectionTitle,
        body: bodyForSection(sectionTitle, subject),
      }),
    );
  }

  const patch = DocumentPatchSchema.parse({
    id: deterministicUuid(`${seed}:patch`),
    documentId: document.id,
    baseRevision,
    createdAt: now,
    operations,
  });

  return FallbackOperationPlanSchema.parse({
    status: "planned",
    provider: "deterministic_fallback",
    mode: "update",
    title,
    outline,
    summary: `${title}の構成と本文の初稿を作成します。`,
    initialDocument: document,
    patch,
    requiresApproval: false,
  });
}

function namedNode(document: DocumentModel, prompt: string): DocumentNode | undefined {
  return document.nodes
    .map((node) => ({ node, label: inlineText(node) }))
    .filter(
      (entry): entry is { node: DocumentNode; label: string } =>
        Boolean(entry.label),
    )
    .sort((left, right) => right.label.length - left.label.length)
    .find(({ label }) => prompt.includes(label))?.node;
}

function firstParagraphForNode(
  document: DocumentModel,
  target: DocumentNode,
): Extract<DocumentNode, { type: "paragraph" }> | undefined {
  if (target.type === "paragraph") return target;

  if (target.type === "section") {
    for (const childId of target.children) {
      const child = document.nodes.find((node) => node.id === childId);
      if (child?.type === "paragraph") return child;
    }
    return undefined;
  }

  if (target.type === "heading") {
    const rootIndex = document.root.indexOf(target.id);
    for (const nodeId of document.root.slice(rootIndex + 1)) {
      const candidate = document.nodes.find((node) => node.id === nodeId);
      if (!candidate) continue;
      if (candidate.type === "heading" || candidate.type === "section") break;
      if (candidate.type === "paragraph") return candidate;
    }
  }

  return undefined;
}

function requestedSectionTitle(prompt: string): string | undefined {
  return prompt
    .match(
      /[「『]([^」』]{1,100})[」』](?:という)?(?:章|節|セクション)?(?:を)?(?:追加|追記)/,
    )?.[1]
    ?.trim();
}

function existingOutline(document: DocumentModel): string[] {
  return document.root
    .map((id) => document.nodes.find((node) => node.id === id))
    .filter((node): node is DocumentNode => node !== undefined)
    .map(inlineText)
    .filter((text): text is string => Boolean(text));
}

function updatePlan(
  prompt: string,
  currentDocument: DocumentModel,
  now: string,
  baseRevision: number,
): DeterministicFallbackPlan {
  const document = DocumentSchema.parse(currentDocument);
  const scopedEdit = parseStronglyScopedLegacyEdit(prompt);
  if (scopedEdit?.kind === "section_punctuation") {
    return FallbackNeedsInputPlanSchema.parse({
      status: "needs_input",
      provider: "deterministic_fallback",
      question: "その節で直す句読点を具体的に指定してください。",
    });
  }
  if (scopedEdit?.kind === "exact_text_replacement") {
    const targets = document.nodes.filter((node) =>
      nodeHasInlineText(node, scopedEdit.before),
    );
    if (targets.length === 0) {
      return FallbackNeedsInputPlanSchema.parse({
        status: "needs_input",
        provider: "deterministic_fallback",
        question: `「${scopedEdit.before}」が文書内に見つかりません。置換前の文字を確認してください。`,
      });
    }
    const patch = DocumentPatchSchema.parse({
      id: deterministicUuid(
        `${document.id}:${baseRevision}:${prompt}:exact-replacement`,
      ),
      documentId: document.id,
      baseRevision,
      createdAt: now,
      operations: targets.map((node) => ({
        op: "update" as const,
        nodeId: node.id,
        node: replaceInlineTextInNode(
          node,
          scopedEdit.before,
          scopedEdit.after,
        ),
      })),
    });
    return FallbackOperationPlanSchema.parse({
      status: "planned",
      provider: "deterministic_fallback",
      mode: "update",
      title: document.metadata.title,
      outline: existingOutline(document),
      summary: `「${scopedEdit.before}」を「${scopedEdit.after}」に置換します。`,
      initialDocument: document,
      patch,
      requiresApproval: false,
    });
  }
  const title = explicitTitle(prompt) ?? document.metadata.title;
  const subject = document.metadata.title;
  const target = namedNode(document, prompt);
  const wholeAction = target ? undefined : wholeDocumentAction(prompt);
  const operations: DocumentOperation[] = [];
  let outline = existingOutline(document);
  let summary = `${document.metadata.title}を更新します。`;

  if (title !== document.metadata.title) {
    operations.push({
      op: "setMetadata",
      metadata: { ...document.metadata, title, updatedAt: now },
    });
    summary = `タイトルを「${title}」に更新します。`;
  }

  if (wholeAction === "concise" || wholeAction === "polish_tone") {
    for (const node of document.nodes) {
      if (node.type !== "paragraph") continue;
      const current = singlePlainParagraphText(node);
      if (!current) continue;
      const next = wholeAction === "concise"
        ? conciseParagraph(current)
        : formalizeParagraph(current);
      if (next === current) continue;
      operations.push({
        op: "update",
        nodeId: node.id,
        node: { ...node, content: textContent(next) },
      });
    }
    summary = wholeAction === "concise"
      ? "本文全体を簡潔に整えます。"
      : "本文全体の語調を整えます。";
  } else if (wholeAction === "add_arguments") {
    const sectionTitle = "追加の論点";
    operations.push(
      ...createSectionOperations({
        seed: `${document.id}:${baseRevision}:${prompt}:arguments`,
        rootIndex: document.root.length,
        sectionTitle,
        body: `${subject}について、前提、反対意見、今後検証すべき点を加え、議論の射程を明確にする。`,
      }),
    );
    outline = [...outline, sectionTitle];
    summary = "追加の論点を補います。";
  } else if (/削除|消して|取り除/.test(prompt) && target) {
    operations.push({ op: "delete", nodeId: target.id });
    const label = inlineText(target);
    if (label) outline = outline.filter((item) => item !== label);
    summary = `${label ?? "指定された内容"}を削除します。`;
  } else if (/書き直|修正|改善|簡潔|詳しく|加筆/.test(prompt) && target) {
    const paragraph = firstParagraphForNode(document, target);
    if (paragraph) {
      const sectionTitle = inlineText(target) ?? "指定箇所";
      operations.push({
        op: "update",
        nodeId: paragraph.id,
        node: {
          ...paragraph,
          content: textContent(
            bodyForSection(sectionTitle, subject, /簡潔/.test(prompt)),
          ),
        },
      });
      summary = `${sectionTitle}の本文を書き直します。`;
    }
  }

  if (wholeAction && operations.length === 0) {
    return FallbackNeedsInputPlanSchema.parse({
      status: "needs_input",
      provider: "deterministic_fallback",
      question: "どの部分を、どのように変えますか？",
    });
  }

  if (operations.length === 0 || (operations.length === 1 && title !== document.metadata.title && /追加|追記/.test(prompt))) {
    const sectionTitle = requestedSectionTitle(prompt) ?? "追記";
    operations.push(
      ...createSectionOperations({
        seed: `${document.id}:${baseRevision}:${prompt}:append`,
        rootIndex: document.root.length,
        sectionTitle,
        body: bodyForSection(sectionTitle, subject),
      }),
    );
    outline = [...outline, sectionTitle];
    summary = `${sectionTitle}を追記します。`;
  }

  const patch: DocumentPatch = DocumentPatchSchema.parse({
    id: deterministicUuid(`${document.id}:${baseRevision}:${prompt}:patch`),
    documentId: document.id,
    baseRevision,
    createdAt: now,
    operations,
  });

  return FallbackOperationPlanSchema.parse({
    status: "planned",
    provider: "deterministic_fallback",
    mode: "update",
    title,
    outline,
    summary,
    initialDocument: document,
    patch,
    requiresApproval: workflowNeedsApproval("apply_document_patch", {
      patch,
    }),
  });
}

/**
 * Pure, provider-free fallback. Callers inject `now` when they want real
 * timestamps; otherwise the epoch keeps identical inputs byte-for-byte stable.
 */
export function planDocumentDeterministically(
  input: FallbackPlannerInput,
): DeterministicFallbackPlan {
  const prompt = normalizePrompt(input.prompt);
  if (!prompt) {
    return FallbackNeedsInputPlanSchema.parse({
      status: "needs_input",
      provider: "deterministic_fallback",
      question: "どのような文書を作成しますか？",
    });
  }

  const now = input.now ?? FALLBACK_TIMESTAMP;
  z.string().datetime({ offset: true }).parse(now);
  const baseRevision = z
    .number()
    .int()
    .nonnegative()
    .parse(input.baseRevision ?? 0);

  if (!input.currentDocument) return createPlan(prompt, now, baseRevision);

  if (isEmptyDocument(input.currentDocument) && isGenericCreationPrompt(prompt)) {
    return FallbackNeedsInputPlanSchema.parse({
      status: "needs_input",
      provider: "deterministic_fallback",
      question: "何について書きますか？",
    });
  }

  if (!isEmptyDocument(input.currentDocument) && isGenericRevisionPrompt(prompt)) {
    return FallbackNeedsInputPlanSchema.parse({
      status: "needs_input",
      provider: "deterministic_fallback",
      question: "どの部分を、どのように変えますか？",
    });
  }

  return isEmptyDocument(input.currentDocument)
    ? createExistingEmptyDocumentPlan(
        prompt,
        input.currentDocument,
        now,
        baseRevision,
      )
    : updatePlan(prompt, input.currentDocument, now, baseRevision);
}
