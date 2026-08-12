BEGIN;

-- Run this migration with a schema-owner/migration role. The application role
-- only needs DML privileges and must not have BYPASSRLS.
CREATE TABLE IF NOT EXISTS public.tex64_documents (
  id uuid NOT NULL,
  user_id uuid NOT NULL,
  title text NOT NULL,
  document jsonb NOT NULL,
  current_revision integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, id)
);

CREATE TABLE IF NOT EXISTS public.tex64_document_revisions (
  user_id uuid NOT NULL,
  document_id uuid NOT NULL,
  commit_id uuid NOT NULL,
  revision integer NOT NULL,
  document jsonb NOT NULL,
  actor text NOT NULL,
  summary text NOT NULL,
  operations jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, document_id, revision),
  UNIQUE (user_id, document_id, commit_id),
  FOREIGN KEY (user_id, document_id)
    REFERENCES public.tex64_documents(user_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.tex64_agent_runs (
  id uuid NOT NULL,
  user_id uuid NOT NULL,
  document_id uuid NOT NULL,
  prompt text NOT NULL,
  idempotency_key text NOT NULL,
  workflow_run_id text,
  status text NOT NULL DEFAULT 'queued',
  stage text NOT NULL DEFAULT 'understanding',
  base_revision integer NOT NULL,
  result_revision integer,
  error_message text,
  state_version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, document_id, idempotency_key),
  FOREIGN KEY (user_id, document_id)
    REFERENCES public.tex64_documents(user_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.tex64_run_events (
  user_id uuid NOT NULL,
  run_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  sequence integer NOT NULL,
  stage text NOT NULL,
  message text NOT NULL,
  detail jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, run_id, sequence),
  FOREIGN KEY (user_id, run_id)
    REFERENCES public.tex64_agent_runs(user_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.tex64_artifacts (
  user_id uuid NOT NULL,
  document_id uuid NOT NULL,
  revision integer NOT NULL,
  storage_key text NOT NULL,
  sha256 text NOT NULL,
  byte_size integer NOT NULL,
  compile_duration_ms integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, document_id, revision),
  FOREIGN KEY (user_id, document_id, revision)
    REFERENCES public.tex64_document_revisions(user_id, document_id, revision) ON DELETE CASCADE
);

-- Upgrade databases that were provisioned by the former runtime DDL.
ALTER TABLE public.tex64_agent_runs
  ADD COLUMN IF NOT EXISTS state_version integer NOT NULL DEFAULT 0;
ALTER TABLE public.tex64_run_events
  ADD COLUMN IF NOT EXISTS idempotency_key text;

UPDATE public.tex64_run_events
SET idempotency_key = COALESCE(
  NULLIF(detail ->> 'eventKey', ''),
  'legacy:' || run_id::text || ':' || sequence::text
)
WHERE idempotency_key IS NULL;

ALTER TABLE public.tex64_run_events
  ALTER COLUMN idempotency_key SET NOT NULL;

ALTER TABLE public.tex64_documents
  DROP CONSTRAINT IF EXISTS tex64_documents_revision_check,
  ADD CONSTRAINT tex64_documents_revision_check CHECK (current_revision > 0),
  DROP CONSTRAINT IF EXISTS tex64_documents_document_check,
  ADD CONSTRAINT tex64_documents_document_check CHECK (jsonb_typeof(document) = 'object'),
  DROP CONSTRAINT IF EXISTS tex64_documents_timestamp_check,
  ADD CONSTRAINT tex64_documents_timestamp_check CHECK (updated_at >= created_at);

ALTER TABLE public.tex64_document_revisions
  DROP CONSTRAINT IF EXISTS tex64_revisions_revision_check,
  ADD CONSTRAINT tex64_revisions_revision_check CHECK (revision > 0),
  DROP CONSTRAINT IF EXISTS tex64_revisions_actor_check,
  ADD CONSTRAINT tex64_revisions_actor_check CHECK (actor IN ('user', 'agent', 'system')),
  DROP CONSTRAINT IF EXISTS tex64_revisions_document_check,
  ADD CONSTRAINT tex64_revisions_document_check CHECK (jsonb_typeof(document) = 'object'),
  DROP CONSTRAINT IF EXISTS tex64_revisions_operations_check,
  ADD CONSTRAINT tex64_revisions_operations_check CHECK (jsonb_typeof(operations) = 'array');

ALTER TABLE public.tex64_agent_runs
  DROP CONSTRAINT IF EXISTS tex64_agent_runs_prompt_check,
  ADD CONSTRAINT tex64_agent_runs_prompt_check
    CHECK (char_length(prompt) BETWEEN 1 AND 20000),
  DROP CONSTRAINT IF EXISTS tex64_agent_runs_idempotency_key_check,
  ADD CONSTRAINT tex64_agent_runs_idempotency_key_check
    CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  DROP CONSTRAINT IF EXISTS tex64_agent_runs_workflow_run_id_check,
  ADD CONSTRAINT tex64_agent_runs_workflow_run_id_check
    CHECK (workflow_run_id IS NULL OR char_length(workflow_run_id) BETWEEN 1 AND 500),
  DROP CONSTRAINT IF EXISTS tex64_agent_runs_status_check,
  ADD CONSTRAINT tex64_agent_runs_status_check
    CHECK (status IN ('queued', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled')),
  DROP CONSTRAINT IF EXISTS tex64_agent_runs_stage_check,
  ADD CONSTRAINT tex64_agent_runs_stage_check
    CHECK (stage IN ('understanding', 'planning', 'writing', 'checking', 'formatting', 'ready', 'needs_input', 'failed')),
  DROP CONSTRAINT IF EXISTS tex64_agent_runs_revision_check,
  ADD CONSTRAINT tex64_agent_runs_revision_check
    CHECK (base_revision > 0 AND (result_revision IS NULL OR result_revision >= base_revision)),
  DROP CONSTRAINT IF EXISTS tex64_agent_runs_state_version_check,
  ADD CONSTRAINT tex64_agent_runs_state_version_check CHECK (state_version >= 0),
  DROP CONSTRAINT IF EXISTS tex64_agent_runs_state_check,
  ADD CONSTRAINT tex64_agent_runs_state_check CHECK (
    (status = 'queued' AND stage = 'understanding' AND result_revision IS NULL AND error_message IS NULL)
    OR (status = 'running' AND stage IN ('understanding', 'planning', 'writing', 'checking', 'formatting') AND error_message IS NULL)
    OR (status = 'waiting_approval' AND stage = 'needs_input' AND (
      error_message IS NULL OR (char_length(error_message) BETWEEN 1 AND 500)
    ))
    OR (status = 'completed' AND stage = 'ready' AND result_revision IS NOT NULL AND error_message IS NULL)
    OR (status = 'failed' AND stage = 'failed' AND error_message IS NOT NULL AND char_length(error_message) > 0)
    OR status = 'cancelled'
  ),
  DROP CONSTRAINT IF EXISTS tex64_agent_runs_timestamp_check,
  ADD CONSTRAINT tex64_agent_runs_timestamp_check CHECK (updated_at >= created_at);

ALTER TABLE public.tex64_run_events
  DROP CONSTRAINT IF EXISTS tex64_run_events_sequence_check,
  ADD CONSTRAINT tex64_run_events_sequence_check CHECK (sequence > 0),
  DROP CONSTRAINT IF EXISTS tex64_run_events_idempotency_key_check,
  ADD CONSTRAINT tex64_run_events_idempotency_key_check
    CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  DROP CONSTRAINT IF EXISTS tex64_run_events_stage_check,
  ADD CONSTRAINT tex64_run_events_stage_check
    CHECK (stage IN ('understanding', 'planning', 'writing', 'checking', 'formatting', 'ready', 'needs_input', 'failed')),
  DROP CONSTRAINT IF EXISTS tex64_run_events_message_check,
  ADD CONSTRAINT tex64_run_events_message_check CHECK (char_length(message) BETWEEN 1 AND 2000),
  DROP CONSTRAINT IF EXISTS tex64_run_events_detail_check,
  ADD CONSTRAINT tex64_run_events_detail_check
    CHECK (detail IS NULL OR jsonb_typeof(detail) = 'object');

ALTER TABLE public.tex64_artifacts
  DROP CONSTRAINT IF EXISTS tex64_artifacts_revision_check,
  ADD CONSTRAINT tex64_artifacts_revision_check CHECK (revision > 0),
  DROP CONSTRAINT IF EXISTS tex64_artifacts_storage_key_check,
  ADD CONSTRAINT tex64_artifacts_storage_key_check
    CHECK (char_length(storage_key) BETWEEN 1 AND 1000),
  DROP CONSTRAINT IF EXISTS tex64_artifacts_sha256_check,
  ADD CONSTRAINT tex64_artifacts_sha256_check CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  DROP CONSTRAINT IF EXISTS tex64_artifacts_byte_size_check,
  ADD CONSTRAINT tex64_artifacts_byte_size_check CHECK (byte_size > 0),
  DROP CONSTRAINT IF EXISTS tex64_artifacts_compile_duration_check,
  ADD CONSTRAINT tex64_artifacts_compile_duration_check CHECK (compile_duration_ms >= 0);

ALTER TABLE public.tex64_agent_runs
  DROP CONSTRAINT IF EXISTS tex64_agent_runs_base_revision_fkey,
  ADD CONSTRAINT tex64_agent_runs_base_revision_fkey
    FOREIGN KEY (user_id, document_id, base_revision)
    REFERENCES public.tex64_document_revisions(user_id, document_id, revision),
  DROP CONSTRAINT IF EXISTS tex64_agent_runs_result_revision_fkey,
  ADD CONSTRAINT tex64_agent_runs_result_revision_fkey
    FOREIGN KEY (user_id, document_id, result_revision)
    REFERENCES public.tex64_document_revisions(user_id, document_id, revision);

CREATE UNIQUE INDEX IF NOT EXISTS tex64_agent_runs_workflow_run_id_unique
  ON public.tex64_agent_runs (user_id, workflow_run_id)
  WHERE workflow_run_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS tex64_run_events_idempotency_unique
  ON public.tex64_run_events (user_id, run_id, idempotency_key);

ALTER TABLE public.tex64_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tex64_document_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tex64_agent_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tex64_run_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tex64_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tex64_documents FORCE ROW LEVEL SECURITY;
ALTER TABLE public.tex64_document_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.tex64_agent_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE public.tex64_run_events FORCE ROW LEVEL SECURITY;
ALTER TABLE public.tex64_artifacts FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tex64_user_isolation ON public.tex64_documents;
CREATE POLICY tex64_user_isolation ON public.tex64_documents
  USING (user_id = NULLIF(current_setting('app.tex64_user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.tex64_user_id', true), '')::uuid);

DROP POLICY IF EXISTS tex64_user_isolation ON public.tex64_document_revisions;
CREATE POLICY tex64_user_isolation ON public.tex64_document_revisions
  USING (user_id = NULLIF(current_setting('app.tex64_user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.tex64_user_id', true), '')::uuid);

DROP POLICY IF EXISTS tex64_user_isolation ON public.tex64_agent_runs;
CREATE POLICY tex64_user_isolation ON public.tex64_agent_runs
  USING (user_id = NULLIF(current_setting('app.tex64_user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.tex64_user_id', true), '')::uuid);

DROP POLICY IF EXISTS tex64_user_isolation ON public.tex64_run_events;
CREATE POLICY tex64_user_isolation ON public.tex64_run_events
  USING (user_id = NULLIF(current_setting('app.tex64_user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.tex64_user_id', true), '')::uuid);

DROP POLICY IF EXISTS tex64_user_isolation ON public.tex64_artifacts;
CREATE POLICY tex64_user_isolation ON public.tex64_artifacts
  USING (user_id = NULLIF(current_setting('app.tex64_user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.tex64_user_id', true), '')::uuid);

COMMIT;
