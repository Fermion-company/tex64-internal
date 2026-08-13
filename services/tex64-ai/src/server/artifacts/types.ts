export type SavePdfInput = {
  userId: string;
  documentId: string;
  revision: number;
  pdf: Uint8Array;
};

export type SavedPdf = {
  storageKey: string;
  byteSize: number;
  sha256: string;
};

export type PdfBody = {
  body: Uint8Array | ReadableStream<Uint8Array>;
  byteSize: number;
  etag?: string;
};

/**
 * Addresses the element-region map derived from one exact PDF. The map is
 * server-authored best-effort data: it shares the PDF's revision+sha address
 * but carries no digest of its own, so readers validate it by schema and
 * size instead of hash binding.
 */
export type ArtifactRegionsRef = {
  userId: string;
  documentId: string;
  revision: number;
  pdfSha256: string;
};

export type SaveRegionsInput = ArtifactRegionsRef & { regionsJson: string };

export interface ArtifactStore {
  savePdf(input: SavePdfInput): Promise<SavedPdf>;
  readPdf(storageKey: string): Promise<PdfBody | null>;
  saveRegions(input: SaveRegionsInput): Promise<void>;
  readRegions(ref: ArtifactRegionsRef): Promise<string | null>;
}
