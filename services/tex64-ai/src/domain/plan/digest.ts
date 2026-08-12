import { createHash } from "node:crypto";

import {
  DocumentBriefSchema,
  type DocumentBrief,
} from "@/domain/brief/schema";
import {
  DocumentBriefDigestSchema,
  type DocumentBriefDigest,
} from "./schema";

/**
 * SHA-256 of canonical JSON. Object key order is ignored; array order and all
 * validated brief fields, including provenance and timestamps, are retained.
 */
export function createDocumentBriefDigest(
  briefValue: DocumentBrief | unknown,
): DocumentBriefDigest {
  const brief = DocumentBriefSchema.parse(briefValue);
  return DocumentBriefDigestSchema.parse(
    createHash("sha256")
      .update(JSON.stringify(canonicalize(brief)), "utf8")
      .digest("hex"),
  );
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalize(nested)]),
  );
}
