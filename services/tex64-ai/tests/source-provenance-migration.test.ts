import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { CitationNodeSchema } from "@/domain/document";

const migrationUrl = new URL(
  "../src/server/persistence/migrations/0005_source_records.sql",
  import.meta.url,
);
const repositoryUrl = new URL(
  "../src/server/persistence/postgres-repository.ts",
  import.meta.url,
);

describe("source provenance persistence contract", () => {
  it("scopes canonical source records by user and document with forced RLS", async () => {
    const migration = await readFile(migrationUrl, "utf8");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS public.tex64_source_records");
    expect(migration).toContain("UNIQUE (user_id, document_id, canonical_locator)");
    expect(migration).toContain("FOREIGN KEY (user_id, document_id)");
    expect(migration).toContain("ALTER TABLE public.tex64_source_records FORCE ROW LEVEL SECURITY");
    expect(migration).toContain("current_setting('app.tex64_user_id', true)");
    expect(migration).toContain("tex64_source_records_provenance_check");
    expect(migration).toContain("tex64_source_records_immutable");
    expect(migration).toContain("BEFORE UPDATE ON public.tex64_source_records");
  });

  it("serializes first-snapshot insertion and enforces bounded source capacity", async () => {
    const repository = await readFile(repositoryUrl, "utf8");
    const start = repository.indexOf("async saveSourceRecord(");
    const end = repository.indexOf("async getSourceRecord(", start);
    const save = repository.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(save).toContain("SourceRecordSchema.parse(record)");
    expect(save).toContain("pg_advisory_xact_lock");
    expect(save).toContain("canonical_locator = $3");
    expect(save).toContain("count(*)::integer AS source_count");
    expect(save).toContain("sum(octet_length(content_text))");
    expect(save).toContain("assertSourceRecordCapacity");
    expect(save).toContain("ON CONFLICT DO NOTHING");
    expect(save).not.toMatch(/UPDATE public\.tex64_source_records/);
  });

  it("keeps every source lookup tenant and document scoped", async () => {
    const repository = await readFile(repositoryUrl, "utf8");
    const start = repository.indexOf("async getSourceRecord(");
    const end = repository.indexOf("private async withUser", start);
    const reads = repository.slice(start, end);
    const sourceStatements =
      reads.match(/SELECT \* FROM public\.tex64_source_records[\s\S]*?(?:`|\")\s*,/g) ?? [];

    expect(sourceStatements.length).toBeGreaterThanOrEqual(3);
    for (const statement of sourceStatements) {
      expect(statement).toMatch(/user_id\s*=\s*\$1/);
      expect(statement).toMatch(/document_id\s*=\s*\$2/);
    }
  });

  it("keeps citations backward compatible while accepting a verified source reference", () => {
    const legacy = {
      id: "60000000-0000-4000-8000-000000000001",
      type: "citation" as const,
      authors: ["Researcher"],
      title: "A paper",
      year: "2026",
    };
    expect(CitationNodeSchema.safeParse(legacy).success).toBe(true);
    expect(
      CitationNodeSchema.safeParse({
        ...legacy,
        sourceId: "60000000-0000-4000-8000-000000000002",
      }).success,
    ).toBe(true);
    expect(CitationNodeSchema.safeParse({ ...legacy, sourceId: "unverified" }).success).toBe(false);
  });
});
