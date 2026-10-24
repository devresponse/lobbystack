-- Billing work that never finished: a Polar event whose reconciliation failed
-- every retry, usage that never reached Polar's meter, and a checkout request
-- whose job died. Each kept its row, but nothing ran it again, so a business
-- could pay and stay on Free, or use what it was never billed for. The
-- worker's billing sweep reads this listing every few minutes and queues the
-- work again in each business's own scope.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- The sweep's reads. Rows leave both indexes once their work is done, so they
-- stay small.
CREATE INDEX IF NOT EXISTS provider_events_polar_received_idx
  ON public.provider_events (created_at)
  WHERE status = 'received' AND provider = 'polar';
CREATE INDEX IF NOT EXISTS billing_checkout_requests_open_idx
  ON public.billing_checkout_requests (updated_at)
  WHERE status IN ('pending', 'processing');

-- The worker reads billing rows only inside one business's RLS context, so
-- this returns which rows wait, and in which business, and nothing else:
--   provider_event: a Polar event still received, stored before p_events_before;
--   usage_event: final usage of a kind Polar meters, recorded on Starter or Pro
--     for a business with a Polar customer, still pending and untouched since
--     p_usage_before;
--   checkout_request: a request still pending or processing, untouched since
--     p_checkouts_before.
-- A row the sweep already queued in hour p_hour (its outbox key is
-- billing-sweep:<kind>:<id>:<hour>, as billingSweep.ts writes it) is left out,
-- so work that keeps failing doesn't hide the rows behind it. Each kind returns
-- at most p_limit rows, oldest first.
CREATE OR REPLACE FUNCTION app.list_billing_sweep_work(
  p_events_before timestamptz,
  p_usage_before timestamptz,
  p_checkouts_before timestamptz,
  p_hour bigint,
  p_limit integer
)
RETURNS TABLE (kind text, business_id uuid, entity_id uuid, created_at timestamptz, updated_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  (
    SELECT 'provider_event'::text, e.business_id, e.id, e.created_at, e.updated_at
    FROM public.provider_events e
    WHERE e.status = 'received'
      AND e.provider = 'polar'
      AND e.business_id IS NOT NULL
      AND e.created_at < p_events_before
      AND NOT EXISTS (SELECT 1 FROM public.outbox_messages o WHERE o.dedupe_key = 'billing-sweep:provider_event:' || e.id::text || ':' || p_hour::text)
      AND session_user = 'lobbystack_worker'
      AND NULLIF(current_setting('app.actor_type', true), '') = 'worker'
    ORDER BY e.created_at
    LIMIT p_limit
  )
  UNION ALL
  (
    SELECT 'usage_event'::text, u.business_id, u.id, u.created_at, u.updated_at
    FROM public.billing_usage_events u
    JOIN public.billing_accounts a ON a.business_id = u.business_id
    WHERE u.sync_status = 'pending'
      AND u.is_final
      AND u.usage_kind IN ('voice_seconds', 'alert_sms_segments', 'outbound_call_attempts')
      AND coalesce(u.plan_at_record_time, a.plan) IN ('starter', 'pro')
      AND a.customer_id IS NOT NULL
      AND u.updated_at < p_usage_before
      AND NOT EXISTS (SELECT 1 FROM public.outbox_messages o WHERE o.dedupe_key = 'billing-sweep:usage_event:' || u.id::text || ':' || p_hour::text)
      AND session_user = 'lobbystack_worker'
      AND NULLIF(current_setting('app.actor_type', true), '') = 'worker'
    ORDER BY u.updated_at
    LIMIT p_limit
  )
  UNION ALL
  (
    SELECT 'checkout_request'::text, r.business_id, r.id, r.created_at, r.updated_at
    FROM public.billing_checkout_requests r
    WHERE r.status IN ('pending', 'processing')
      AND r.updated_at < p_checkouts_before
      AND NOT EXISTS (SELECT 1 FROM public.outbox_messages o WHERE o.dedupe_key = 'billing-sweep:checkout_request:' || r.id::text || ':' || p_hour::text)
      AND session_user = 'lobbystack_worker'
      AND NULLIF(current_setting('app.actor_type', true), '') = 'worker'
    ORDER BY r.updated_at
    LIMIT p_limit
  )
$$;

REVOKE ALL ON FUNCTION app.list_billing_sweep_work(timestamptz, timestamptz, timestamptz, bigint, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.list_billing_sweep_work(timestamptz, timestamptz, timestamptz, bigint, integer) TO lobbystack_worker;
