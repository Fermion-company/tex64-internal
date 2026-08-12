import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../src/server/persistence/migrations/0007_research_ledgers.sql",
  import.meta.url,
);
const repositoryUrl = new URL(
  "../src/server/persistence/postgres-repository.ts",
  import.meta.url,
);

describe("research review persistence boundary", () => {
  it("binds immutable review results to tenant, revision, run and source snapshot", async () => {
    const migration = await readFile(migrationUrl, "utf8");

    expect(migration).toContain(
      "CREATE TABLE IF NOT EXISTS public.tex64_research_ledgers",
    );
    expect(migration).toContain(
      "FOREIGN KEY (user_id, document_id, document_revision)",
    );
    expect(migration).toContain("FOREIGN KEY (user_id, authoring_run_id)");
    expect(migration).toContain("source_snapshot_digest");
    expect(migration).toContain("tex64_research_ledgers_payload_check");
    expect(migration).toContain("tex64_research_ledgers_immutable");
    expect(migration).toContain(
      "ALTER TABLE public.tex64_research_ledgers FORCE ROW LEVEL SECURITY",
    );
    expect(migration).toContain("current_setting('app.tex64_user_id', true)");
  });

  it("uses insert-only replay and tenant/document predicates", async () => {
    const repository = await readFile(repositoryUrl, "utf8");
    const start = repository.indexOf("async saveResearchLedger(");
    const end = repository.indexOf("private async withUser", start);
    const boundary = repository.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(boundary).toContain("parseResearchLedger(ledger)");
    expect(boundary).toContain("ON CONFLICT DO NOTHING");
    expect(boundary).not.toMatch(/UPDATE public\.tex64_research_ledgers/);
    expect(boundary).toMatch(/user_id\s*=\s*\$1/);
    expect(boundary).toMatch(/document_id\s*=\s*\$2/);
  });
});
