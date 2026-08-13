import { createHash } from "node:crypto";

import { DocumentBriefSchema } from "../brief/schema";
import { DocumentSchema } from "../document/schema";
import {
  ArtifactDigestSchema,
  ReviewPlanProjectionSchema,
  type ArtifactDigest,
} from "./schema";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalize(nested)]),
  );
}

function digest(value: unknown): ArtifactDigest {
  return ArtifactDigestSchema.parse(
    createHash("sha256")
      .update(JSON.stringify(canonicalize(value)), "utf8")
      .digest("hex"),
  );
}

export function createReviewBriefDigest(value: unknown): ArtifactDigest {
  return digest(DocumentBriefSchema.parse(value));
}

export function createReviewPlanDigest(value: unknown): ArtifactDigest {
  return digest(ReviewPlanProjectionSchema.parse(value));
}

export function createReviewDocumentDigest(value: unknown): ArtifactDigest {
  return digest(DocumentSchema.parse(value));
}
