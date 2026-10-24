-- Three billing races and one lost correction.
--
-- A shared promo code's use limit counted only subscriptions, so every
-- checkout opened before the first one was paid could pay with it. Its open
-- checkouts now count too.
--
-- The worker changes a business's Polar subscription from three jobs: a plan
-- change, a promo plan's ending and a discount's removal. Each reads the
-- subscription from Polar and then changes it, and two at once would each
-- change it from what the other replaced. A change now claims the
-- subscription first, for a few minutes at most.
--
-- Polar keeps one event per ID, and a usage row's correction after its first
-- sync went out under the same ID, so Polar dropped it. Each correction now
-- goes out as a new event for the difference, numbered after the ones Polar
-- has.

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.billing_accounts
  ADD COLUMN IF NOT EXISTS subscription_claim uuid,
  ADD COLUMN IF NOT EXISTS subscription_claimed_until timestamptz;

COMMENT ON COLUMN public.billing_accounts.subscription_claim IS 'The worker run changing the business''s Polar subscription, while it does.';
COMMENT ON COLUMN public.billing_accounts.subscription_claimed_until IS 'When that run''s claim runs out, in case its worker died.';

ALTER TABLE public.billing_usage_events
  ADD COLUMN IF NOT EXISTS synced_quantity double precision,
  ADD COLUMN IF NOT EXISTS sync_seq integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sending_quantity double precision;

COMMENT ON COLUMN public.billing_usage_events.synced_quantity IS 'The billable quantity Polar has, the sum of the events it took. Null before the first, and on rows synced before migration 0116, whose first event carried their billable quantity.';
COMMENT ON COLUMN public.billing_usage_events.sync_seq IS 'The number of the next event to send Polar: 0 goes out under source_key, each later one under source_key:<number>.';
COMMENT ON COLUMN public.billing_usage_events.sending_quantity IS 'The difference the event numbered sync_seq carries, once a worker run claimed it and until Polar takes it.';

-- The offer lookup counts a code's open checkouts.
CREATE INDEX IF NOT EXISTS billing_checkout_requests_code_idx
  ON public.billing_checkout_requests (code_id, created_at)
  WHERE code_id IS NOT NULL;

-- The offer a code unlocks, as in 0113, except that a shared code's use limit
-- also counts the other businesses with a checkout for it that may still be
-- paid: one pending, processing, ready or changed, from the last 25 hours
-- (Polar keeps a checkout page for 24, and the job makes it within 15
-- minutes), by a business that hasn't subscribed with the code yet. The
-- business asking doesn't count its own, so it can still pay the checkout it
-- opened. billingCodeCheckout takes a lock on the code first, so two
-- businesses can't both take its last use.
CREATE OR REPLACE FUNCTION app.billing_code_offers(p_code text)
RETURNS TABLE (
  code_id uuid, plan varchar, tier varchar, names jsonb, discount jsonb, polar_disc text,
  months smallint, ends varchar,
  voice_sec integer, sms_seg integer, calls_out integer, chat_units integer, kb_bytes bigint, numbers smallint,
  overage boolean, voice_rate integer, sms_rate integer, call_rate integer,
  period varchar, currency char(3), cents integer, per_month integer, polar_id text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT c.id, o.code, o.tier, o.names, o.discount, o.polar_disc, o.months, o.ends,
    o.voice_sec, o.sms_seg, o.calls_out, o.chat_units, o.kb_bytes, o.numbers,
    o.overage, o.voice_rate, o.sms_rate, o.call_rate,
    o.period, o.currency, o.cents, o.per_month, o.polar_id
  FROM public.billing_codes c
  JOIN public.billing_offers o ON o.code = c.plan
  WHERE c.code = p_code
    AND c.status = 'active'
    AND (c.expires_at IS NULL OR c.expires_at > now())
    AND (c.max_uses IS NULL OR c.uses + (
      SELECT count(DISTINCT q.business_id)
      FROM public.billing_checkout_requests q
      WHERE q.code_id = c.id
        AND q.business_id IS DISTINCT FROM app.current_business_id()
        AND q.status IN ('pending', 'processing', 'ready', 'changed')
        AND q.created_at > now() - interval '25 hours'
        AND NOT EXISTS (
          SELECT 1 FROM public.billing_code_redemptions r
          WHERE r.code_id = c.id AND r.business_id = q.business_id
        )
    ) < c.max_uses)
    AND (c.business_id IS NULL OR c.business_id = app.current_business_id())
    AND (
      NOT EXISTS (
        SELECT 1 FROM public.billing_code_redemptions r
        WHERE r.code_id = c.id AND r.business_id = app.current_business_id()
      )
      OR EXISTS (
        SELECT 1 FROM public.billing_accounts a
        WHERE a.business_id = app.current_business_id()
          AND a.plan_code = c.plan
          AND a.subscription_state IN ('active', 'trialing', 'past_due')
      )
    )
    AND o.access = 'code'
    AND o.sold
    AND o.period IS NOT NULL
  ORDER BY o.period
$$;

REVOKE ALL ON FUNCTION app.billing_code_offers(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.billing_code_offers(text) TO lobbystack_app, lobbystack_worker;
