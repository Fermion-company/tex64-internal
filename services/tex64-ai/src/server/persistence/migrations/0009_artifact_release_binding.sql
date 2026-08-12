BEGIN;

-- A completed run publishes one exact, independently accepted PDF identity.
-- Existing completed rows remain unbound and therefore are not publishable
-- until a new run recompiles and accepts their revision.
ALTER TABLE public.tex64_agent_runs
  ADD COLUMN IF NOT EXISTS result_artifact_revision integer,
  ADD COLUMN IF NOT EXISTS result_artifact_storage_key text,
  ADD COLUMN IF NOT EXISTS result_artifact_sha256 text,
  ADD COLUMN IF NOT EXISTS result_artifact_byte_size integer,
  ADD COLUMN IF NOT EXISTS result_artifact_page_count integer,
  ADD COLUMN IF NOT EXISTS result_artifact_quality_version integer;

ALTER TABLE public.tex64_agent_runs
  DROP CONSTRAINT IF EXISTS tex64_agent_runs_artifact_release_check,
  ADD CONSTRAINT tex64_agent_runs_artifact_release_check CHECK (
    (
      result_artifact_revision IS NULL
      AND result_artifact_storage_key IS NULL
      AND result_artifact_sha256 IS NULL
      AND result_artifact_byte_size IS NULL
      AND result_artifact_page_count IS NULL
      AND result_artifact_quality_version IS NULL
    )
    OR (
      status = 'completed'
      AND stage = 'ready'
      AND result_revision IS NOT NULL
      AND result_artifact_revision = result_revision
      AND char_length(result_artifact_storage_key) BETWEEN 1 AND 1000
      AND result_artifact_sha256 ~ '^[0-9a-f]{64}$'
      AND result_artifact_byte_size > 0
      AND result_artifact_page_count > 0
      AND result_artifact_quality_version > 0
    )
  );

COMMIT;
