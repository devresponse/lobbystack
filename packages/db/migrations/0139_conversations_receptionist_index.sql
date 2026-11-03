-- lobbystack:concurrent-index conversations_business_receptionist_updated_idx
-- The Messages page's receptionist filter, most recent first. Built
-- concurrently: conversations is one of the largest tables.
CREATE INDEX CONCURRENTLY IF NOT EXISTS conversations_business_receptionist_updated_idx
ON public.conversations (business_id, receptionist_id, updated_at DESC);
