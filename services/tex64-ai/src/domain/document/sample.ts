import type { DocumentModel, DocumentRevision, InlineContent, InlineMark, StableId } from "./schema";
import { validateDocument } from "./validate";

export const SAMPLE_DOCUMENT_IDS = Object.freeze({
  document: "10000000-0000-4000-8000-000000000001",
  author: "10000000-0000-4000-8000-000000000002",
  section: "10000000-0000-4000-8000-000000000010",
  heading: "10000000-0000-4000-8000-000000000011",
  paragraph: "10000000-0000-4000-8000-000000000012",
  list: "10000000-0000-4000-8000-000000000013",
  listItem: "10000000-0000-4000-8000-000000000113",
  nestedListItem: "10000000-0000-4000-8000-000000000213",
  equation: "10000000-0000-4000-8000-000000000014",
  figure: "10000000-0000-4000-8000-000000000015",
  table: "10000000-0000-4000-8000-000000000016",
  tableColumnA: "10000000-0000-4000-8000-000000000116",
  tableColumnB: "10000000-0000-4000-8000-000000000216",
  tableRow: "10000000-0000-4000-8000-000000000316",
  callout: "10000000-0000-4000-8000-000000000017",
  pageBreak: "10000000-0000-4000-8000-000000000018",
  citedParagraph: "10000000-0000-4000-8000-000000000019",
  bibliography: "10000000-0000-4000-8000-000000000020",
  citation: "10000000-0000-4000-8000-000000000021",
  footnote: "10000000-0000-4000-8000-000000000022",
  nestedSection: "10000000-0000-4000-8000-000000000023",
  nestedParagraph: "10000000-0000-4000-8000-000000000024",
  initialRevision: "10000000-0000-4000-8000-000000000901",
} as const satisfies Readonly<Record<string, StableId>>);

function text(value: string, marks: InlineMark[] = []): InlineContent[number] {
  return { type: "text", text: value, marks };
}

