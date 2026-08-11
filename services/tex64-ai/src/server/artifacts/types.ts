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

export interface ArtifactStore {
  savePdf(input: SavePdfInput): Promise<SavedPdf>;
  readPdf(storageKey: string): Promise<PdfBody | null>;
}
