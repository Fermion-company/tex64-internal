import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BlobArtifactStore,
  readVerifiedBlobPdf,
} from "@/server/artifacts/blob-artifact-store";
import { LocalArtifactStore } from "@/server/artifacts/local-artifact-store";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("local PDF artifact store", () => {
  it("persists a validated content-addressed PDF and reads it with integrity checking", async () => {
    const root = await temporaryRoot();
    const store = new LocalArtifactStore(root);
    const pdf = validPdf();
    const saved = await store.savePdf({
      userId: "local-user",
      documentId: "local-document",
      revision: 3,
      pdf,
    });

    expect(saved.sha256).toBe(createHash("sha256").update(pdf).digest("hex"));
    expect(saved.storageKey).toBe(
      `local-user/local-document/3-${saved.sha256}.pdf`,
    );
    const read = await store.readPdf(saved.storageKey);
    expect(read?.body).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(read?.body as Uint8Array)).toEqual(pdf);
  });

  it("rejects malformed output before it is stored", async () => {
    const store = new LocalArtifactStore(await temporaryRoot());
    await expect(
      store.savePdf({
        userId: "local-user",
        documentId: "local-document",
        revision: 1,
        pdf: Buffer.alloc(128, "x"),
      }),
    ).rejects.toThrow();
  });

  it("detects a corrupted content-addressed file on read", async () => {
    const root = await temporaryRoot();
    const store = new LocalArtifactStore(root);
    const saved = await store.savePdf({
      userId: "local-user",
      documentId: "local-document",
      revision: 1,
      pdf: validPdf(),
    });
    const replacement = Buffer.from(`%PDF-1.7\n${"changed".repeat(12)}\n%%EOF\n`);
    await writeFile(path.join(root, ...saved.storageKey.split("/")), replacement);

    await expect(store.readPdf(saved.storageKey)).rejects.toThrow(
      "integrity check failed",
    );
  });
});

describe("blob PDF artifact boundaries", () => {
  it("rejects non-canonical tenant identifiers before making a blob request", async () => {
    await expect(
      new BlobArtifactStore().savePdf({
        userId: "------------------------------------",
        documentId: "6bbd735b-1c01-4af1-be07-1b4a86091cbe",
        revision: 1,
        pdf: validPdf(),
      }),
    ).rejects.toThrow("Invalid artifact identifier");
  });

  it("buffers a bounded blob response and verifies its content-addressed hash", async () => {
    const pdf = validPdf();
    const sha256 = createHash("sha256").update(pdf).digest("hex");
    const storageKey = `documents/40000000-0000-4000-8000-000000000001/50000000-0000-4000-8000-000000000001/1-${sha256}.pdf`;

    const verified = await readVerifiedBlobPdf({
      storageKey,
      stream: streamBytes(pdf),
      declaredByteSize: pdf.byteLength,
    });
    expect(Buffer.from(verified)).toEqual(pdf);

    const corrupted = Buffer.from(pdf);
    corrupted[20] = corrupted[20] === 32 ? 33 : 32;
    await expect(
      readVerifiedBlobPdf({
        storageKey,
        stream: streamBytes(corrupted),
        declaredByteSize: corrupted.byteLength,
      }),
    ).rejects.toThrow("integrity check failed");
  });

  it("rejects a blob stream that exceeds its declared size", async () => {
    const pdf = validPdf();
    const sha256 = createHash("sha256").update(pdf).digest("hex");
    await expect(
      readVerifiedBlobPdf({
        storageKey: `documents/40000000-0000-4000-8000-000000000001/50000000-0000-4000-8000-000000000001/1-${sha256}.pdf`,
        stream: streamBytes(pdf),
        declaredByteSize: pdf.byteLength - 1,
      }),
    ).rejects.toThrow("exceeded its declared size");
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "tex64-artifacts-test-"));
  roots.push(root);
  return root;
}

function validPdf(): Buffer {
  return Buffer.from(`%PDF-1.7\n1 0 obj\n<<>>\nendobj\n${" ".repeat(64)}\n%%EOF\n`);
}

function streamBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      const middle = Math.floor(bytes.byteLength / 2);
      controller.enqueue(bytes.slice(0, middle));
      controller.enqueue(bytes.slice(middle));
      controller.close();
    },
  });
}
