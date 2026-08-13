import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  MAX_PDF_ARTIFACT_BYTES,
  assertValidPdfArtifact,
} from "@/server/compiler/safety";
import type {
  ArtifactRegionsRef,
  ArtifactStore,
  PdfBody,
  SavePdfInput,
  SavedPdf,
  SaveRegionsInput,
} from "./types";

const SAFE_SEGMENT = /^[0-9a-z-]+$/i;
export const MAX_REGIONS_ARTIFACT_BYTES = 4 * 1024 * 1024;

export class LocalArtifactStore implements ArtifactStore {
  readonly root: string;

  constructor(root = path.join(process.cwd(), ".artifacts")) {
    this.root = path.resolve(root);
  }

  async savePdf(input: SavePdfInput): Promise<SavedPdf> {
    assertSegment(input.userId);
    assertSegment(input.documentId);
    if (!Number.isSafeInteger(input.revision) || input.revision < 1) throw new Error("Invalid artifact revision.");
    assertValidPdfArtifact(input.pdf);

    const sha256 = createHash("sha256").update(input.pdf).digest("hex");
    const storageKey = `${input.userId}/${input.documentId}/${input.revision}-${sha256}.pdf`;
    const destination = this.resolveKey(storageKey);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, input.pdf, { mode: 0o600, flag: "wx" });
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { force: true });
    }
    return {
      storageKey,
      byteSize: input.pdf.byteLength,
      sha256,
    };
  }

  async readPdf(storageKey: string): Promise<PdfBody | null> {
    try {
      const filePath = this.resolveKey(storageKey);
      const metadata = await stat(filePath);
      if (!metadata.isFile() || metadata.size > MAX_PDF_ARTIFACT_BYTES) {
        throw new Error("Invalid local artifact file.");
      }
      const body = await readFile(filePath);
      assertValidPdfArtifact(body);
      const expectedHash = storageKey.match(/-([0-9a-f]{64})\.pdf$/)?.[1];
      const actualHash = createHash("sha256").update(body).digest("hex");
      if (!expectedHash || actualHash !== expectedHash) {
        throw new Error("Local artifact integrity check failed.");
      }
      return { body, byteSize: metadata.size };
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw error;
    }
  }

  async saveRegions(input: SaveRegionsInput): Promise<void> {
    const destination = this.resolveRegionsPath(input);
    const body = Buffer.from(input.regionsJson, "utf8");
    if (body.byteLength > MAX_REGIONS_ARTIFACT_BYTES) {
      throw new Error("Region map exceeds the artifact size limit.");
    }
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, body, { mode: 0o600, flag: "wx" });
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async readRegions(ref: ArtifactRegionsRef): Promise<string | null> {
    try {
      const filePath = this.resolveRegionsPath(ref);
      const metadata = await stat(filePath);
      if (!metadata.isFile() || metadata.size > MAX_REGIONS_ARTIFACT_BYTES) {
        throw new Error("Invalid local region map file.");
      }
      return await readFile(filePath, "utf8");
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw error;
    }
  }

  private resolveRegionsPath(ref: ArtifactRegionsRef): string {
    assertSegment(ref.userId);
    assertSegment(ref.documentId);
    if (!Number.isSafeInteger(ref.revision) || ref.revision < 1) {
      throw new Error("Invalid artifact revision.");
    }
    if (!/^[0-9a-f]{64}$/.test(ref.pdfSha256)) {
      throw new Error("Invalid artifact digest.");
    }
    const resolved = path.resolve(
      this.root,
      ref.userId,
      ref.documentId,
      `${ref.revision}-${ref.pdfSha256}.regions.json`,
    );
    if (!resolved.startsWith(`${this.root}${path.sep}`)) throw new Error("Artifact path escaped its root.");
    return resolved;
  }

  private resolveKey(storageKey: string): string {
    const normalized = storageKey.split("/");
    if (
      normalized.length !== 3 ||
      !SAFE_SEGMENT.test(normalized[0] ?? "") ||
      !SAFE_SEGMENT.test(normalized[1] ?? "") ||
      !/^[1-9]\d*-[0-9a-f]{64}\.pdf$/.test(normalized[2] ?? "")
    ) {
      throw new Error("Invalid artifact key.");
    }
    const resolved = path.resolve(this.root, ...normalized);
    if (!resolved.startsWith(`${this.root}${path.sep}`)) throw new Error("Artifact path escaped its root.");
    return resolved;
  }
}

function assertSegment(value: string): void {
  if (!SAFE_SEGMENT.test(value)) throw new Error("Invalid artifact identifier.");
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
