BEGIN;

ALTER TABLE public.tex64_artifacts
  ADD COLUMN IF NOT EXISTS page_count integer,
  ADD COLUMN IF NOT EXISTS quality_version integer NOT NULL DEFAULT 0;

ALTER TABLE public.tex64_artifacts
  DROP CONSTRAINT IF EXISTS tex64_artifacts_page_count_check,
  ADD CONSTRAINT tex64_artifacts_page_count_check
    CHECK (page_count IS NULL OR page_count > 0),
  DROP CONSTRAINT IF EXISTS tex64_artifacts_quality_version_check,
  ADD CONSTRAINT tex64_artifacts_quality_version_check
    CHECK (quality_version >= 0);

COMMIT;
