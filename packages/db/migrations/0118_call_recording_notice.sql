-- Calls tell callers they're speaking with an AI and that the call is
-- recorded and transcribed, right after the greeting, in the language the
-- call opens in. It's on for every business, existing ones included, and a
-- business can turn it off in its receptionist settings or through the v1
-- API (recording_notice).

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.receptionist_profiles
  ADD COLUMN IF NOT EXISTS recording_notice boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.receptionist_profiles.recording_notice IS 'Whether calls say, after the greeting, that the caller is speaking with an AI and the call is recorded and transcribed.';
