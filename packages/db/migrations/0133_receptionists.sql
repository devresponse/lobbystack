-- Several receptionists per business, deploy 1 of the design (docs/features/
-- receptionists.md). receptionist_profiles keeps one row per receptionist:
-- each business's row today becomes its default receptionist, named "Front
-- desk" in the business's language, and later rows are the receptionists an
-- owner adds. The settings every receptionist shares (the business summary,
-- the AI and recording notice, and the appointment change rules) move to
-- businesses.
--
-- The code still running while a deploy finishes reads and writes the profile
-- row as the business's only one, so this file only adds:
--   * every new column has a constant default, so an insert that names none
--     of them makes the business's default receptionist, as sign-up does;
--   * the unique index on business_id stays until 0140, which turns on adding
--     receptionists, because the old code's upsert names it as its conflict
--     target;
--   * the shared settings stay on the profile too, and a trigger copies them
--     to businesses whenever the default receptionist's copy changes, so an
--     edit made by the old code during a deploy or after a rollback reaches
--     businesses. The new code writes both places until the clean-up deploy
--     drops the profile's copies and this trigger.

SET LOCAL lock_timeout = '5s';

-- 1. Receptionist columns.
ALTER TABLE public.receptionist_profiles
  ADD COLUMN IF NOT EXISTS name varchar(80) NOT NULL DEFAULT 'Front desk',
  ADD COLUMN IF NOT EXISTS description varchar(160) NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS handle varchar(60),
  ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS knowledge_scope varchar(16) NOT NULL DEFAULT 'all',
  ADD COLUMN IF NOT EXISTS listed boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS locale varchar(8),
  ADD COLUMN IF NOT EXISTS status varchar(16) NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

-- 2. Every business has a default receptionist. A business without a profile
-- row, which only one made outside sign-up can be, gets one with the settings
-- defaultReceptionistProfile in packages/domain gives.
INSERT INTO public.receptionist_profiles (business_id, greeting, tone, summary, summary_source, booking_policy, transfer_mode, appointment_change_policy)
SELECT business.id,
  'Thank you for calling ' || business.name || '.',
  'professional',
  business.name,
  'placeholder',
  'Confirm availability before booking.',
  'on_request',
  '{"enabled": true, "allowCancel": true, "allowReschedule": true, "verificationMode": "phone_match_and_facts"}'::jsonb
FROM public.businesses business
WHERE NOT EXISTS (SELECT 1 FROM public.receptionist_profiles profile WHERE profile.business_id = business.id);

-- Today's row is its business's default receptionist, named in the
-- business's language. The names match DEFAULT_RECEPTIONIST_NAMES in
-- packages/shared/src/receptionists.ts, which a test compares with this list.
UPDATE public.receptionist_profiles profile
SET name = CASE split_part(replace(lower(business.default_locale), '_', '-'), '-', 1)
    WHEN 'en' THEN 'Front desk'
    WHEN 'es' THEN 'Recepción'
    WHEN 'fr' THEN 'Accueil'
    WHEN 'de' THEN 'Empfang'
    WHEN 'hi' THEN 'रिसेप्शन'
    WHEN 'ja' THEN '受付'
    WHEN 'ko' THEN '안내 데스크'
    WHEN 'pt' THEN 'Recepção'
    WHEN 'zh' THEN '前台'
    WHEN 'it' THEN 'Accoglienza'
    WHEN 'uk' THEN 'Рецепція'
    WHEN 'ru' THEN 'Ресепшен'
    WHEN 'ar' THEN 'الاستقبال'
    WHEN 'sr' THEN 'Recepcija'
    ELSE 'Front desk'
  END
