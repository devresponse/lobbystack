-- How many receptionists each plan includes: limits.receptionists in each
-- brand's billing.json, which a catalog apply writes here. A custom plan such
-- as Enterprise has none, and gets the deployment's cap,
-- MAX_RECEPTIONISTS_PER_BUSINESS (50 unless set). The count stays out of
-- terms_hash: Polar never sees it, and adding it to the hash would change the
-- terms of every plan, frozen ones included.
--
-- Rows from before this file get the numbers both brands' files give their
-- tiers, so a deployment enforces them before its next apply. A row the
-- previous code writes during a deploy has none, and the code reads the tier's
-- number until the next apply fills it.

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.billing_plans
  ADD COLUMN IF NOT EXISTS receptionists smallint;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'billing_plans_receptionists_check') THEN
    ALTER TABLE public.billing_plans
      ADD CONSTRAINT billing_plans_receptionists_check CHECK (receptionists IS NULL OR (receptionists BETWEEN 1 AND 50 AND NOT custom));
  END IF;
END
$$;

UPDATE public.billing_plans
SET receptionists = CASE tier WHEN 'pro' THEN 5 ELSE 1 END
WHERE NOT custom AND receptionists IS NULL;

COMMENT ON COLUMN public.billing_plans.receptionists IS 'Receptionists a business on the plan may have, the default one included. Null on a custom plan, which gets the deployment''s cap.';

-- Promo codes show what the plan they sell includes, receptionists too. The
-- view gains the column at its end, which CREATE OR REPLACE allows, and
-- app.billing_code_offers returns it last: a function's result columns can
-- only change by making it again. The previous code reads the result by
-- column name, so the added column changes nothing for it.
CREATE OR REPLACE VIEW public.billing_offers WITH (security_invoker = true) AS
SELECT p.code, p.tier, p.access, p.sold, p.custom, p.overage, p.names,
  p.voice_sec, p.sms_seg, p.calls_out, p.chat_units, p.kb_bytes, p.numbers,
  p.voice_rate, p.sms_rate, p.call_rate, p.months, p.ends, p.offer_end,
  p.discount, p.polar_disc, p.sort,
  r.period, r.currency, r.cents, r.per_month, r.polar_id,
  p.receptionists
FROM public.billing_plans p
LEFT JOIN public.billing_prices r ON r.plan = p.code AND r.retired_at IS NULL
WHERE p.status = 'active' AND (p.offer_end IS NULL OR p.offer_end > now());

COMMENT ON VIEW public.billing_offers IS 'Plans on offer now: active, offer not ended, with their live prices. Reads with the caller''s row-level security.';
REVOKE ALL ON public.billing_offers FROM PUBLIC;
GRANT SELECT ON public.billing_offers TO lobbystack_app, lobbystack_worker, lobbystack_readonly;

DROP FUNCTION IF EXISTS app.billing_code_offers(text);
CREATE FUNCTION app.billing_code_offers(p_code text)
RETURNS TABLE (
  code_id uuid, plan varchar, tier varchar, names jsonb, discount jsonb, polar_disc text,
  months smallint, ends varchar,
  voice_sec integer, sms_seg integer, calls_out integer, chat_units integer, kb_bytes bigint, numbers smallint,
  overage boolean, voice_rate integer, sms_rate integer, call_rate integer,
  period varchar, currency char(3), cents integer, per_month integer, polar_id text,
  receptionists smallint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT c.id, o.code, o.tier, o.names, o.discount, o.polar_disc, o.months, o.ends,
    o.voice_sec, o.sms_seg, o.calls_out, o.chat_units, o.kb_bytes, o.numbers,
    o.overage, o.voice_rate, o.sms_rate, o.call_rate,
    o.period, o.currency, o.cents, o.per_month, o.polar_id,
    o.receptionists
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
