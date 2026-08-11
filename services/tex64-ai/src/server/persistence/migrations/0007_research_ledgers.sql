BEGIN;

-- Evidence decisions are immutable review artifacts. Scalar columns bind the
-- JSON payload to the exact tenant, revision, plan, source snapshot and
-- independent review run without trusting fields inside JSONB for isolation.
CREATE TABLE IF NOT EXISTS public.tex64_research_ledgers (
  id uuid NOT NULL,
  user_id uuid NOT NULL,
  document_id uuid NOT NULL,
  authoring_run_id uuid NOT NULL,
  document_revision integer NOT NULL,
  document_digest text NOT NULL,
  brief_version integer NOT NULL,
  brief_digest text NOT NULL,
  plan_id uuid NOT NULL,
  plan_version integer NOT NULL,
  plan_digest text NOT NULL,
  source_snapshot_digest text NOT NULL,
  reviewer_run_id uuid NOT NULL,
  ledger_digest text NOT NULL,
  ledger jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, id),
  UNIQUE (
    user_id,
    document_id,
    authoring_run_id,
    document_revision,
    document_digest,
    brief_digest,
    plan_digest,
    source_snapshot_digest,
    reviewer_run_id
  ),
  FOREIGN KEY (user_id, document_id)
    REFERENCES public.tex64_documents(user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, document_id, document_revision)
    REFERENCES public.tex64_document_revisions(user_id, document_id, revision)
    ON DELETE CASCADE,
  FOREIGN KEY (user_id, authoring_run_id)
    REFERENCES public.tex64_agent_runs(user_id, id) ON DELETE CASCADE
);

ALTER TABLE public.tex64_research_ledgers
  DROP CONSTRAINT IF EXISTS tex64_research_ledgers_revision_check,
  ADD CONSTRAINT tex64_research_ledgers_revision_check CHECK (
    document_revision > 0 AND brief_version > 0 AND plan_version > 0
  ),
  DROP CONSTRAINT IF EXISTS tex64_research_ledgers_digest_check,
  ADD CONSTRAINT tex64_research_ledgers_digest_check CHECK (
    document_digest ~ '^[0-9a-f]{64}$'
      AND brief_digest ~ '^[0-9a-f]{64}$'
      AND plan_digest ~ '^[0-9a-f]{64}$'
      AND source_snapshot_digest ~ '^[0-9a-f]{64}$'
      AND ledger_digest ~ '^[0-9a-f]{64}$'
  ),
  DROP CONSTRAINT IF EXISTS tex64_research_ledgers_payload_check,
  ADD CONSTRAINT tex64_research_ledgers_payload_check CHECK (
    jsonb_typeof(ledger) = 'object'
      AND ledger ->> 'id' = id::text
      AND ledger ->> 'userId' = user_id::text
      AND ledger ->> 'documentId' = document_id::text
      AND ledger ->> 'authoringRunId' = authoring_run_id::text
      AND (ledger #>> '{target,documentRevision}')::integer = document_revision
      AND ledger #>> '{target,documentDigest}' = document_digest
      AND (ledger #>> '{target,briefVersion}')::integer = brief_version
      AND ledger #>> '{target,briefDigest}' = brief_digest
      AND ledger #>> '{target,planId}' = plan_id::text
      AND (ledger #>> '{target,planVersion}')::integer = plan_version
      AND ledger #>> '{target,planDigest}' = plan_digest
      AND ledger #>> '{target,sourceSnapshotDigest}' = source_snapshot_digest
      AND ledger #>> '{reviewer,reviewRunId}' = reviewer_run_id::text
      AND ledger ->> 'ledgerDigest' = ledger_digest
      AND (ledger ->> 'createdAt')::timestamptz = created_at
  );

CREATE INDEX IF NOT EXISTS tex64_research_ledgers_target_idx
  ON public.tex64_research_ledgers
  (user_id, document_id, document_revision, created_at DESC);

CREATE OR REPLACE FUNCTION public.tex64_reject_research_ledger_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'research review records are immutable';
END;
$$;

DROP TRIGGER IF EXISTS tex64_research_ledgers_immutable
  ON public.tex64_research_ledgers;
CREATE TRIGGER tex64_research_ledgers_immutable
  BEFORE UPDATE ON public.tex64_research_ledgers
  FOR EACH ROW
  EXECUTE FUNCTION public.tex64_reject_research_ledger_update();

ALTER TABLE public.tex64_research_ledgers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tex64_research_ledgers FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tex64_user_isolation ON public.tex64_research_ledgers;
CREATE POLICY tex64_user_isolation ON public.tex64_research_ledgers
  USING (
    user_id = NULLIF(current_setting('app.tex64_user_id', true), '')::uuid
  )
  WITH CHECK (
    user_id = NULLIF(current_setting('app.tex64_user_id', true), '')::uuid
  );

COMMIT;
