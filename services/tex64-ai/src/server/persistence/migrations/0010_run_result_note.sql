BEGIN;

-- Sanitized closing message from the agent, stored only on completed runs.
ALTER TABLE public.tex64_agent_runs
  ADD COLUMN IF NOT EXISTS result_note text;

ALTER TABLE public.tex64_agent_runs
  DROP CONSTRAINT IF EXISTS tex64_agent_runs_result_note_check,
  ADD CONSTRAINT tex64_agent_runs_result_note_check
    CHECK (
      result_note IS NULL
      OR (char_length(result_note) BETWEEN 1 AND 1000 AND status = 'completed')
    );

-- Document node a run's request is scoped to (PDF element selection).
ALTER TABLE public.tex64_agent_runs
  ADD COLUMN IF NOT EXISTS target_node_id uuid;

COMMIT;
