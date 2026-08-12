BEGIN;

-- These tables contain only HMAC digests and counters. They intentionally do
-- not use tenant RLS because network and service-global budgets must be shared
-- across anonymous workspaces and every serverless instance.
CREATE TABLE IF NOT EXISTS public.tex64_rate_limit_buckets (
  action text NOT NULL,
  scope_kind text NOT NULL,
  scope_hash text NOT NULL,
  window_start timestamptz NOT NULL,
  resets_at timestamptz NOT NULL,
  count integer NOT NULL,
  PRIMARY KEY (action, scope_kind, scope_hash, window_start)
);

ALTER TABLE public.tex64_rate_limit_buckets
  DROP CONSTRAINT IF EXISTS tex64_rate_limit_action_check,
  ADD CONSTRAINT tex64_rate_limit_action_check
    CHECK (char_length(action) BETWEEN 1 AND 100),
  DROP CONSTRAINT IF EXISTS tex64_rate_limit_scope_kind_check,
  ADD CONSTRAINT tex64_rate_limit_scope_kind_check
    CHECK (scope_kind IN ('identity', 'network', 'global', 'mutation')),
  DROP CONSTRAINT IF EXISTS tex64_rate_limit_scope_hash_check,
  ADD CONSTRAINT tex64_rate_limit_scope_hash_check
    CHECK (scope_hash ~ '^[0-9a-f]{64}$'),
  DROP CONSTRAINT IF EXISTS tex64_rate_limit_window_check,
  ADD CONSTRAINT tex64_rate_limit_window_check
    CHECK (resets_at > window_start),
  DROP CONSTRAINT IF EXISTS tex64_rate_limit_count_check,
  ADD CONSTRAINT tex64_rate_limit_count_check CHECK (count > 0);

CREATE INDEX IF NOT EXISTS tex64_rate_limit_buckets_expiry_idx
  ON public.tex64_rate_limit_buckets (resets_at);

-- A successful paid-run admission is reserved before the business run is
-- written. Replaying the same document/idempotency tuple therefore does not
-- consume quota twice, including after an ambiguous network response.
CREATE TABLE IF NOT EXISTS public.tex64_rate_limit_reservations (
  action text NOT NULL,
  reservation_hash text NOT NULL,
  policy_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (action, reservation_hash)
);

ALTER TABLE public.tex64_rate_limit_reservations
  DROP CONSTRAINT IF EXISTS tex64_rate_limit_reservation_action_check,
  ADD CONSTRAINT tex64_rate_limit_reservation_action_check
    CHECK (char_length(action) BETWEEN 1 AND 100),
  DROP CONSTRAINT IF EXISTS tex64_rate_limit_reservation_hash_check,
  ADD CONSTRAINT tex64_rate_limit_reservation_hash_check
    CHECK (reservation_hash ~ '^[0-9a-f]{64}$'),
  DROP CONSTRAINT IF EXISTS tex64_rate_limit_policy_hash_check,
  ADD CONSTRAINT tex64_rate_limit_policy_hash_check
    CHECK (policy_hash ~ '^[0-9a-f]{64}$'),
  DROP CONSTRAINT IF EXISTS tex64_rate_limit_reservation_expiry_check,
  ADD CONSTRAINT tex64_rate_limit_reservation_expiry_check
    CHECK (expires_at > created_at);

CREATE INDEX IF NOT EXISTS tex64_rate_limit_reservations_expiry_idx
  ON public.tex64_rate_limit_reservations (expires_at);

COMMIT;
