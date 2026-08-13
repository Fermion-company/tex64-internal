import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const doubles = vi.hoisted(() => ({
  readPdf: vi.fn(),
  savePdf: vi.fn(),
  saveRegions: vi.fn(),
  readRegions: vi.fn(),
  compile: vi.fn(),
  visualReview: vi.fn(),
}));

vi.mock("@/server/artifacts", async () => {
  const actual = await vi.importActual<typeof import("@/server/artifacts")>(
    "@/server/artifacts",
  );
  return {
    ...actual,
    getArtifactStore: () => ({
      readPdf: doubles.readPdf,
      savePdf: doubles.savePdf,
      saveRegions: doubles.saveRegions,
      readRegions: doubles.readRegions,
    }),
  };
});

vi.mock("@/server/compiler", async () => {
  const actual = await vi.importActual<typeof import("@/server/compiler")>(
    "@/server/compiler",
  );
  return {
    ...actual,
    getDocumentCompiler: () => ({ compile: doubles.compile }),
    reviewPdfVisualQuality: doubles.visualReview,
  };
});

import {
  SAMPLE_DOCUMENT,
  SAMPLE_DOCUMENT_IDS,
  extractNodeLineRanges,
  renderDocumentToLatex,
} from "@/domain/document";
import { compileDocumentRevision } from "@/server/compiler/compile-document-revision";
import { buildRegionMap } from "@/server/compiler/synctex-regions";
import type { DocumentRepository } from "@/server/persistence";
import { LocalDocumentRepository } from "@/server/persistence/local-repository";

const USER_ID = "40000000-0000-4000-8000-000000000001";
const PDF = new TextEncoder().encode("%PDF-1.7\n%%EOF\n");
const PDF_SHA256 = createHash("sha256").update(PDF).digest("hex");
const REGION_MARKER_BEGIN = "%%T64B:";
const REGION_MARKER_END = "%%T64E:";

type RepositoryGlobal = typeof globalThis & {
  __tex64DocumentRepository?: DocumentRepository;
};

/** SAMPLE_DOCUMENT with the placeholder figure made renderable for compiles. */
function completionReadyDocument() {
  const document = structuredClone(SAMPLE_DOCUMENT);
  document.schemaVersion = 2;
  const figure = document.nodes.find(
    (node) => node.id === SAMPLE_DOCUMENT_IDS.figure,
  );
  if (figure?.type !== "figure") throw new Error("Sample figure is missing");
  figure.content = {
    kind: "flowDiagram",
    direction: "left-to-right",
    nodes: [
      {
        id: "40000000-0000-4000-8000-000000000101",
        label: "開始",
        shape: "terminator",
      },
      {
        id: "40000000-0000-4000-8000-000000000102",
        label: "完了",
        shape: "process",
      },
    ],
    edges: [
      {
        from: "40000000-0000-4000-8000-000000000101",
        to: "40000000-0000-4000-8000-000000000102",
      },
    ],
  };
  return document;
}

/** Minimal valid synctex whose single in-range fine record votes for voteLine. */
function syntheticSynctex(voteLine: number): Buffer {
  return Buffer.from(
    [
      "SyncTeX Version:1",
      "Input:2:/usr/local/texlive/2024/texmf-dist/tex/latex/base/article.cls",
      "Output:pdf",
      "Magnification:1000",
      "Unit:1",
      "X Offset:0",
      "Y Offset:0",
      "Content:",
      "!100",
      "{1",
      "[1,1:0,0:26607616,44616926,0",
      "Input:1:/tmp/anywhere/./main.tex",
      "(1,1:65536,655360:6553600,327680,65536",
      `x1,${voteLine}:100000,655360`,
      ")",
      "]",
      "}1",
      "Postamble:",
      "Count:5",
    ].join("\n"),
  );
}

describe("extractNodeLineRanges on rendered documents", () => {
  it("recovers balanced, 1-based, marker-exclusive, properly nested ranges", () => {
    const latex = renderDocumentToLatex(SAMPLE_DOCUMENT);
    const lines = latex.split("\n");
    const ranges = extractNodeLineRanges(latex);
    expect(ranges.length).toBeGreaterThan(0);

    // Every begin marker has a matching end marker, and all were consumed.
    const beginCount = lines.filter((line) =>
      line.startsWith(REGION_MARKER_BEGIN),
    ).length;
    const endCount = lines.filter((line) =>
      line.startsWith(REGION_MARKER_END),
    ).length;
    expect(beginCount).toBe(endCount);
    expect(ranges).toHaveLength(beginCount);

    for (const range of ranges) {
      expect(range.start).toBeGreaterThanOrEqual(2);
      expect(range.end).toBeGreaterThanOrEqual(range.start);
      // 1-based range starts right after its begin marker and extends through
      // the end marker plus one following blank line (where \par attribution
      // lands), when one exists.
      expect(lines[range.start - 2]).toBe(`${REGION_MARKER_BEGIN}${range.id}`);
      const endLine = lines[range.end - 1];
      if (endLine === "") {
        expect(lines[range.end - 2]).toBe(`${REGION_MARKER_END}${range.id}`);
      } else {
        expect(endLine).toBe(`${REGION_MARKER_END}${range.id}`);
        expect(lines[range.end] ?? "eof").not.toBe("");
      }
    }

    // Section children nest strictly inside their section's range.
    const byId = new Map(ranges.map((range) => [range.id, range]));
    const assertContained = (parentId: string, childIds: readonly string[]) => {
      const parent = byId.get(parentId);
      if (!parent) throw new Error("Section range is missing");
      for (const childId of childIds) {
        const child = byId.get(childId);
        if (!child) continue; // empty chunks (citation/footnote) stay unmarked
        expect(child.start).toBeGreaterThanOrEqual(parent.start);
        expect(child.end).toBeLessThanOrEqual(parent.end);
      }
    };
    const section = SAMPLE_DOCUMENT.nodes.find(
      (node) => node.id === SAMPLE_DOCUMENT_IDS.section,
    );
    if (section?.type !== "section") throw new Error("Sample section is missing");
    expect(
      section.children.filter((childId) => byId.has(childId)).length,
    ).toBeGreaterThan(0);
    assertContained(section.id, section.children);
    assertContained(SAMPLE_DOCUMENT_IDS.nestedSection, [
      SAMPLE_DOCUMENT_IDS.nestedParagraph,
    ]);
  });

  it("returns no ranges for malformed marker sequences", () => {
    expect(
      extractNodeLineRanges(`${REGION_MARKER_END}orphan\nbody`),
    ).toEqual([]);
    expect(
      extractNodeLineRanges(`${REGION_MARKER_BEGIN}unclosed\nbody`),
    ).toEqual([]);
    expect(
      extractNodeLineRanges(
        `${REGION_MARKER_BEGIN}a\nbody\n${REGION_MARKER_END}b`,
      ),
    ).toEqual([]);
  });
});

