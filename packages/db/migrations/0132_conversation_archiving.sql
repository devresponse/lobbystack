-- Owners and admins can archive a conversation from the dashboard's Messages
-- page. Archiving only hides it: it leaves the Messages list and Home's
-- Action required, and nothing is deleted. Its messages stay, the Messages
-- page's Archived filter lists it, and an owner or admin can restore it
-- there. A new message in it, such as a customer's text, brings it back on
-- its own. Who archived or restored a conversation is in audit_logs
-- (conversation.archived, conversation.restored).

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

COMMENT ON COLUMN public.conversations.archived_at IS 'When an owner or admin archived the conversation, which hides it from the Messages list and Home''s Action required. Null when it isn''t archived; a new message in it clears it. Nothing is deleted.';
