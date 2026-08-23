BEGIN;

-- The model-visible conversation for a document. One row per ModelMessage so
-- a turn replays the thread exactly as the model saw it. Content is validated
-- again at the repository boundary; the scalar columns carry ordering, turn
-- attribution, and RLS scope without trusting fields inside the JSON.
CREATE TABLE IF NOT EXISTS public.tex64_conversation_messages (
  user_id uuid NOT NULL,
  document_id uuid NOT NULL,
  sequence bigint NOT NULL,
  turn_id uuid NOT NULL,
  role text NOT NULL,
  content jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, document_id, sequence),
  FOREIGN KEY (user_id, document_id)
    REFERENCES public.tex64_documents(user_id, id) ON DELETE CASCADE
);

ALTER TABLE public.tex64_conversation_messages
  DROP CONSTRAINT IF EXISTS tex64_conversation_messages_role_check,
  ADD CONSTRAINT tex64_conversation_messages_role_check
    CHECK (role IN ('user', 'assistant', 'tool')),
  DROP CONSTRAINT IF EXISTS tex64_conversation_messages_sequence_check,
  ADD CONSTRAINT tex64_conversation_messages_sequence_check
    CHECK (sequence >= 1);

CREATE INDEX IF NOT EXISTS tex64_conversation_messages_document_idx
  ON public.tex64_conversation_messages (user_id, document_id, sequence DESC);

ALTER TABLE public.tex64_conversation_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tex64_conversation_messages FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tex64_user_isolation
  ON public.tex64_conversation_messages;
CREATE POLICY tex64_user_isolation
  ON public.tex64_conversation_messages
  USING (
    user_id = NULLIF(current_setting('app.tex64_user_id', true), '')::uuid
  )
  WITH CHECK (
    user_id = NULLIF(current_setting('app.tex64_user_id', true), '')::uuid
  );

COMMIT;
