BEGIN;

-- An answer can finish without editing the document or publishing a PDF.
-- The artifact-release constraint still requires a matching result revision.
ALTER TABLE public.tex64_agent_runs
  DROP CONSTRAINT tex64_agent_runs_state_check,
  ADD CONSTRAINT tex64_agent_runs_state_check CHECK (
    (status = 'queued' AND stage = 'understanding' AND result_revision IS NULL AND error_message IS NULL)
    OR (status = 'running' AND stage IN ('understanding', 'planning', 'writing', 'checking', 'formatting') AND error_message IS NULL)
    OR (status = 'waiting_approval' AND stage = 'needs_input' AND (
      error_message IS NULL OR char_length(error_message) BETWEEN 1 AND 500
    ))
    OR (status = 'completed' AND stage = 'ready' AND error_message IS NULL)
    OR (status = 'failed' AND stage = 'failed' AND error_message IS NOT NULL AND char_length(error_message) > 0)
    OR status = 'cancelled'
  );

COMMIT;
