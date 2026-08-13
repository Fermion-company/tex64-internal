import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LocalArtifactStore,
  MAX_REGIONS_ARTIFACT_BYTES,
} from "@/server/artifacts/local-artifact-store";
import type { ArtifactRegionsRef } from "@/server/artifacts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function temporaryStore(): Promise<LocalArtifactStore> {
  const root = await mkdtemp(path.join(tmpdir(), "tex64-regions-test-"));
  roots.push(root);
  return new LocalArtifactStore(root);
}

function ref(overrides: Partial<ArtifactRegionsRef> = {}): ArtifactRegionsRef {
  return {
    userId: "40000000-0000-4000-8000-000000000001",
    documentId: "10000000-0000-4000-8000-000000000001",
    revision: 1,
    pdfSha256: "a".repeat(64),
    ...overrides,
  };
}

const REGIONS_JSON = JSON.stringify({
  schemaVersion: 1,
  nodes: [
    {
      id: "10000000-0000-4000-8000-000000000010",
      rects: [{ page: 1, x: 72, y: 100.5, width: 200, height: 12.25 }],
    },
  ],
});

describe("local region-map artifact store", () => {
  it("round-trips the exact JSON for the addressed PDF and misses cleanly otherwise", async () => {
    const store = await temporaryStore();
    await store.saveRegions({ ...ref(), regionsJson: REGIONS_JSON });

    await expect(store.readRegions(ref())).resolves.toBe(REGIONS_JSON);

    // Same revision but a different exact PDF: the map does not apply.
    await expect(
      store.readRegions(ref({ pdfSha256: "b".repeat(64) })),
    ).resolves.toBeNull();
    // Never-written address: absence, not an error.
    await expect(store.readRegions(ref({ revision: 2 }))).resolves.toBeNull();
  });

  it("rejects a region map above the size limit before writing anything", async () => {
    const store = await temporaryStore();
    const oversized = "x".repeat(MAX_REGIONS_ARTIFACT_BYTES + 1);

    await expect(
      store.saveRegions({ ...ref(), regionsJson: oversized }),
    ).rejects.toThrow("Region map exceeds the artifact size limit.");
    await expect(store.readRegions(ref())).resolves.toBeNull();

    // Exactly at the limit is allowed.
    await store.saveRegions({
      ...ref(),
      regionsJson: "y".repeat(MAX_REGIONS_ARTIFACT_BYTES),
    });
    await expect(store.readRegions(ref())).resolves.toBe(
      "y".repeat(MAX_REGIONS_ARTIFACT_BYTES),
    );
  });

  it("rejects malformed region references on save and read", async () => {
    const store = await temporaryStore();

    await expect(
      store.saveRegions({
        ...ref({ userId: "../escape" }),
        regionsJson: REGIONS_JSON,
      }),
    ).rejects.toThrow("Invalid artifact identifier.");
    await expect(
      store.saveRegions({
        ...ref({ documentId: "nested/segment" }),
        regionsJson: REGIONS_JSON,
      }),
    ).rejects.toThrow("Invalid artifact identifier.");
    await expect(
      store.saveRegions({ ...ref({ revision: 0 }), regionsJson: REGIONS_JSON }),
    ).rejects.toThrow("Invalid artifact revision.");
    await expect(
      store.saveRegions({
        ...ref({ revision: 1.5 }),
        regionsJson: REGIONS_JSON,
      }),
    ).rejects.toThrow("Invalid artifact revision.");
    await expect(
      store.saveRegions({
        ...ref({ pdfSha256: "z".repeat(64) }),
        regionsJson: REGIONS_JSON,
      }),
    ).rejects.toThrow("Invalid artifact digest.");
    await expect(
      store.saveRegions({
        ...ref({ pdfSha256: "abc123" }),
        regionsJson: REGIONS_JSON,
      }),
    ).rejects.toThrow("Invalid artifact digest.");
    await expect(
      store.saveRegions({
        ...ref({ pdfSha256: "A".repeat(64) }),
        regionsJson: REGIONS_JSON,
      }),
    ).rejects.toThrow("Invalid artifact digest.");

    // Reads validate the same reference shape instead of touching the disk.
    await expect(
      store.readRegions(ref({ userId: "../escape" })),
    ).rejects.toThrow("Invalid artifact identifier.");
    await expect(store.readRegions(ref({ revision: 0 }))).rejects.toThrow(
      "Invalid artifact revision.",
    );
    await expect(
      store.readRegions(ref({ pdfSha256: "not-a-digest" })),
    ).rejects.toThrow("Invalid artifact digest.");
  });

  it("replaces the stored map when the same reference is written again", async () => {
    const store = await temporaryStore();
    await store.saveRegions({ ...ref(), regionsJson: REGIONS_JSON });

    const replacement = JSON.stringify({ schemaVersion: 1, nodes: [] });
    await store.saveRegions({ ...ref(), regionsJson: replacement });

    await expect(store.readRegions(ref())).resolves.toBe(replacement);
  });
});
