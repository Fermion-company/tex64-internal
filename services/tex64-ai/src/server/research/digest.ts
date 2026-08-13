import { createHash } from "node:crypto";

import { ResearchLedgerSchema, type ResearchLedger } from "./schema";

export function canonicalResearchDigest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)), "utf8")
    .digest("hex");
}

export function createResearchLedgerDigest(
  ledger: Omit<ResearchLedger, "ledgerDigest">,
): string {
  return canonicalResearchDigest(ledger);
}

export function assertResearchLedgerDigest(value: unknown): ResearchLedger {
  const ledger = ResearchLedgerSchema.parse(value);
  const { ledgerDigest, ...unsigned } = ledger;
  if (createResearchLedgerDigest(unsigned) !== ledgerDigest) {
    throw new Error("Research evidence ledger digest does not match its contents.");
  }
  return ledger;
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
