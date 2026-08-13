import { createHash } from "node:crypto";
import {
  MAX_PDF_ARTIFACT_BYTES,
  assertValidPdfArtifact,
} from "@/server/compiler/safety";
import { MAX_REGIONS_ARTIFACT_BYTES } from "./local-artifact-store";
import type {
  ArtifactRegionsRef,
  ArtifactStore,
  PdfBody,
  SavePdfInput,
  SavedPdf,
  SaveRegionsInput,
} from "./types";

const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class BlobArtifactStore implements ArtifactStore {
  async savePdf(input: SavePdfInput): Promise<SavedPdf> {
    const { BlobError, put } = await import("@vercel/blob");
    assertIdentifier(input.userId);
    assertIdentifier(input.documentId);
    if (!Number.isSafeInteger(input.revision) || input.revision < 1) {
      throw new Error("Invalid artifact revision.");
    }
    assertValidPdfArtifact(input.pdf);
    const sha256 = createHash("sha256").update(input.pdf).digest("hex");
    const storageKey = `documents/${input.userId}/${input.documentId}/${input.revision}-${sha256}.pdf`;
    let pathname = storageKey;
    try {
      const blob = await put(storageKey, Buffer.from(input.pdf), {
        access: "private",
        addRandomSuffix: false,
        allowOverwrite: false,
        contentType: "application/pdf",
        cacheControlMaxAge: 60 * 60 * 24 * 365,
      });
      if (blob.pathname !== storageKey) {
        throw new Error("Blob artifact pathname was changed unexpectedly.");
      }
      pathname = blob.pathname;
    } catch (error) {
      if (!(error instanceof BlobError)) throw error;
      let existing: PdfBody | null;
      try {
        // A conflicting object is an idempotent success only after reading and
        // hashing the actual bytes. Size/content-type metadata alone cannot
        // distinguish a same-length corrupted object.
        existing = await this.readPdf(storageKey);
      } catch {
        throw new Error("Existing blob artifact failed integrity verification.");
      }
      if (!existing || existing.byteSize !== input.pdf.byteLength) {
        throw new Error("Existing blob artifact does not match the requested PDF.");
      }
      pathname = storageKey;
    }
    return {
      storageKey: pathname,
      byteSize: input.pdf.byteLength,
      sha256,
    };
  }

  async readPdf(storageKey: string): Promise<PdfBody | null> {
    const { get } = await import("@vercel/blob");
    const segments = storageKey.split("/");
    if (
      segments.length !== 4 ||
      segments[0] !== "documents" ||
      !UUID_SEGMENT.test(segments[1] ?? "") ||
      !UUID_SEGMENT.test(segments[2] ?? "") ||
      !/^[1-9]\d*-[0-9a-f]{64}\.pdf$/i.test(segments[3] ?? "")
    ) {
      throw new Error("Invalid blob artifact key.");
    }
    const blob = await get(storageKey, { access: "private", useCache: false });
    if (!blob || blob.statusCode === 304 || !blob.stream || blob.blob.size === null) return null;
    if (
      blob.blob.contentType !== "application/pdf" ||
      blob.blob.size > MAX_PDF_ARTIFACT_BYTES
    ) {
      throw new Error("Invalid blob artifact metadata.");
    }
    const body = await readVerifiedBlobPdf({
      storageKey,
      stream: blob.stream,
      declaredByteSize: blob.blob.size,
    });
    return {
      body,
      byteSize: body.byteLength,
      etag: blob.blob.etag,
    };
  }

  // Regions are derived deterministically from one exact PDF, so overwriting
  // with a recomputed map is idempotent by construction.
  async saveRegions(input: SaveRegionsInput): Promise<void> {
    const { put } = await import("@vercel/blob");
    const body = Buffer.from(input.regionsJson, "utf8");
    if (body.byteLength > MAX_REGIONS_ARTIFACT_BYTES) {
      throw new Error("Region map exceeds the artifact size limit.");
    }
    const storageKey = regionsBlobKey(input);
    const blob = await put(storageKey, body, {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/json",
      cacheControlMaxAge: 60 * 60 * 24 * 365,
    });
    if (blob.pathname !== storageKey) {
      throw new Error("Blob region map pathname was changed unexpectedly.");
    }
  }

  async readRegions(ref: ArtifactRegionsRef): Promise<string | null> {
    const { get } = await import("@vercel/blob");
    const storageKey = regionsBlobKey(ref);
    const blob = await get(storageKey, { access: "private", useCache: false });
    if (!blob || blob.statusCode === 304 || !blob.stream || blob.blob.size === null) return null;
    if (blob.blob.size > MAX_REGIONS_ARTIFACT_BYTES) {
      throw new Error("Invalid blob region map metadata.");
    }
    const chunks: Uint8Array[] = [];
    let received = 0;
    const reader = blob.stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > MAX_REGIONS_ARTIFACT_BYTES) {
          await reader.cancel();
          throw new Error("Blob region map exceeded its size limit.");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks).toString("utf8");
  }
}

function regionsBlobKey(ref: ArtifactRegionsRef): string {
  if (!UUID_SEGMENT.test(ref.userId) || !UUID_SEGMENT.test(ref.documentId)) {
    throw new Error("Invalid artifact identifier.");
  }
  if (!Number.isSafeInteger(ref.revision) || ref.revision < 1) {
    throw new Error("Invalid artifact revision.");
  }
  if (!/^[0-9a-f]{64}$/.test(ref.pdfSha256)) {
    throw new Error("Invalid artifact digest.");
  }
  return `documents/${ref.userId}/${ref.documentId}/${ref.revision}-${ref.pdfSha256}.regions.json`;
}

export async function readVerifiedBlobPdf(input: {
  storageKey: string;
  stream: ReadableStream<Uint8Array>;
  declaredByteSize: number;
}): Promise<Uint8Array> {
  if (
    !Number.isSafeInteger(input.declaredByteSize) ||
    input.declaredByteSize < 0 ||
    input.declaredByteSize > MAX_PDF_ARTIFACT_BYTES
  ) {
    throw new Error("Invalid blob artifact size.");
  }

  const reader = input.stream.getReader();
  const chunks: Uint8Array[] = [];
  let receivedByteSize = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedByteSize += value.byteLength;
      if (
        receivedByteSize > input.declaredByteSize ||
        receivedByteSize > MAX_PDF_ARTIFACT_BYTES
      ) {
        await reader.cancel();
        throw new Error("Blob artifact exceeded its declared size.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (receivedByteSize !== input.declaredByteSize) {
    throw new Error("Blob artifact size did not match its metadata.");
  }

  const body = new Uint8Array(receivedByteSize);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  assertValidPdfArtifact(body);

  const expectedHash = input.storageKey.match(/-([0-9a-f]{64})\.pdf$/i)?.[1]?.toLowerCase();
  const actualHash = createHash("sha256").update(body).digest("hex");
  if (!expectedHash || actualHash !== expectedHash) {
    throw new Error("Blob artifact integrity check failed.");
  }
  return body;
}

function assertIdentifier(value: string): void {
  if (!UUID_SEGMENT.test(value)) throw new Error("Invalid artifact identifier.");
}
