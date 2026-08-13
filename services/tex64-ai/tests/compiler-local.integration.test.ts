import { describe, expect, it } from "vitest";
import { DocumentSchema, SAMPLE_DOCUMENT, renderDocumentToLatex } from "@/domain/document";
import { LocalLatexCompiler } from "@/server/compiler/local-compiler";

describe("local LuaLaTeX compiler", () => {
  it("creates an isolated PDF artifact", async () => {
    const result = await new LocalLatexCompiler().compile({
      userId: "local-user",
      documentId: "local-document",
      revision: 1,
      latex: String.raw`\documentclass{article}
\usepackage{fontspec}
\begin{document}
Hello, TeX64.
\end{document}`,
    });

    expect(Buffer.from(result.pdf.subarray(0, 5)).toString("ascii")).toBe("%PDF-");
    expect(result.engine).toBe("local-lualatex");
  }, 60_000);

  it("typesets the complete Japanese document renderer output", async () => {
    const result = await new LocalLatexCompiler().compile({
      userId: "local-user",
      documentId: SAMPLE_DOCUMENT.id,
      revision: 1,
      latex: renderDocumentToLatex(SAMPLE_DOCUMENT),
    });

    expect(Buffer.from(result.pdf.subarray(0, 5)).toString("ascii")).toBe("%PDF-");
    expect(result.pdf.byteLength).toBeGreaterThan(1_000);
  }, 60_000);

  it("typesets an allowlisted two-column academic layout with IEEE references", async () => {
    const document = structuredClone(SAMPLE_DOCUMENT);
    document.schemaVersion = 2;
    document.metadata.layout = {
      preset: "academic",
      pageSize: "B5",
      columns: 2,
    };
    document.metadata.citationStyle = { schemaVersion: 1, style: "ieee" };
    const result = await new LocalLatexCompiler().compile({
      userId: "local-user",
      documentId: document.id,
      revision: 2,
      latex: renderDocumentToLatex(document),
    });

    expect(Buffer.from(result.pdf.subarray(0, 5)).toString("ascii")).toBe("%PDF-");
    expect(result.pdf.byteLength).toBeGreaterThan(1_000);
  }, 60_000);

  it("typesets a generated document with a long Japanese title", async () => {
    const title =
      "AI文書作成サービスの企画書を、経営会議向けに背景・課題・提案・導入計画・リスクを含めて作成して";
    const sectionId = "58b82e1f-3ca2-45bd-b1bd-32df9c9faba9";
    const paragraphId = "260c6aaa-a3de-40f4-b6ad-d94a378dd270";
    const document = DocumentSchema.parse({
      schemaVersion: 1,
      id: "6bbd735b-1c01-4af1-be07-1b4a86091cbe",
      metadata: {
        title,
        subtitle: "提案書",
        language: "ja",
        documentType: "article",
        authors: [],
        keywords: [],
        createdAt: "2026-08-07T07:38:26.718Z",
        updatedAt: "2026-08-07T07:38:27.922Z",
      },
      root: [sectionId],
      nodes: [
        {
          id: sectionId,
          type: "section",
          title: [{ type: "text", text: "追記", marks: [] }],
          children: [paragraphId],
        },
        {
          id: paragraphId,
          type: "paragraph",
          content: [
            {
              type: "text",
              text: `${title}について、追記の観点から要点を整理する。背景、主要な論点、実行時の留意点を順に示し、読み手が判断しやすい形にまとめる。`,
              marks: [],
            },
          ],
        },
      ],
    });

    const result = await new LocalLatexCompiler().compile({
      userId: "local-user",
      documentId: document.id,
      revision: 2,
      latex: renderDocumentToLatex(document),
    });

    expect(Buffer.from(result.pdf.subarray(0, 5)).toString("ascii")).toBe("%PDF-");
  }, 60_000);
});
