-- Several receptionists per business, finished for a new database: this
-- removes what migrations 0133 and 0137 kept for the release before them,
-- whose code still ran while a deploy finished.
--   * Every business gets its default receptionist with it, so a call, chat
--     or follow-up always has a receptionist to name.
--   * The settings every receptionist shares (the business summary, the AI
--     and recording notice and the appointment change rules) live only on
--     businesses: the default receptionist's copies and the trigger that
--     copied them go.
--   * Calls, conversations and inbox items always name the receptionist that
--     answered them, so the worker's backfill and the readers' "none means
--     the default" go too.
--
-- A deployment runs this file with the ones before it on an empty database,
-- so nothing here waits for a backfill or splits a step to spare a large
-- table its locks. The statements under "Rows from before" find nothing to
-- change on a new database; they only keep this file from failing on a
-- database that already had businesses or calls.

SET LOCAL lock_timeout = '5s';

-- 1. The default receptionist's name in a language, "Front desk" for one
-- without a name: DEFAULT_RECEPTIONIST_NAMES and defaultReceptionistName in
-- packages/shared/src/receptionists.ts, which a test compares with this list.
CREATE OR REPLACE FUNCTION app.default_receptionist_name(p_locale text)
RETURNS varchar
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_catalog
AS $$
  SELECT (CASE split_part(replace(lower(btrim(coalesce(p_locale, ''))), '_', '-'), '-', 1)
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
  END)::varchar
$$;

REVOKE ALL ON FUNCTION app.default_receptionist_name(text) FROM PUBLIC;

-- 2. A new business gets its default receptionist in the same statement,
-- named in the business's language, with the settings 0133 gave a business
-- that had no receptionist yet. Sign-up and prospect demos then give it their
-- own greeting and instructions (insertBusinessInTransaction,
-- createProspectDemo in packages/domain); a business made any other way, such
-- as by the seed or a test, keeps these. It writes past row-level security,
-- because the business's owner isn't a member yet when the business row goes
-- in.
CREATE OR REPLACE FUNCTION app.add_default_receptionist()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  INSERT INTO public.receptionist_profiles (business_id, name, is_default, greeting, tone, booking_policy, transfer_mode)
  VALUES (
    NEW.id,
    app.default_receptionist_name(NEW.default_locale),
    true,
    'Thank you for calling ' || NEW.name || '.',
    'professional',
    'Confirm availability before booking.',
    'on_request'
  );
  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION app.add_default_receptionist() FROM PUBLIC;

DROP TRIGGER IF EXISTS businesses_add_default_receptionist ON public.businesses;
CREATE TRIGGER businesses_add_default_receptionist
  AFTER INSERT ON public.businesses
  FOR EACH ROW EXECUTE FUNCTION app.add_default_receptionist();

-- Rows from before: a business made outside sign-up after 0133, such as by
-- the seed, may have none yet.
INSERT INTO public.receptionist_profiles (business_id, name, is_default, greeting, tone, booking_policy, transfer_mode)
SELECT business.id, app.default_receptionist_name(business.default_locale), true,
  'Thank you for calling ' || business.name || '.', 'professional', 'Confirm availability before booking.', 'on_request'
FROM public.businesses business
WHERE NOT EXISTS (SELECT 1 FROM public.receptionist_profiles profile WHERE profile.business_id = business.id AND profile.is_default);

-- 3. The settings every receptionist shares live only on businesses, which
-- has had them since 0133. The default receptionist's copies, and the
-- trigger that copied an edit of them to the business, go.
DROP TRIGGER IF EXISTS receptionist_profiles_copy_shared_settings ON public.receptionist_profiles;
DROP FUNCTION IF EXISTS app.copy_shared_receptionist_settings();

ALTER TABLE public.receptionist_profiles
  DROP COLUMN IF EXISTS summary,
  DROP COLUMN IF EXISTS summary_source,
  DROP COLUMN IF EXISTS summary_fingerprint,
  DROP COLUMN IF EXISTS summary_generated_at,
  DROP COLUMN IF EXISTS recording_notice,
  DROP COLUMN IF EXISTS appointment_change_policy;

COMMENT ON COLUMN public.businesses.summary IS 'What the business does, which every receptionist''s prompts start from.';
COMMENT ON COLUMN public.businesses.recording_notice IS 'Whether calls say, after the greeting, that the caller is speaking with an AI and the call is recorded and transcribed.';
COMMENT ON COLUMN public.businesses.appointment_change_policy IS 'Whether and how callers may cancel or move appointments.';

-- 4. Calls, conversations and inbox items always name the receptionist that
-- answered them. An insert that names none still gets the business's default
-- receptionist (app.fill_default_receptionist, from 0133), which now always
-- exists.

-- Rows from before: records written before 0137 named none.
UPDATE public.calls record SET receptionist_id = profile.id
FROM public.receptionist_profiles profile
WHERE record.receptionist_id IS NULL AND profile.business_id = record.business_id AND profile.is_default;
UPDATE public.conversations record SET receptionist_id = profile.id
FROM public.receptionist_profiles profile
WHERE record.receptionist_id IS NULL AND profile.business_id = record.business_id AND profile.is_default;
UPDATE public.inbox_items record SET receptionist_id = profile.id
FROM public.receptionist_profiles profile
WHERE record.receptionist_id IS NULL AND profile.business_id = record.business_id AND profile.is_default;

ALTER TABLE public.calls VALIDATE CONSTRAINT calls_receptionist_fk;
ALTER TABLE public.conversations VALIDATE CONSTRAINT conversations_receptionist_fk;
ALTER TABLE public.inbox_items VALIDATE CONSTRAINT inbox_items_receptionist_fk;

ALTER TABLE public.calls ALTER COLUMN receptionist_id SET NOT NULL;
ALTER TABLE public.conversations ALTER COLUMN receptionist_id SET NOT NULL;
ALTER TABLE public.inbox_items ALTER COLUMN receptionist_id SET NOT NULL;

COMMENT ON COLUMN public.calls.receptionist_id IS 'The receptionist that answered. An insert that names none gets the business''s default receptionist.';
COMMENT ON COLUMN public.conversations.receptionist_id IS 'The receptionist that answered. An insert that names none gets the business''s default receptionist.';
COMMENT ON COLUMN public.inbox_items.receptionist_id IS 'The receptionist whose call or chat made the item. An insert that names none gets the business''s default receptionist.';
COMMENT ON FUNCTION app.fill_default_receptionist() IS 'Gives a call, conversation, inbox item, phone number or widget key the business''s default receptionist when its insert names none.';