FROM public.businesses business
WHERE business.id = profile.business_id
  AND profile.is_default
  AND profile.name = 'Front desk';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'receptionist_profiles_name_check') THEN
    ALTER TABLE public.receptionist_profiles
      ADD CONSTRAINT receptionist_profiles_name_check CHECK (btrim(name) <> '');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'receptionist_profiles_scope_check') THEN
    ALTER TABLE public.receptionist_profiles
      ADD CONSTRAINT receptionist_profiles_scope_check CHECK (knowledge_scope IN ('all', 'audience'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'receptionist_profiles_status_check') THEN
    ALTER TABLE public.receptionist_profiles
      ADD CONSTRAINT receptionist_profiles_status_check CHECK (status IN ('active', 'paused'));
  END IF;
  -- The page address /profile/<slug>/<handle>: lower-case letters and digits
  -- in groups joined by single dashes.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'receptionist_profiles_handle_check') THEN
    ALTER TABLE public.receptionist_profiles
      ADD CONSTRAINT receptionist_profiles_handle_check CHECK (handle ~ '^[a-z0-9]+(-[a-z0-9]+)*$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'receptionist_profiles_locale_check') THEN
    ALTER TABLE public.receptionist_profiles
      ADD CONSTRAINT receptionist_profiles_locale_check CHECK (locale ~ '^[a-z]{2}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'receptionist_profiles_sort_order_check') THEN
    ALTER TABLE public.receptionist_profiles
      ADD CONSTRAINT receptionist_profiles_sort_order_check CHECK (sort_order >= 0);
  END IF;
  -- The default receptionist answers whatever names a paused or archived one,
  -- so it is never paused or archived itself.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'receptionist_profiles_default_live') THEN
    ALTER TABLE public.receptionist_profiles
      ADD CONSTRAINT receptionist_profiles_default_live CHECK (NOT is_default OR (status = 'active' AND archived_at IS NULL));
  END IF;
  -- The default receptionist's page is the business page; every other one has its own.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'receptionist_profiles_handle_required') THEN
    ALTER TABLE public.receptionist_profiles
      ADD CONSTRAINT receptionist_profiles_handle_required CHECK (is_default OR handle IS NOT NULL);
  END IF;
END
$$;

-- 3. One default per business, page handles unique among the receptionists
-- that aren't archived, the key the composite foreign keys of later files
-- point at, and the order lists show.
CREATE UNIQUE INDEX IF NOT EXISTS receptionist_profiles_business_default_unique
  ON public.receptionist_profiles (business_id) WHERE is_default;
CREATE UNIQUE INDEX IF NOT EXISTS receptionist_profiles_business_handle_unique
  ON public.receptionist_profiles (business_id, handle) WHERE handle IS NOT NULL AND archived_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS receptionist_profiles_business_id_unique
  ON public.receptionist_profiles (business_id, id);
CREATE INDEX IF NOT EXISTS receptionist_profiles_business_order_idx
  ON public.receptionist_profiles (business_id, sort_order, name);

COMMENT ON COLUMN public.receptionist_profiles.name IS 'Shown in the dashboard, in the page picker and on records. The default receptionist starts as "Front desk" in the business''s language.';
COMMENT ON COLUMN public.receptionist_profiles.description IS 'What it helps with. The picker shows it, and the other receptionists use it to send visitors here.';
COMMENT ON COLUMN public.receptionist_profiles.handle IS 'Its page address, /profile/<slug>/<handle>. Null on the default receptionist, whose page is the business page.';
COMMENT ON COLUMN public.receptionist_profiles.is_default IS 'The business''s default receptionist: exactly one per business. It answers whatever names no receptionist, or a paused or archived one.';
COMMENT ON COLUMN public.receptionist_profiles.knowledge_scope IS 'all answers from every article; audience from articles for everyone plus those chosen for it.';
COMMENT ON COLUMN public.receptionist_profiles.listed IS 'Shown in the business page''s picker. An unlisted one opens only from its own links, widget keys or number.';
COMMENT ON COLUMN public.receptionist_profiles.sort_order IS 'Custom order in the picker and lists. Ties sort by name.';
COMMENT ON COLUMN public.receptionist_profiles.locale IS 'The language its calls start in. Null uses the business''s.';
COMMENT ON COLUMN public.receptionist_profiles.status IS 'active, or paused by the owner or by a plan downgrade. A paused one''s entry points answer as the default.';
COMMENT ON COLUMN public.receptionist_profiles.archived_at IS 'When it was archived, which hides it and keeps its records. Receptionists are never deleted.';

-- 4. Settings every receptionist shares move to the business, copied from
-- each business's default receptionist. The update changes no status, so the
-- cancellation and deletion triggers of 0129 and 0130 don't fire.
ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS summary text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS summary_source varchar(16) NOT NULL DEFAULT 'placeholder',
  ADD COLUMN IF NOT EXISTS summary_fingerprint varchar(64),
  ADD COLUMN IF NOT EXISTS summary_generated_at timestamptz,
  ADD COLUMN IF NOT EXISTS recording_notice boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS appointment_change_policy jsonb;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'businesses_summary_source_check') THEN
    ALTER TABLE public.businesses
      ADD CONSTRAINT businesses_summary_source_check CHECK (summary_source IN ('placeholder', 'generated', 'operator'));
  END IF;
END
$$;

