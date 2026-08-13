BEGIN;

-- One durable elicitation/authoring session is retained per tenant document.
-- The JSONB payload is validated again by StoredDocumentAgentSessionSchema at
-- every repository boundary; the scalar columns provide the CAS token and RLS
-- scope without trusting fields inside the JSON document.
CREATE TABLE IF NOT EXISTS public.tex64_document_agent_sessions (
  user_id uuid NOT NULL,
  document_id uuid NOT NULL,
  session jsonb NOT NULL,
  state_version integer NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, document_id),
  FOREIGN KEY (user_id, document_id)
    REFERENCES public.tex64_documents(user_id, id) ON DELETE CASCADE
);

ALTER TABLE public.tex64_document_agent_sessions
  DROP CONSTRAINT IF EXISTS tex64_document_agent_sessions_payload_check,
  ADD CONSTRAINT tex64_document_agent_sessions_payload_check CHECK (
    jsonb_typeof(session) = 'object'
      AND jsonb_typeof(session -> 'stateVersion') = 'number'
      AND session -> 'stateVersion' = to_jsonb(state_version)
      AND session ->> 'documentId' = document_id::text
      AND jsonb_typeof(session -> 'updatedAt') = 'string'
  ),
  DROP CONSTRAINT IF EXISTS tex64_document_agent_sessions_version_check,
  ADD CONSTRAINT tex64_document_agent_sessions_version_check
    CHECK (state_version >= 0);

ALTER TABLE public.tex64_document_agent_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tex64_document_agent_sessions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tex64_user_isolation
  ON public.tex64_document_agent_sessions;
CREATE POLICY tex64_user_isolation
  ON public.tex64_document_agent_sessions
  USING (
    user_id = NULLIF(current_setting('app.tex64_user_id', true), '')::uuid
  )
  WITH CHECK (
    user_id = NULLIF(current_setting('app.tex64_user_id', true), '')::uuid
  );

COMMIT;
