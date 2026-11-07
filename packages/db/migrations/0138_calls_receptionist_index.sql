-- lobbystack:concurrent-index calls_business_receptionist_started_idx
-- The Calls page's receptionist filter, newest first. Built concurrently:
-- calls is one of the largest tables.
CREATE INDEX CONCURRENTLY IF NOT EXISTS calls_business_receptionist_started_idx
ON public.calls (business_id, receptionist_id, started_at DESC);
