import { describe, expect, it } from "vitest";
import { asSchema } from "@ai-sdk/provider-utils";

import { DOCUMENT_PATCH_REFERENCE } from "@/server/agent/document-patch-reference";
import { ApplyDocumentPatchInputSchema } from "@/server/agent/document-tools";

/**
 * The model writes patches from the compact reference, not the real JSON
 * Schema. Collect every discriminator and enum member the full schema
 * accepts and require the reference to mention it, so the digest cannot
 * silently drift when the document contract grows.
 */
function collectMentionables(node: unknown, found: Set<string>): void {
  if (Array.isArray(node)) {
    for (const entry of node) collectMentionables(entry, found);
    return;
  }
  if (!node || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  if (typeof record.const === "string") found.add(record.const);
  if (Array.isArray(record.enum)) {
    for (const value of record.enum) {
      if (typeof value === "string") found.add(value);
    }
  }
  for (const value of Object.values(record)) collectMentionables(value, found);
}

describe("document patch reference", () => {
  it("mentions every discriminator and enum member of the real schema", () => {
    const found = new Set<string>();
    collectMentionables(
      asSchema(ApplyDocumentPatchInputSchema as never).jsonSchema,
      found,
    );
    expect(found.size).toBeGreaterThan(80);
    const missing = [...found].filter(
      (value) => !DOCUMENT_PATCH_REFERENCE.includes(value),
    );
    expect(missing).toEqual([]);
  });

  it("stays small enough to resend on every step", () => {
    expect(DOCUMENT_PATCH_REFERENCE.length).toBeLessThan(8_000);
  });
});
