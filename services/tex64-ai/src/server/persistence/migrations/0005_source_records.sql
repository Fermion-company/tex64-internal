BEGIN;

-- Resolved source content is isolated by both user and document. Runtime code
-- must only store canonical locators produced by the safe source resolver.
CREATE TABLE IF NOT EXISTS public.tex64_source_records (
  id uuid NOT NULL,
  user_id uuid NOT NULL,
  document_id uuid NOT NULL,
  kind text NOT NULL,
  canonical_locator text NOT NULL,
  resolved_locator text NOT NULL,
  verification text NOT NULL,
  evidence_scope text NOT NULL,
  content_text text,
  content_sha256 text,
  metadata jsonb NOT NULL,
  fetched_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, document_id, canonical_locator),
  FOREIGN KEY (user_id, document_id)
    REFERENCES public.tex64_documents(user_id, id) ON DELETE CASCADE
);

ALTER TABLE public.tex64_source_records
  DROP CONSTRAINT IF EXISTS tex64_source_records_kind_check,
  ADD CONSTRAINT tex64_source_records_kind_check
    CHECK (kind IN ('https', 'doi')),
  DROP CONSTRAINT IF EXISTS tex64_source_records_canonical_locator_check,
  ADD CONSTRAINT tex64_source_records_canonical_locator_check CHECK (
    char_length(canonical_locator) BETWEEN 1 AND 2048
      AND canonical_locator ~ '^https://'
      AND position('#' IN canonical_locator) = 0
  ),
  DROP CONSTRAINT IF EXISTS tex64_source_records_resolved_locator_check,
  ADD CONSTRAINT tex64_source_records_resolved_locator_check CHECK (
    char_length(resolved_locator) BETWEEN 1 AND 2048
      AND resolved_locator ~ '^https://'
      AND position('#' IN resolved_locator) = 0
  ),
  DROP CONSTRAINT IF EXISTS tex64_source_records_doi_locator_check,
  ADD CONSTRAINT tex64_source_records_doi_locator_check CHECK (
    kind <> 'doi' OR canonical_locator ~ '^https://doi\.org/10\.[0-9]{4,9}/'
  ),
  DROP CONSTRAINT IF EXISTS tex64_source_records_verification_check,
  ADD CONSTRAINT tex64_source_records_verification_check
    CHECK (verification IN ('verified_content', 'metadata_only')),
  DROP CONSTRAINT IF EXISTS tex64_source_records_evidence_scope_check,
  ADD CONSTRAINT tex64_source_records_evidence_scope_check
    CHECK (evidence_scope IN ('full_text', 'abstract', 'none')),
  DROP CONSTRAINT IF EXISTS tex64_source_records_content_digest_check,
  ADD CONSTRAINT tex64_source_records_content_digest_check CHECK (
    content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$'
  ),
  DROP CONSTRAINT IF EXISTS tex64_source_records_content_size_check,
  ADD CONSTRAINT tex64_source_records_content_size_check CHECK (
    content_text IS NULL OR char_length(content_text) BETWEEN 1 AND 2000000
  ),
  DROP CONSTRAINT IF EXISTS tex64_source_records_provenance_check,
  ADD CONSTRAINT tex64_source_records_provenance_check CHECK (
    (
      verification = 'metadata_only'
        AND evidence_scope = 'none'
        AND content_text IS NULL
        AND content_sha256 IS NULL
    )
    OR
    (
      verification = 'verified_content'
        AND evidence_scope IN ('full_text', 'abstract')
        AND content_text IS NOT NULL
        AND content_sha256 IS NOT NULL
    )
  ),
  DROP CONSTRAINT IF EXISTS tex64_source_records_kind_scope_check,
  ADD CONSTRAINT tex64_source_records_kind_scope_check CHECK (
    (kind = 'https' AND evidence_scope = 'full_text')
      OR (kind = 'doi' AND evidence_scope IN ('abstract', 'none'))
  ),
  DROP CONSTRAINT IF EXISTS tex64_source_records_metadata_check,
  ADD CONSTRAINT tex64_source_records_metadata_check CHECK (
    jsonb_typeof(metadata) = 'object'
      AND jsonb_typeof(metadata -> 'provider') = 'string'
      AND jsonb_typeof(metadata -> 'contentType') = 'string'
  ),
  DROP CONSTRAINT IF EXISTS tex64_source_records_timestamp_check,
  ADD CONSTRAINT tex64_source_records_timestamp_check
    CHECK (updated_at >= created_at);

CREATE INDEX IF NOT EXISTS tex64_source_records_document_fetched_idx
  ON public.tex64_source_records (user_id, document_id, fetched_at DESC);

-- A canonical locator is an evidence snapshot, not a mutable cache entry.
-- The application only inserts and reads these rows; this trigger also keeps a
-- mistakenly granted UPDATE privilege from rewriting cited evidence in place.
CREATE OR REPLACE FUNCTION public.tex64_reject_source_record_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'source records are immutable';
END;
$$;

DROP TRIGGER IF EXISTS tex64_source_records_immutable
  ON public.tex64_source_records;
CREATE TRIGGER tex64_source_records_immutable
  BEFORE UPDATE ON public.tex64_source_records
  FOR EACH ROW
  EXECUTE FUNCTION public.tex64_reject_source_record_update();

ALTER TABLE public.tex64_source_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tex64_source_records FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tex64_user_isolation ON public.tex64_source_records;
CREATE POLICY tex64_user_isolation ON public.tex64_source_records
  USING (
    user_id = NULLIF(current_setting('app.tex64_user_id', true), '')::uuid
  )
  WITH CHECK (
    user_id = NULLIF(current_setting('app.tex64_user_id', true), '')::uuid
  );

COMMIT;
