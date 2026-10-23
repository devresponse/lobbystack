-- A business uses a promo code once. Polar's webhook counted a use each time a
-- business's subscription moved onto the code's plan, so a business whose plan
-- had ended, or whose subscription had lapsed, could check out with the same
-- shared code again and start its months over. Each business that subscribed
-- with a code now has a row here, and the code finds no offer for it again,
-- except while its live subscription is on that plan, so the dashboard still
-- says it is on it.

CREATE TABLE IF NOT EXISTS public.billing_code_redemptions (
  code_id uuid NOT NULL REFERENCES public.billing_codes(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  redeemed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (code_id, business_id)
);

-- A business's rows go with it.
CREATE INDEX IF NOT EXISTS billing_code_redemptions_business_idx ON public.billing_code_redemptions (business_id);

COMMENT ON TABLE public.billing_code_redemptions IS 'Each business that subscribed with a promo code, once.';
COMMENT ON COLUMN public.billing_code_redemptions.code_id IS 'The code.';
COMMENT ON COLUMN public.billing_code_redemptions.business_id IS 'The business that subscribed with it.';
COMMENT ON COLUMN public.billing_code_redemptions.redeemed_at IS 'When its subscription first went live on the code''s plan.';

-- Only the worker writes them, as Polar's webhook puts a business on a code's
-- plan, and reads its business's own. The read-only role reads them all. The
-- app never reads them: app.billing_code_offers does, as its owner. They go
-- only with their business or code.
ALTER TABLE public.billing_code_redemptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_code_redemptions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS billing_code_redemptions_worker_read ON public.billing_code_redemptions;
DROP POLICY IF EXISTS billing_code_redemptions_worker_insert ON public.billing_code_redemptions;
DROP POLICY IF EXISTS billing_code_redemptions_read_all ON public.billing_code_redemptions;
CREATE POLICY billing_code_redemptions_worker_read ON public.billing_code_redemptions FOR SELECT TO lobbystack_worker USING (business_id = app.current_business_id());
CREATE POLICY billing_code_redemptions_worker_insert ON public.billing_code_redemptions FOR INSERT TO lobbystack_worker WITH CHECK (business_id = app.current_business_id() AND app.current_actor_type() = 'worker');
CREATE POLICY billing_code_redemptions_read_all ON public.billing_code_redemptions FOR SELECT TO lobbystack_readonly USING (true);
REVOKE ALL ON public.billing_code_redemptions FROM PUBLIC;
GRANT SELECT, INSERT ON public.billing_code_redemptions TO lobbystack_worker;
GRANT SELECT ON public.billing_code_redemptions TO lobbystack_readonly;

-- The codes businesses already subscribed with: the audit row each use wrote,
-- and the code on each account. Running this file again changes nothing, and
-- uses keeps its count.
--
-- Reading every business's rows needs a role that sees them all, like 0105.
DO $$
DECLARE
  recorded integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE NOTICE 'Skipping the promo code redemption backfill: % is subject to row-level security.', current_user;
    RETURN;
  END IF;

  INSERT INTO public.billing_code_redemptions (code_id, business_id, redeemed_at)
  SELECT used.code_id, used.business_id, min(used.redeemed_at)
  FROM (
    SELECT audit.entity_id AS code_id, audit.business_id, audit.created_at AS redeemed_at
    FROM public.audit_logs audit
    WHERE audit.event_type = 'billing.promo_code_redeemed'
      AND audit.entity_type = 'billing_code'
      AND audit.entity_id IS NOT NULL
    UNION ALL
    SELECT account.code_id, account.business_id, account.updated_at
    FROM public.billing_accounts account
    WHERE account.code_id IS NOT NULL
  ) used
  JOIN public.billing_codes code ON code.id = used.code_id
  GROUP BY used.code_id, used.business_id
  ON CONFLICT (code_id, business_id) DO NOTHING;
  GET DIAGNOSTICS recorded = ROW_COUNT;

  RAISE NOTICE 'Promo codes: % uses by a business recorded.', recorded;
END
$$;

-- The offer a code unlocks, as in 0110, except to a business that already
-- subscribed with it: one whose live subscription is on the code's plan still
-- finds it, and checkout then says it is on that plan.
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
    AND (c.max_uses IS NULL OR c.uses < c.max_uses)
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