describe.sequential("shared compile step region persistence", () => {
  let temporaryDirectory: string;
  let repository: LocalDocumentRepository;

  beforeEach(async () => {
    doubles.readPdf.mockReset();
    doubles.savePdf.mockReset();
    doubles.saveRegions.mockReset();
    doubles.readRegions.mockReset();
    doubles.compile.mockReset();
    doubles.visualReview.mockReset();
    temporaryDirectory = await mkdtemp(
      path.join(tmpdir(), "tex64-compile-regions-"),
    );
    repository = new LocalDocumentRepository(
      path.join(temporaryDirectory, "store.json"),
    );
    (globalThis as RepositoryGlobal).__tex64DocumentRepository = repository;
    await repository.createDocument(USER_ID, completionReadyDocument());
    doubles.savePdf.mockResolvedValue({
      storageKey: "compiled-object.pdf",
      sha256: PDF_SHA256,
      byteSize: PDF.byteLength,
    });
  });

  afterEach(async () => {
    delete (globalThis as RepositoryGlobal).__tex64DocumentRepository;
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  function compileInput() {
    return {
      userId: USER_ID,
      documentId: SAMPLE_DOCUMENT.id,
      revision: 1,
      targetLength: null,
      visualReviewRuntime: null,
    };
  }

  it("saves the derived region map addressed to the stored PDF and skips visual review", async () => {
    const latex = renderDocumentToLatex(completionReadyDocument());
    const ranges = extractNodeLineRanges(latex);
    expect(ranges.length).toBeGreaterThan(0);
    const firstRange = ranges[0];
    if (!firstRange) throw new Error("Rendered ranges are missing");
    const synctex = syntheticSynctex(firstRange.start);
    const expected = buildRegionMap({ synctex, ranges });
    expect(expected).not.toBeNull();
    expect(expected?.nodes.length).toBeGreaterThan(0);
    doubles.compile.mockResolvedValue({
      pdf: PDF,
      engine: "local-lualatex",
      durationMs: 25,
      pageCount: 1,
      diagnostics: [],
      synctex,
    });

    await expect(compileDocumentRevision(compileInput())).resolves.toMatchObject({
      ok: true,
      reused: false,
      artifact: { revision: 1, sha256: PDF_SHA256, byteSize: PDF.byteLength },
    });

    expect(doubles.visualReview).not.toHaveBeenCalled();
    expect(doubles.saveRegions).toHaveBeenCalledOnce();
    const saved = doubles.saveRegions.mock.calls[0]?.[0] as {
      userId: string;
      documentId: string;
      revision: number;
      pdfSha256: string;
      regionsJson: string;
    };
    expect(saved).toMatchObject({
      userId: USER_ID,
      documentId: SAMPLE_DOCUMENT.id,
      revision: 1,
      pdfSha256: PDF_SHA256,
    });
    const parsed = JSON.parse(saved.regionsJson) as { schemaVersion: number };
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed).toEqual(expected);
  });

  it("still succeeds and stores the artifact when region persistence fails", async () => {
    const latex = renderDocumentToLatex(completionReadyDocument());
    const firstRange = extractNodeLineRanges(latex)[0];
    if (!firstRange) throw new Error("Rendered ranges are missing");
    doubles.compile.mockResolvedValue({
      pdf: PDF,
      engine: "local-lualatex",
      durationMs: 25,
      pageCount: 1,
      diagnostics: [],
      synctex: syntheticSynctex(firstRange.start),
    });
    doubles.saveRegions.mockRejectedValue(new Error("regions store unavailable"));

    await expect(compileDocumentRevision(compileInput())).resolves.toMatchObject({
      ok: true,
      reused: false,
    });
    expect(doubles.saveRegions).toHaveBeenCalledOnce();
    await expect(
      repository.getArtifact(USER_ID, SAMPLE_DOCUMENT.id, 1),
    ).resolves.toMatchObject({
      storageKey: "compiled-object.pdf",
      sha256: PDF_SHA256,
      pageCount: 1,
    });
  });

  it("writes no region map when the engine produced no synctex", async () => {
    doubles.compile.mockResolvedValue({
      pdf: PDF,
      engine: "local-lualatex",
      durationMs: 25,
      pageCount: 1,
      diagnostics: [],
    });

    await expect(compileDocumentRevision(compileInput())).resolves.toMatchObject({
      ok: true,
      reused: false,
    });
    expect(doubles.saveRegions).not.toHaveBeenCalled();
    expect(doubles.visualReview).not.toHaveBeenCalled();
  });
});
