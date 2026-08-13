BEGIN;

-- Replies always identify the run they continue. Approval and rejection are
-- stored as data rather than inferred from free-form prompt text.
ALTER TABLE public.tex64_agent_runs
  ADD COLUMN IF NOT EXISTS reply_to_run_id uuid,
  ADD COLUMN IF NOT EXISTS decision text;

ALTER TABLE public.tex64_agent_runs
  DROP CONSTRAINT IF EXISTS tex64_agent_runs_decision_check,
  ADD CONSTRAINT tex64_agent_runs_decision_check
    CHECK (decision IS NULL OR decision IN ('approve', 'reject')),
  DROP CONSTRAINT IF EXISTS tex64_agent_runs_reply_decision_check,
  ADD CONSTRAINT tex64_agent_runs_reply_decision_check CHECK (
    (decision IS NULL OR reply_to_run_id IS NOT NULL)
    AND (reply_to_run_id IS NULL OR reply_to_run_id <> id)
  ),
  DROP CONSTRAINT IF EXISTS tex64_agent_runs_reply_to_run_fkey,
  ADD CONSTRAINT tex64_agent_runs_reply_to_run_fkey
    FOREIGN KEY (user_id, reply_to_run_id)
    REFERENCES public.tex64_agent_runs(user_id, id);

CREATE INDEX IF NOT EXISTS tex64_agent_runs_reply_to_run_idx
  ON public.tex64_agent_runs (user_id, reply_to_run_id)
  WHERE reply_to_run_id IS NOT NULL;

-- The exact validated patch proposed by the model is durable before a run can
-- enter needs_input. Resolution updates this row, both runs, and (on approval)
-- the document revision in one database transaction.
CREATE TABLE IF NOT EXISTS public.tex64_pending_document_actions (
  id uuid NOT NULL,
  user_id uuid NOT NULL,
  document_id uuid NOT NULL,
  source_run_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  base_revision integer NOT NULL,
  patch jsonb NOT NULL,
  patch_digest text NOT NULL,
  summary text NOT NULL,
  question text NOT NULL,
  resolved_by_run_id uuid,
  applied_revision integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, source_run_id)
);

ALTER TABLE public.tex64_pending_document_actions
  DROP CONSTRAINT IF EXISTS tex64_pending_actions_status_check,
  ADD CONSTRAINT tex64_pending_actions_status_check
    CHECK (status IN ('pending', 'applied', 'rejected', 'cancelled')),
  DROP CONSTRAINT IF EXISTS tex64_pending_actions_base_revision_check,
  ADD CONSTRAINT tex64_pending_actions_base_revision_check
    CHECK (base_revision > 0),
  DROP CONSTRAINT IF EXISTS tex64_pending_actions_patch_check,
  ADD CONSTRAINT tex64_pending_actions_patch_check CHECK (
    CASE
      WHEN jsonb_typeof(patch) = 'object'
        AND jsonb_typeof(patch -> 'id') = 'string'
        AND (patch ->> 'id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND jsonb_typeof(patch -> 'documentId') = 'string'
        AND (patch ->> 'documentId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND jsonb_typeof(patch -> 'operations') = 'array'
        AND jsonb_array_length(patch -> 'operations') BETWEEN 1 AND 1000
        AND (patch ->> 'baseRevision') ~ '^[0-9]+$'
      THEN COALESCE(
        (patch ->> 'documentId')::uuid = document_id
          AND patch ->> 'baseRevision' = base_revision::text,
        false
      )
      ELSE false
    END
  ),
  DROP CONSTRAINT IF EXISTS tex64_pending_actions_digest_check,
  ADD CONSTRAINT tex64_pending_actions_digest_check
    CHECK (patch_digest ~ '^[0-9a-f]{64}$'),
  DROP CONSTRAINT IF EXISTS tex64_pending_actions_summary_check,
  ADD CONSTRAINT tex64_pending_actions_summary_check
    CHECK (char_length(summary) BETWEEN 1 AND 1000),
  DROP CONSTRAINT IF EXISTS tex64_pending_actions_question_check,
  ADD CONSTRAINT tex64_pending_actions_question_check
    CHECK (char_length(question) BETWEEN 1 AND 500),
  DROP CONSTRAINT IF EXISTS tex64_pending_actions_resolution_check,
  ADD CONSTRAINT tex64_pending_actions_resolution_check CHECK (
    (status = 'pending' AND resolved_by_run_id IS NULL AND applied_revision IS NULL)
    OR (status = 'applied' AND resolved_by_run_id IS NOT NULL AND applied_revision IS NOT NULL)
    OR (status IN ('rejected', 'cancelled') AND resolved_by_run_id IS NOT NULL AND applied_revision IS NULL)
  ),
  DROP CONSTRAINT IF EXISTS tex64_pending_actions_timestamp_check,
  ADD CONSTRAINT tex64_pending_actions_timestamp_check
    CHECK (updated_at >= created_at),
  DROP CONSTRAINT IF EXISTS tex64_pending_actions_document_fkey,
  ADD CONSTRAINT tex64_pending_actions_document_fkey
    FOREIGN KEY (user_id, document_id)
    REFERENCES public.tex64_documents(user_id, id) ON DELETE CASCADE,
  DROP CONSTRAINT IF EXISTS tex64_pending_actions_source_run_fkey,
  ADD CONSTRAINT tex64_pending_actions_source_run_fkey
    FOREIGN KEY (user_id, source_run_id)
    REFERENCES public.tex64_agent_runs(user_id, id) ON DELETE CASCADE,
  DROP CONSTRAINT IF EXISTS tex64_pending_actions_resolved_run_fkey,
  ADD CONSTRAINT tex64_pending_actions_resolved_run_fkey
    FOREIGN KEY (user_id, resolved_by_run_id)
    REFERENCES public.tex64_agent_runs(user_id, id),
  DROP CONSTRAINT IF EXISTS tex64_pending_actions_base_revision_fkey,
  ADD CONSTRAINT tex64_pending_actions_base_revision_fkey
    FOREIGN KEY (user_id, document_id, base_revision)
    REFERENCES public.tex64_document_revisions(user_id, document_id, revision),
  DROP CONSTRAINT IF EXISTS tex64_pending_actions_applied_revision_fkey,
  ADD CONSTRAINT tex64_pending_actions_applied_revision_fkey
    FOREIGN KEY (user_id, document_id, applied_revision)
    REFERENCES public.tex64_document_revisions(user_id, document_id, revision);

CREATE INDEX IF NOT EXISTS tex64_pending_actions_document_status_idx
  ON public.tex64_pending_document_actions (user_id, document_id, status);
CREATE INDEX IF NOT EXISTS tex64_pending_actions_resolved_run_idx
  ON public.tex64_pending_document_actions (user_id, resolved_by_run_id)
  WHERE resolved_by_run_id IS NOT NULL;

ALTER TABLE public.tex64_pending_document_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tex64_pending_document_actions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tex64_user_isolation ON public.tex64_pending_document_actions;
CREATE POLICY tex64_user_isolation ON public.tex64_pending_document_actions
  USING (user_id = NULLIF(current_setting('app.tex64_user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.tex64_user_id', true), '')::uuid);

COMMIT;
