BEGIN;

-- A short lease ensures one HTTP replay calls Workflow start(), while the
-- workflow itself remains authoritative and binds its own durable run id.
CREATE TABLE IF NOT EXISTS public.tex64_workflow_launch_leases (
  user_id uuid NOT NULL,
  run_id uuid NOT NULL,
  lease_token text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, run_id),
  FOREIGN KEY (user_id, run_id)
    REFERENCES public.tex64_agent_runs(user_id, id) ON DELETE CASCADE
);

ALTER TABLE public.tex64_workflow_launch_leases
  DROP CONSTRAINT IF EXISTS tex64_workflow_launch_lease_token_check,
  ADD CONSTRAINT tex64_workflow_launch_lease_token_check
    CHECK (char_length(lease_token) BETWEEN 1 AND 200),
  DROP CONSTRAINT IF EXISTS tex64_workflow_launch_lease_expiry_check,
  ADD CONSTRAINT tex64_workflow_launch_lease_expiry_check
    CHECK (expires_at > created_at),
  DROP CONSTRAINT IF EXISTS tex64_workflow_launch_lease_timestamp_check,
  ADD CONSTRAINT tex64_workflow_launch_lease_timestamp_check
    CHECK (updated_at >= created_at);

CREATE INDEX IF NOT EXISTS tex64_workflow_launch_leases_expiry_idx
  ON public.tex64_workflow_launch_leases (expires_at);

ALTER TABLE public.tex64_workflow_launch_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tex64_workflow_launch_leases FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tex64_user_isolation
  ON public.tex64_workflow_launch_leases;
CREATE POLICY tex64_user_isolation
  ON public.tex64_workflow_launch_leases
  USING (user_id = NULLIF(current_setting('app.tex64_user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.tex64_user_id', true), '')::uuid);

COMMIT;
