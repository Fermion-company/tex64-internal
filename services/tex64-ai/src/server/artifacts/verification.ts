import { createHash } from "node:crypto";

import { MAX_PDF_ARTIFACT_BYTES } from "@/server/compiler/safety";

import type { ArtifactStore, PdfBody } from "./types";

/**
 * Increment whenever reuse requires a stricter PDF inspection contract.
 * v3: compiles emit the SyncTeX-derived element-region map; older artifacts
 * must recompile once so the map exists for the PDF preview.
 */
export const CURRENT_ARTIFACT_QUALITY_VERSION = 3;

export type ExpectedPdfArtifact = {
  storageKey: string;
  sha256: string;
  byteSize: number;
};

export type VerifiedPdfArtifact = {
  body: Uint8Array;
  byteSize: number;
  etag?: string;
};

/**
 * Metadata is reusable only after the backing object has been read and its
 * actual bytes, declared size, and digest all agree.
 */
export async function storedPdfMatchesMetadata(
  store: ArtifactStore,
  expected: ExpectedPdfArtifact,
): Promise<boolean> {
  return Boolean(await readVerifiedPdfArtifact(store, expected));
}

/**
 * Reads once and returns only bytes that match the persisted size and digest.
 * Serving these returned bytes avoids a verify-then-read race at the HTTP edge.
 */
export async function readVerifiedPdfArtifact(
  store: ArtifactStore,
  expected: ExpectedPdfArtifact,
): Promise<VerifiedPdfArtifact | null> {
  try {
    const pdf = await store.readPdf(expected.storageKey);
    if (!pdf) return null;
    if (pdf.byteSize !== expected.byteSize) return null;
    const body = await pdfBytes(pdf);
    if (
      body.byteLength !== expected.byteSize ||
      createHash("sha256").update(body).digest("hex") !== expected.sha256
    ) {
      return null;
    }
    return {
      body,
      byteSize: body.byteLength,
      ...(pdf.etag ? { etag: pdf.etag } : {}),
    };
  } catch {
    return null;
  }
}

async function pdfBytes(pdf: PdfBody): Promise<Uint8Array> {
  if (pdf.body instanceof Uint8Array) return pdf.body;

  const reader = pdf.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteSize = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteSize += value.byteLength;
      if (byteSize > pdf.byteSize || byteSize > MAX_PDF_ARTIFACT_BYTES) {
        await reader.cancel();
        throw new Error("Stored PDF exceeded its declared size.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (byteSize !== pdf.byteSize) {
    throw new Error("Stored PDF did not match its declared size.");
  }
  const body = new Uint8Array(byteSize);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
