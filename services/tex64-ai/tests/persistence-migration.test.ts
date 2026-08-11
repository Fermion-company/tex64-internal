import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../src/server/persistence/migrations/0001_persistence.sql",
  import.meta.url,
);
const pendingActionsMigrationUrl = new URL(
  "../src/server/persistence/migrations/0002_pending_document_actions.sql",
  import.meta.url,
);
const sharedRateLimitsMigrationUrl = new URL(
  "../src/server/persistence/migrations/0003_shared_rate_limits.sql",
  import.meta.url,
);
const workflowLaunchLeasesMigrationUrl = new URL(
  "../src/server/persistence/migrations/0004_workflow_launch_leases.sql",
  import.meta.url,
);
const artifactQualityMigrationUrl = new URL(
  "../src/server/persistence/migrations/0008_artifact_quality.sql",
  import.meta.url,
);
const artifactReleaseMigrationUrl = new URL(
  "../src/server/persistence/migrations/0009_artifact_release_binding.sql",
  import.meta.url,
);
const repositoryUrl = new URL(
  "../src/server/persistence/postgres-repository.ts",
  import.meta.url,
);

describe("PostgreSQL persistence boundary", () => {
  it("keeps schema DDL in a migration instead of the request-time repository", async () => {
    const [
      migration,
      pendingActionsMigration,
      sharedRateLimitsMigration,
      workflowLaunchLeasesMigration,
      artifactQualityMigration,
      artifactReleaseMigration,
      repository,
    ] = await Promise.all([
      readFile(migrationUrl, "utf8"),
      readFile(pendingActionsMigrationUrl, "utf8"),
      readFile(sharedRateLimitsMigrationUrl, "utf8"),
      readFile(workflowLaunchLeasesMigrationUrl, "utf8"),
      readFile(artifactQualityMigrationUrl, "utf8"),
      readFile(artifactReleaseMigrationUrl, "utf8"),
      readFile(repositoryUrl, "utf8"),
    ]);

    expect(migration).toContain("CREATE TABLE IF NOT EXISTS public.tex64_documents");
    expect(migration).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration).toContain("state_version integer NOT NULL DEFAULT 0");
    expect(migration).toContain("tex64_run_events_idempotency_unique");
    expect(migration).toContain("tex64_agent_runs_state_check");
    expect(pendingActionsMigration).toContain(
      "CREATE TABLE IF NOT EXISTS public.tex64_pending_document_actions",
    );
    expect(sharedRateLimitsMigration).toContain(
      "CREATE TABLE IF NOT EXISTS public.tex64_rate_limit_buckets",
    );
    expect(sharedRateLimitsMigration).toContain(
      "CREATE TABLE IF NOT EXISTS public.tex64_rate_limit_reservations",
    );
    expect(sharedRateLimitsMigration).toContain(
      "PRIMARY KEY (action, scope_kind, scope_hash, window_start)",
    );
    expect(workflowLaunchLeasesMigration).toContain(
      "CREATE TABLE IF NOT EXISTS public.tex64_workflow_launch_leases",
    );
    expect(workflowLaunchLeasesMigration).toContain(
      "ALTER TABLE public.tex64_workflow_launch_leases FORCE ROW LEVEL SECURITY",
    );
    expect(artifactQualityMigration).toContain(
      "ADD COLUMN IF NOT EXISTS page_count integer",
    );
    expect(artifactQualityMigration).toContain(
      "ADD COLUMN IF NOT EXISTS quality_version integer NOT NULL DEFAULT 0",
    );
    expect(artifactReleaseMigration).toContain(
      "ADD COLUMN IF NOT EXISTS result_artifact_sha256 text",
    );
    expect(artifactReleaseMigration).toContain(
      "AND result_artifact_page_count > 0",
    );
    expect(artifactReleaseMigration).toContain(
      "tex64_agent_runs_artifact_release_check",
    );
    expect(pendingActionsMigration).toContain("reply_to_run_id uuid");
    expect(pendingActionsMigration).toContain("decision IN ('approve', 'reject')");
    expect(pendingActionsMigration).toContain("tex64_pending_actions_resolution_check");
    expect(pendingActionsMigration).toContain(
      "ALTER TABLE public.tex64_pending_document_actions FORCE ROW LEVEL SECURITY",
    );
    expect(repository).not.toMatch(/CREATE\s+TABLE/i);
    expect(repository).not.toContain("ensureSchema");
  });

  it("uses tenant predicates as defense in depth in every row read/update/delete query", async () => {
    const repository = await readFile(repositoryUrl, "utf8");
    const statements = repository.match(/(?:SELECT|UPDATE|DELETE)[\s\S]*?(?:`|\")\s*,/g) ?? [];
    const tenantTableStatements = statements.filter((statement) =>
      /public\.tex64_(?:documents|document_revisions|agent_runs|run_events|artifacts|pending_document_actions|source_records)/.test(
        statement,
      ),
    );

    expect(tenantTableStatements.length).toBeGreaterThan(10);
    for (const statement of tenantTableStatements) {
      expect(statement).toMatch(/user_id\s*=/);
    }
  });

  it("locks the run and document while completing with artifact and event in one transaction", async () => {
    const repository = await readFile(repositoryUrl, "utf8");
    const start = repository.indexOf("async completeRunForCurrentRevision(");
    const end = repository.indexOf("async saveArtifact(", start);
    const completion = repository.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(completion).toContain("this.withUser(input.userId");
    expect(completion.match(/FOR UPDATE/g)).toHaveLength(2);
    expect(completion).toMatch(/public\.tex64_artifacts[\s\S]*FOR SHARE/);
    expect(completion).toContain("document.current_revision !== input.revision");
    expect(completion).toContain("updateRunRecord(client, current, prepared)");
    expect(completion).toContain("artifactMatchesRelease(artifact, input.artifact)");
    expect(completion).toContain("releaseBindingsMatch(current.artifactRelease, input.artifact)");
    expect(completion).toContain("insertRunEvent(client");
  });

  it("keeps manuscript JSON out of document and revision index queries", async () => {
    const repository = await readFile(repositoryUrl, "utf8");
    const documentListStart = repository.indexOf("async listDocuments(");
    const documentListEnd = repository.indexOf("async createDocument(", documentListStart);
    const revisionListStart = repository.indexOf("async listRevisions(");
    const revisionListEnd = repository.indexOf("async commitDocument(", revisionListStart);
    const documentList = repository.slice(documentListStart, documentListEnd);
    const revisionList = repository.slice(revisionListStart, revisionListEnd);

    expect(documentList).not.toContain("SELECT *");
    expect(documentList).not.toContain("document_row.document,");
    expect(documentList).toContain("LIMIT $2 OFFSET $3");
    expect(revisionList).not.toContain("SELECT *");
    expect(revisionList).not.toMatch(/\bdocument\b\s*,/);
    expect(revisionList).not.toContain("operations");
    expect(revisionList).toContain("LIMIT $3 OFFSET $4");
  });
});
