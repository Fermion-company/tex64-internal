import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const storeHolder = vi.hoisted(() => ({
  current: null as unknown,
}));

vi.mock("@/server/artifacts", async () => {
  const actual = await vi.importActual<typeof import("@/server/artifacts")>(
    "@/server/artifacts",
  );
  return {
    ...actual,
    getArtifactStore: () => {
      if (!storeHolder.current) throw new Error("Test artifact store is unset.");
      return storeHolder.current;
    },
  };
});

import { SAMPLE_DOCUMENT, SAMPLE_DOCUMENT_IDS } from "@/domain/document";
import { LocalArtifactStore } from "@/server/artifacts/local-artifact-store";
import { compileDocumentRevision } from "@/server/compiler/compile-document-revision";
import { RegionMapSchema } from "@/server/compiler/synctex-regions";
import type { DocumentRepository } from "@/server/persistence";
import { LocalDocumentRepository } from "@/server/persistence/local-repository";

const USER_ID = "90000000-0000-4000-8000-000000000001";
const LUALATEX =
  process.env.TEX64_LUALATEX_PATH ??
  (process.platform === "darwin" ? "/Library/TeX/texbin/lualatex" : "lualatex");

type TestGlobal = typeof globalThis & {
  __tex64DocumentRepository?: DocumentRepository;
};

let temporaryDirectory: string;
let repository: LocalDocumentRepository;
let artifactStore: LocalArtifactStore;

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "tex64-compile-revision-"),
  );
  repository = new LocalDocumentRepository(
    path.join(temporaryDirectory, "store.json"),
  );
  artifactStore = new LocalArtifactStore(
    path.join(temporaryDirectory, "artifacts"),
  );
  (globalThis as TestGlobal).__tex64DocumentRepository = repository;
  storeHolder.current = artifactStore;
});

afterEach(async () => {
  delete (globalThis as TestGlobal).__tex64DocumentRepository;
  storeHolder.current = null;
  await rm(temporaryDirectory, { recursive: true, force: true });
});

function renderableSampleDocument() {
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
        id: "90000000-0000-4000-8000-000000000101",
        label: "開始",
        shape: "terminator",
      },
      {
        id: "90000000-0000-4000-8000-000000000102",
        label: "完了",
        shape: "process",
      },
    ],
    edges: [
      {
        from: "90000000-0000-4000-8000-000000000101",
        to: "90000000-0000-4000-8000-000000000102",
      },
    ],
  };
  return document;
}

describe.skipIf(!existsSync(LUALATEX)).sequential(
  "compileDocumentRevision end to end",
  () => {
    it(
      "compiles the real document and stores a schema-valid region map",
      { timeout: 180_000 },
      async () => {
        const document = renderableSampleDocument();
        await repository.createDocument(USER_ID, document);

        const result = await compileDocumentRevision({
          userId: USER_ID,
          documentId: document.id,
          revision: 1,
                });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.pageCount).toBeGreaterThan(0);

        const artifact = await repository.getArtifact(USER_ID, document.id, 1);
        expect(artifact).toMatchObject({ sha256: result.artifact.sha256 });

        const storedRegions = await artifactStore.readRegions({
          userId: USER_ID,
          documentId: document.id,
          revision: 1,
          pdfSha256: result.artifact.sha256,
        });
        expect(storedRegions).not.toBeNull();
        if (!storedRegions) return;
        const regions = RegionMapSchema.parse(JSON.parse(storedRegions));
        expect(regions.nodes.length).toBeGreaterThan(0);
        const regionIds = new Set(regions.nodes.map((node) => node.id));
        // The sample paragraph must be selectable on the typeset page.
        expect(regionIds.has(SAMPLE_DOCUMENT_IDS.paragraph)).toBe(true);
        for (const node of regions.nodes) {
          expect(node.rects.length).toBeGreaterThan(0);
        }
      },
    );
  },
);
