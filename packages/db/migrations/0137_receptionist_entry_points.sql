-- Who answers each entry point, and who answered each record. Phone numbers
-- and widget keys name the receptionist that answers them; calls,
-- conversations and inbox items name the one that answered. Every existing
-- number and widget key points at its business's default receptionist.
--
-- Numbers and widget keys are small tables, so they are filled here. Calls,
-- conversations and inbox items are large: they get the empty column, and
-- their foreign keys are added NOT VALID, which checks new rows without
-- scanning old ones. The worker fills their old rows in small batches
-- (receptionists.backfillRecords), and the clean-up deploy validates the keys and
-- requires the column.
--
-- A trigger gives every new row the default receptionist when its writer
-- names none, so the code still running during a deploy keeps working. A
-- missing receptionist (null, which only a business without any receptionist
-- can have) reads as the default everywhere.
--
-- A paused or archived receptionist's entry points answer as the default
-- (app.effective_receptionist), so a printed sign or a published number
-- always reaches someone.

SET LOCAL lock_timeout = '5s';

-- 1. The receptionist an entry point names, if it may answer, else the default.
CREATE OR REPLACE FUNCTION app.effective_receptionist(p_business_id uuid, p_receptionist_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog
AS $$
  SELECT COALESCE(
    (SELECT named.id FROM public.receptionist_profiles named
     WHERE named.business_id = p_business_id AND named.id = p_receptionist_id
       AND named.status = 'active' AND named.archived_at IS NULL),
    (SELECT fallback.id FROM public.receptionist_profiles fallback
     WHERE fallback.business_id = p_business_id AND fallback.is_default)
  )
$$;

REVOKE ALL ON FUNCTION app.effective_receptionist(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.effective_receptionist(uuid, uuid) TO lobbystack_app, lobbystack_worker;

-- 2. The columns.
ALTER TABLE public.phone_numbers ADD COLUMN IF NOT EXISTS receptionist_id uuid;
ALTER TABLE public.widget_keys ADD COLUMN IF NOT EXISTS receptionist_id uuid;
ALTER TABLE public.calls ADD COLUMN IF NOT EXISTS receptionist_id uuid;
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS receptionist_id uuid;
ALTER TABLE public.inbox_items ADD COLUMN IF NOT EXISTS receptionist_id uuid;

COMMENT ON COLUMN public.phone_numbers.receptionist_id IS 'Who answers the number. A paused or archived one''s calls go to the default receptionist; null means the default.';
COMMENT ON COLUMN public.widget_keys.receptionist_id IS 'Who answers the widget. A paused or archived one''s chats go to the default receptionist; null means the default.';
COMMENT ON COLUMN public.calls.receptionist_id IS 'The receptionist that answered. Old rows are filled by the worker''s backfill; null means the default.';
COMMENT ON COLUMN public.conversations.receptionist_id IS 'The receptionist that answered. Old rows are filled by the worker''s backfill; null means the default.';
COMMENT ON COLUMN public.inbox_items.receptionist_id IS 'The receptionist whose call or chat made the item. Old rows are filled by the worker''s backfill; null means the default.';

-- 3. Every existing number and widget key points at the default receptionist.
UPDATE public.phone_numbers number
SET receptionist_id = profile.id
FROM public.receptionist_profiles profile
WHERE profile.business_id = number.business_id AND profile.is_default AND number.receptionist_id IS NULL;

UPDATE public.widget_keys widget_key
SET receptionist_id = profile.id
FROM public.receptionist_profiles profile
WHERE profile.business_id = widget_key.business_id AND profile.is_default AND widget_key.receptionist_id IS NULL;

-- 4. Composite keys: a row can only name a receptionist of its own business.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'phone_numbers_receptionist_fk') THEN
    ALTER TABLE public.phone_numbers ADD CONSTRAINT phone_numbers_receptionist_fk
      FOREIGN KEY (business_id, receptionist_id) REFERENCES public.receptionist_profiles (business_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'widget_keys_receptionist_fk') THEN
    ALTER TABLE public.widget_keys ADD CONSTRAINT widget_keys_receptionist_fk
      FOREIGN KEY (business_id, receptionist_id) REFERENCES public.receptionist_profiles (business_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'calls_receptionist_fk') THEN
    ALTER TABLE public.calls ADD CONSTRAINT calls_receptionist_fk
      FOREIGN KEY (business_id, receptionist_id) REFERENCES public.receptionist_profiles (business_id, id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'conversations_receptionist_fk') THEN
    ALTER TABLE public.conversations ADD CONSTRAINT conversations_receptionist_fk
      FOREIGN KEY (business_id, receptionist_id) REFERENCES public.receptionist_profiles (business_id, id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inbox_items_receptionist_fk') THEN
    ALTER TABLE public.inbox_items ADD CONSTRAINT inbox_items_receptionist_fk
      FOREIGN KEY (business_id, receptionist_id) REFERENCES public.receptionist_profiles (business_id, id) NOT VALID;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS phone_numbers_business_receptionist_idx
  ON public.phone_numbers (business_id, receptionist_id);
CREATE INDEX IF NOT EXISTS widget_keys_business_receptionist_idx
  ON public.widget_keys (business_id, receptionist_id);

-- 5. New rows get the default receptionist when their writer names none.
DROP TRIGGER IF EXISTS phone_numbers_fill_receptionist ON public.phone_numbers;
CREATE TRIGGER phone_numbers_fill_receptionist BEFORE INSERT ON public.phone_numbers
  FOR EACH ROW EXECUTE FUNCTION app.fill_default_receptionist();
DROP TRIGGER IF EXISTS widget_keys_fill_receptionist ON public.widget_keys;
CREATE TRIGGER widget_keys_fill_receptionist BEFORE INSERT ON public.widget_keys
  FOR EACH ROW EXECUTE FUNCTION app.fill_default_receptionist();
DROP TRIGGER IF EXISTS calls_fill_receptionist ON public.calls;
CREATE TRIGGER calls_fill_receptionist BEFORE INSERT ON public.calls
  FOR EACH ROW EXECUTE FUNCTION app.fill_default_receptionist();
DROP TRIGGER IF EXISTS conversations_fill_receptionist ON public.conversations;
CREATE TRIGGER conversations_fill_receptionist BEFORE INSERT ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION app.fill_default_receptionist();
DROP TRIGGER IF EXISTS inbox_items_fill_receptionist ON public.inbox_items;
CREATE TRIGGER inbox_items_fill_receptionist BEFORE INSERT ON public.inbox_items
  FOR EACH ROW EXECUTE FUNCTION app.fill_default_receptionist();

-- 6. Who asked each unanswered question. A chain hears the same question at
-- many stores: one question row keeps one answer, and these rows show who
-- asked and filter the Questions page. Each existing question was asked of
-- the default receptionist.
CREATE UNIQUE INDEX IF NOT EXISTS unanswered_questions_business_id_unique
  ON public.unanswered_questions (business_id, id);

CREATE TABLE IF NOT EXISTS public.unanswered_question_receptionists (
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  question_id uuid NOT NULL,
  receptionist_id uuid NOT NULL,
  times_asked integer NOT NULL DEFAULT 1 CHECK (times_asked > 0),
  last_asked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (question_id, receptionist_id),
  CONSTRAINT unanswered_question_receptionists_question_fk FOREIGN KEY (business_id, question_id)
    REFERENCES public.unanswered_questions (business_id, id) ON DELETE CASCADE,
  CONSTRAINT unanswered_question_receptionists_receptionist_fk FOREIGN KEY (business_id, receptionist_id)
    REFERENCES public.receptionist_profiles (business_id, id)
);
CREATE INDEX IF NOT EXISTS unanswered_question_receptionists_receptionist_idx
  ON public.unanswered_question_receptionists (business_id, receptionist_id, last_asked_at DESC);

ALTER TABLE public.unanswered_question_receptionists ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.unanswered_question_receptionists FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS unanswered_question_receptionists_tenant_isolation ON public.unanswered_question_receptionists;
CREATE POLICY unanswered_question_receptionists_tenant_isolation ON public.unanswered_question_receptionists
  USING (business_id = app.current_business_id() AND (app.current_actor_type() IN ('system', 'worker', 'dispatcher') OR app.has_business_membership(business_id)))
  WITH CHECK (business_id = app.current_business_id() AND (app.current_actor_type() IN ('system', 'worker', 'dispatcher') OR app.has_business_membership(business_id)));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.unanswered_question_receptionists TO lobbystack_app, lobbystack_worker;
GRANT SELECT ON public.unanswered_question_receptionists TO lobbystack_readonly;

INSERT INTO public.unanswered_question_receptionists (business_id, question_id, receptionist_id, times_asked, last_asked_at)
SELECT question.business_id, question.id, profile.id, question.times_asked, question.last_asked_at
FROM public.unanswered_questions question
INNER JOIN public.receptionist_profiles profile ON profile.business_id = question.business_id AND profile.is_default
ON CONFLICT (question_id, receptionist_id) DO NOTHING;

COMMENT ON TABLE public.unanswered_question_receptionists IS 'Which receptionists heard an unanswered question, how often and when last. The question row keeps the one answer.';

-- 7. The receptionist that answers a dialled number, for the incoming call
-- webhook, which looks it up before it knows the business: the number's own
-- receptionist when it may answer, else the default one. Null for a number
-- that answers nothing, as app.resolve_business_by_phone returns no business.
CREATE OR REPLACE FUNCTION app.resolve_receptionist_by_phone(phone_e164 text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT app.effective_receptionist(number.business_id, number.receptionist_id)
  FROM public.phone_numbers number
  INNER JOIN public.businesses business ON business.id = number.business_id
  WHERE number.e164 = phone_e164 AND number.status = 'active' AND business.status = 'active'
  LIMIT 1
$$;

REVOKE ALL ON FUNCTION app.resolve_receptionist_by_phone(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_receptionist_by_phone(text) TO lobbystack_app, lobbystack_worker;
