import { describe, expect, it, vi } from "vitest";

const blobDoubles = vi.hoisted(() => {
  class MockBlobError extends Error {}
  return {
    MockBlobError,
    get: vi.fn(),
    put: vi.fn(),
  };
});

vi.mock("@vercel/blob", () => ({
  BlobError: blobDoubles.MockBlobError,
  get: blobDoubles.get,
  put: blobDoubles.put,
}));

import { BlobArtifactStore } from "@/server/artifacts/blob-artifact-store";

const USER_ID = "40000000-0000-4000-8000-000000000001";
const DOCUMENT_ID = "50000000-0000-4000-8000-000000000001";

describe("blob write conflicts", () => {
  it("rejects an existing same-size object whose actual hash is different", async () => {
    const requested = validPdf();
    const corrupted = requested.slice();
    corrupted[45] = corrupted[45] === 32 ? 33 : 32;
    blobDoubles.put.mockRejectedValueOnce(
      new blobDoubles.MockBlobError("already exists"),
    );
    blobDoubles.get.mockResolvedValueOnce(blobResponse(corrupted));

    await expect(
      new BlobArtifactStore().savePdf({
        userId: USER_ID,
        documentId: DOCUMENT_ID,
        revision: 1,
        pdf: requested,
      }),
    ).rejects.toThrow("failed integrity verification");
  });

  it("accepts a conflict only after the existing bytes verify", async () => {
    const requested = validPdf();
    blobDoubles.put.mockRejectedValueOnce(
      new blobDoubles.MockBlobError("already exists"),
    );
    blobDoubles.get.mockResolvedValueOnce(blobResponse(requested));

    await expect(
      new BlobArtifactStore().savePdf({
        userId: USER_ID,
        documentId: DOCUMENT_ID,
        revision: 1,
        pdf: requested,
      }),
    ).resolves.toMatchObject({ byteSize: requested.byteLength });
  });
});

function blobResponse(bytes: Uint8Array) {
  return {
    statusCode: 200,
    stream: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    blob: {
      size: bytes.byteLength,
      contentType: "application/pdf",
      etag: "test-etag",
    },
  };
}

function validPdf(): Uint8Array {
  return new TextEncoder().encode(
    `%PDF-1.7\n1 0 obj\n<<>>\nendobj\n${" ".repeat(64)}\n%%EOF\n`,
  );
}