const rawSampleDocument: DocumentModel = {
  schemaVersion: 1,
  id: SAMPLE_DOCUMENT_IDS.document,
  metadata: {
    title: "AIと人間による文書作成",
    subtitle: "構造化された編集モデルの実例",
    language: "ja-JP",
    documentType: "article",
    authors: [
      {
        id: SAMPLE_DOCUMENT_IDS.author,
        name: "TeX64 Team",
        affiliation: "Document Intelligence Lab",
      },
    ],
    keywords: ["structured document", "agent", "typesetting"],
    createdAt: "2026-08-07T00:00:00.000Z",
    updatedAt: "2026-08-07T00:00:00.000Z",
  },
  root: [SAMPLE_DOCUMENT_IDS.section, SAMPLE_DOCUMENT_IDS.bibliography],
  nodes: [
    {
      id: SAMPLE_DOCUMENT_IDS.section,
      type: "section",
      title: [text("はじめに")],
      children: [
        SAMPLE_DOCUMENT_IDS.heading,
        SAMPLE_DOCUMENT_IDS.paragraph,
        SAMPLE_DOCUMENT_IDS.list,
        SAMPLE_DOCUMENT_IDS.equation,
        SAMPLE_DOCUMENT_IDS.figure,
        SAMPLE_DOCUMENT_IDS.table,
        SAMPLE_DOCUMENT_IDS.callout,
        SAMPLE_DOCUMENT_IDS.citedParagraph,
        SAMPLE_DOCUMENT_IDS.nestedSection,
        SAMPLE_DOCUMENT_IDS.pageBreak,
      ],
    },
    {
      id: SAMPLE_DOCUMENT_IDS.heading,
      type: "heading",
      level: 2,
      content: [text("目的", ["bold"])],
    },
    {
      id: SAMPLE_DOCUMENT_IDS.paragraph,
      type: "paragraph",
      content: [
        text("文書はTeXコードではなく、意味を持つブロックとインライン要素で表現されます。"),
      ],
    },
    {
      id: SAMPLE_DOCUMENT_IDS.list,
      type: "list",
      style: "bullet",
      items: [
        {
          id: SAMPLE_DOCUMENT_IDS.listItem,
          content: [text("人が意図を伝える")],
          children: [
            {
              id: SAMPLE_DOCUMENT_IDS.nestedListItem,
              content: [text("エージェントが構造を更新する", ["italic"])],
              children: [],
            },
          ],
        },
      ],
    },
    {
      id: SAMPLE_DOCUMENT_IDS.equation,
      type: "equation",
      expression: {
        kind: "binary",
        operator: "equals",
        left: { kind: "symbol", name: "y" },
        right: {
          kind: "binary",
          operator: "add",
          left: {
            kind: "binary",
            operator: "multiply",
            left: { kind: "symbol", name: "alpha" },
            right: { kind: "symbol", name: "x" },
          },
          right: { kind: "literal", value: "1" },
        },
      },
      description: [text("単純な線形関係の例")],
      numbered: true,
    },
    {
      id: SAMPLE_DOCUMENT_IDS.figure,
      type: "figure",
      altText: "文書生成フローの図",
      caption: [text("意図から検証済み文書までの流れ")],
      widthPercent: 80,
    },
    {
      id: SAMPLE_DOCUMENT_IDS.table,
      type: "table",
      caption: [text("操作と結果")],
      columns: [
        {
          id: SAMPLE_DOCUMENT_IDS.tableColumnA,
          header: [text("操作", ["bold"])],
          alignment: "left",
        },
        {
          id: SAMPLE_DOCUMENT_IDS.tableColumnB,
          header: [text("結果", ["bold"])],
          alignment: "center",
        },
      ],
      rows: [
        {
          id: SAMPLE_DOCUMENT_IDS.tableRow,
          cells: [
            { columnId: SAMPLE_DOCUMENT_IDS.tableColumnA, content: [text("更新")] },
            { columnId: SAMPLE_DOCUMENT_IDS.tableColumnB, content: [text("新しいrevision")] },
          ],
        },
      ],
    },
    {
      id: SAMPLE_DOCUMENT_IDS.callout,
      type: "callout",
      tone: "info",
      title: [text("安全性")],
      content: [text("本文の文字列は組版前に必ずエスケープされます。")],
    },
    {
      id: SAMPLE_DOCUMENT_IDS.citedParagraph,
      type: "paragraph",
      content: [
        text("構造化編集は再現性を高めます"),
        { type: "citationRef", citationId: SAMPLE_DOCUMENT_IDS.citation, locator: "p. 42" },
        text("。補足情報も参照できます"),
        { type: "footnoteRef", footnoteId: SAMPLE_DOCUMENT_IDS.footnote },
        text("。"),
      ],
    },
    {
      id: SAMPLE_DOCUMENT_IDS.nestedSection,
      type: "section",
      title: [text("検証")],
      children: [SAMPLE_DOCUMENT_IDS.nestedParagraph],
    },
    {
      id: SAMPLE_DOCUMENT_IDS.nestedParagraph,
      type: "paragraph",
      content: [text("保存前に参照整合性と循環を検査します。")],
    },
    {
      id: SAMPLE_DOCUMENT_IDS.pageBreak,
      type: "pageBreak",
    },
    {
      id: SAMPLE_DOCUMENT_IDS.bibliography,
      type: "bibliography",
      title: [text("参考文献")],
      citationIds: [SAMPLE_DOCUMENT_IDS.citation],
    },
    {
      id: SAMPLE_DOCUMENT_IDS.citation,
      type: "citation",
      authors: ["A. Researcher", "B. Writer"],
      title: "Structured Documents for Reliable Agents",
      year: "2026",
      publication: "Journal of Document Systems",
      doi: "10.0000/example.2026.1",
      url: "https://example.com/papers/structured-documents",
    },
    {
      id: SAMPLE_DOCUMENT_IDS.footnote,
      type: "footnote",
      content: [text("この脚注もプレーンテキストと型付き参照だけで構成されます。")],
    },
  ],
};

export const SAMPLE_DOCUMENT: DocumentModel = validateDocument(rawSampleDocument);

export const SAMPLE_DOCUMENT_REVISION: DocumentRevision = {
  revisionId: SAMPLE_DOCUMENT_IDS.initialRevision,
  revision: 0,
  parentRevisionId: null,
  committedAt: "2026-08-07T00:00:00.000Z",
  document: SAMPLE_DOCUMENT,
};