UPDATE public.businesses business
SET summary = profile.summary,
    summary_source = profile.summary_source,
    summary_fingerprint = profile.summary_fingerprint,
    summary_generated_at = profile.summary_generated_at,
    recording_notice = profile.recording_notice,
    appointment_change_policy = profile.appointment_change_policy
FROM public.receptionist_profiles profile
WHERE profile.business_id = business.id AND profile.is_default;

COMMENT ON COLUMN public.businesses.summary IS 'What the business does, which every receptionist''s prompts start from. Moved from receptionist_profiles in 0133.';
COMMENT ON COLUMN public.businesses.summary_source IS 'Who wrote the summary: placeholder (sign-up), generated (AI, from the articles for everyone) or operator.';
COMMENT ON COLUMN public.businesses.recording_notice IS 'Whether calls say, after the greeting, that the caller is speaking with an AI and the call is recorded and transcribed. Moved from receptionist_profiles in 0133.';
COMMENT ON COLUMN public.businesses.appointment_change_policy IS 'Whether and how callers may cancel or move appointments. Moved from receptionist_profiles in 0133.';

-- The summary backfill at worker start lists businesses that still have the
-- sign-up placeholder (0125), now from the business's own summary: other
-- receptionists' rows keep the column's default, which says nothing.
CREATE OR REPLACE FUNCTION app.list_summary_backfill_businesses()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT b.id
  FROM public.businesses b
  WHERE b.summary_source = 'placeholder'
    AND (
      EXISTS (SELECT 1 FROM public.knowledge_snippets s WHERE s.business_id = b.id AND s.active)
      OR EXISTS (SELECT 1 FROM public.knowledge_documents d WHERE d.business_id = b.id AND d.active AND d.status = 'indexed')
    )
    AND session_user = 'lobbystack_dispatcher'
    AND NULLIF(current_setting('app.actor_type', true), '') = 'dispatcher'
$$;

REVOKE ALL ON FUNCTION app.list_summary_backfill_businesses() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.list_summary_backfill_businesses() TO lobbystack_dispatcher;

-- 5. Until the clean-up deploy, the default receptionist's copy of the shared
-- settings follows the business's: whoever changes the copy, the old code
-- during a deploy or after a rollback, changes the business's too. The new
-- code writes the business first and then the copy, so the second write
-- copies what is already there. Making another receptionist the default
-- copies the business's values into that row first (receptionists.ts), so
-- the trigger never carries a stale copy over.
CREATE OR REPLACE FUNCTION app.copy_shared_receptionist_settings()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF NEW.is_default THEN
    UPDATE public.businesses
    SET summary = NEW.summary,
        summary_source = NEW.summary_source,
        summary_fingerprint = NEW.summary_fingerprint,
        summary_generated_at = NEW.summary_generated_at,
        recording_notice = NEW.recording_notice,
        appointment_change_policy = NEW.appointment_change_policy
    WHERE id = NEW.business_id
      AND (summary, summary_source, summary_fingerprint, summary_generated_at, recording_notice, appointment_change_policy)
        IS DISTINCT FROM (NEW.summary, NEW.summary_source, NEW.summary_fingerprint, NEW.summary_generated_at, NEW.recording_notice, NEW.appointment_change_policy);
  END IF;
  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION app.copy_shared_receptionist_settings() FROM PUBLIC;

DROP TRIGGER IF EXISTS receptionist_profiles_copy_shared_settings ON public.receptionist_profiles;
CREATE TRIGGER receptionist_profiles_copy_shared_settings
  AFTER INSERT OR UPDATE OF summary, summary_source, summary_fingerprint, summary_generated_at, recording_notice, appointment_change_policy
  ON public.receptionist_profiles
  FOR EACH ROW EXECUTE FUNCTION app.copy_shared_receptionist_settings();

-- 6. Rows that name a receptionist (0137) get the default one when a writer
-- leaves it out, which keeps the code still running during a deploy working.
-- It reads the business's own row only, past row-level security, because a
-- worker may insert before its transaction can see the profile. A business
-- without a receptionist, which only a test fixture can be, leaves it null,
-- which every reader takes as the default receptionist.
CREATE OR REPLACE FUNCTION app.fill_default_receptionist()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF NEW.receptionist_id IS NULL THEN
    SELECT profile.id INTO NEW.receptionist_id
    FROM public.receptionist_profiles profile
    WHERE profile.business_id = NEW.business_id AND profile.is_default;
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION app.fill_default_receptionist() FROM PUBLIC;
