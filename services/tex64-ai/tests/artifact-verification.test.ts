import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  storedPdfMatchesMetadata,
  type ArtifactStore,
  type PdfBody,
} from "@/server/artifacts";

const PDF = new TextEncoder().encode("%PDF-1.7\n%%EOF\n");
const SHA256 = createHash("sha256").update(PDF).digest("hex");

function storeWith(read: () => Promise<PdfBody | null>): ArtifactStore {
  return {
    readPdf: read,
    savePdf: async () => ({
      storageKey: "unused",
      byteSize: PDF.byteLength,
      sha256: SHA256,
    }),
  };
}

const EXPECTED = {
  storageKey: "user/document/1-hash.pdf",
  byteSize: PDF.byteLength,
  sha256: SHA256,
};

describe("stored artifact reuse", () => {
  it("reuses only bytes that match both stored size and digest", async () => {
    await expect(
      storedPdfMatchesMetadata(
        storeWith(async () => ({ body: PDF, byteSize: PDF.byteLength })),
        EXPECTED,
      ),
    ).resolves.toBe(true);

    await expect(
      storedPdfMatchesMetadata(storeWith(async () => null), EXPECTED),
    ).resolves.toBe(false);
    await expect(
      storedPdfMatchesMetadata(
        storeWith(async () => ({ body: PDF, byteSize: PDF.byteLength + 1 })),
        EXPECTED,
      ),
    ).resolves.toBe(false);
    await expect(
      storedPdfMatchesMetadata(
        storeWith(async () => ({ body: PDF, byteSize: PDF.byteLength })),
        { ...EXPECTED, sha256: "0".repeat(64) },
      ),
    ).resolves.toBe(false);
  });

  it("treats unreadable and truncated stream objects as non-reusable", async () => {
    await expect(
      storedPdfMatchesMetadata(
        storeWith(async () => {
          throw new Error("object store unavailable");
        }),
        EXPECTED,
      ),
    ).resolves.toBe(false);

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(PDF.subarray(0, PDF.byteLength - 1));
        controller.close();
      },
    });
    await expect(
      storedPdfMatchesMetadata(
        storeWith(async () => ({ body: stream, byteSize: PDF.byteLength })),
        EXPECTED,
      ),
    ).resolves.toBe(false);
  });
});
