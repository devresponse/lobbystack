-- Owners and admins can archive a call from its page in the dashboard.
-- Archiving only hides the call: it leaves the Calls list and Home's recent
-- calls, and nothing is deleted. Its transcript, recording, summary and
-- follow-ups stay, its page still opens from links, marked Archived, and an
-- owner or admin can restore it there. The contact's history, counts,
-- analytics, billing and the v1 API still include it. Who archived or
-- restored a call is in audit_logs (call.archived, call.restored).

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.calls
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

COMMENT ON COLUMN public.calls.archived_at IS 'When an owner or admin archived the call, which hides it from the Calls list and Home. Null when it isn''t archived. Nothing is deleted.';
