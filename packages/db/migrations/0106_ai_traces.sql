-- AI debug traces (ADR 0009). Each row is one AI turn: a website chat reply,
-- a call's voice session, or one request the voice model delegated. It keeps
-- what the model was given and what it did, so a wrong answer can be traced
-- offline. Traces are kept only for businesses that turn them on, expire with
-- the ai_traces retention category, and never go to logs or telemetry.
ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS ai_traces_enabled boolean NOT NULL DEFAULT false;

-- Text shared by many traces, stored once: the snapshot a turn used, or the
-- instructions a model was given. Each expires with the last trace using it.
CREATE TABLE IF NOT EXISTS public.ai_trace_contexts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  kind varchar(32) NOT NULL,
  hash varchar(64) NOT NULL,
  content text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ai_trace_contexts_business_kind_hash_unique ON public.ai_trace_contexts(business_id, kind, hash);
CREATE INDEX IF NOT EXISTS ai_trace_contexts_expires_idx ON public.ai_trace_contexts(expires_at);

CREATE TABLE IF NOT EXISTS public.ai_traces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  kind varchar(32) NOT NULL,
  channel varchar(32) NOT NULL,
  call_id uuid REFERENCES public.calls(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES public.conversations(id) ON DELETE CASCADE,
  message_id uuid REFERENCES public.messages(id) ON DELETE SET NULL,
  delegation_id varchar(120),
  model varchar(120),
  snapshot_version varchar(120),
  snapshot_context_id uuid REFERENCES public.ai_trace_contexts(id) ON DELETE SET NULL,
  instructions_context_id uuid REFERENCES public.ai_trace_contexts(id) ON DELETE SET NULL,
  input text,
  steps jsonb NOT NULL DEFAULT '[]'::jsonb,
  output text,
  direct_answer boolean NOT NULL DEFAULT false,
  failed boolean NOT NULL DEFAULT false,
  usage jsonb,
  duration_ms integer,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_traces_business_created_idx ON public.ai_traces(business_id, created_at);
CREATE INDEX IF NOT EXISTS ai_traces_call_idx ON public.ai_traces(call_id);
CREATE INDEX IF NOT EXISTS ai_traces_conversation_idx ON public.ai_traces(conversation_id);
CREATE INDEX IF NOT EXISTS ai_traces_expires_idx ON public.ai_traces(expires_at);

-- Same tenancy as transcripts: the business's members, or the system and its workers.
ALTER TABLE public.ai_trace_contexts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_trace_contexts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_trace_contexts_tenant_isolation ON public.ai_trace_contexts;
CREATE POLICY ai_trace_contexts_tenant_isolation ON public.ai_trace_contexts
  USING (business_id = app.current_business_id() AND (app.current_actor_type() IN ('system', 'worker', 'dispatcher') OR app.has_business_membership(business_id)))
  WITH CHECK (business_id = app.current_business_id() AND (app.current_actor_type() IN ('system', 'worker', 'dispatcher') OR app.has_business_membership(business_id)));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_trace_contexts TO lobbystack_app, lobbystack_worker;
GRANT SELECT ON public.ai_trace_contexts TO lobbystack_readonly;

ALTER TABLE public.ai_traces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_traces FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_traces_tenant_isolation ON public.ai_traces;
CREATE POLICY ai_traces_tenant_isolation ON public.ai_traces
  USING (business_id = app.current_business_id() AND (app.current_actor_type() IN ('system', 'worker', 'dispatcher') OR app.has_business_membership(business_id)))
  WITH CHECK (business_id = app.current_business_id() AND (app.current_actor_type() IN ('system', 'worker', 'dispatcher') OR app.has_business_membership(business_id)));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_traces TO lobbystack_app, lobbystack_worker;
GRANT SELECT ON public.ai_traces TO lobbystack_readonly;
