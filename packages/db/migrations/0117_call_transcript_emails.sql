-- Team emails after each call, with its summary or its whole transcript.
--
-- Each business chooses who may get them and what they hold:
--   call_transcript_recipients: nobody, owners_and_admins (owners and admins
--     only, the default) or team (every member)
--   call_transcript_content: summary (the summary and a link to the call, the
--     default) or transcript (the summary and the whole conversation)
-- Each person still turns the email on for themselves under Settings >
-- Notifications, and it starts off for everyone.
--
-- The worker's recipient lookup now also returns each member's role, to apply
-- the business's choice when it sends, and their interface language, to write
-- the email in it.

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS call_transcript_recipients varchar(32) NOT NULL DEFAULT 'owners_and_admins',
  ADD COLUMN IF NOT EXISTS call_transcript_content varchar(32) NOT NULL DEFAULT 'summary';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'businesses_call_transcript_recipients_check') THEN
    ALTER TABLE public.businesses
      ADD CONSTRAINT businesses_call_transcript_recipients_check CHECK (call_transcript_recipients IN ('nobody', 'owners_and_admins', 'team'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'businesses_call_transcript_content_check') THEN
    ALTER TABLE public.businesses
      ADD CONSTRAINT businesses_call_transcript_content_check CHECK (call_transcript_content IN ('summary', 'transcript'));
  END IF;
END
$$;

COMMENT ON COLUMN public.businesses.call_transcript_recipients IS 'Who may get an email after each call: nobody, owners_and_admins or team. Each person also turns it on for themselves.';
COMMENT ON COLUMN public.businesses.call_transcript_content IS 'What the email after each call holds: summary (the summary and a link) or transcript (the whole conversation too).';

DROP FUNCTION IF EXISTS app.resolve_operator_notification_recipients(uuid);

CREATE FUNCTION app.resolve_operator_notification_recipients(target_business_id uuid)
RETURNS TABLE(
  user_id uuid,
  email text,
  phone text,
  event_preferences jsonb,
  email_enabled boolean,
  sms_enabled boolean,
  daily_summary_enabled boolean,
  daily_summary_send_time varchar(5),
  sms_consent_granted_at timestamptz,
  sms_consent_revoked_at timestamptz,
  sms_consent_disclosure_version varchar(64),
  sms_consent_phone varchar(32),
  role varchar(32),
  preferred_locale varchar(8)
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app, pg_catalog
AS $$
  SELECT u.id, u.email, u.phone, p.event_preferences,
    COALESCE(p.email_enabled, true), COALESCE(p.sms_enabled, false),
    COALESCE(p.daily_summary_enabled, false), p.daily_summary_send_time,
    p.sms_consent_granted_at, p.sms_consent_revoked_at, p.sms_consent_disclosure_version, p.sms_consent_phone,
    m.role, u.preferred_locale
  FROM public.business_memberships m
  JOIN public.users u ON u.id = m.user_id
  LEFT JOIN public.operator_notification_preferences p ON p.business_id = m.business_id AND p.user_id = m.user_id
  WHERE session_user = 'lobbystack_worker'
    AND NULLIF(current_setting('app.actor_type', true), '') = 'worker'
    AND target_business_id = NULLIF(current_setting('app.business_id', true), '')::uuid
    AND m.business_id = target_business_id AND m.status = 'active'
  ORDER BY m.created_at, m.id
$$;

REVOKE ALL ON FUNCTION app.resolve_operator_notification_recipients(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_operator_notification_recipients(uuid) TO lobbystack_worker;
