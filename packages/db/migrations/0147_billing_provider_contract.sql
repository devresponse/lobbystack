-- Billing's contract (ADR 0010, the Stripe plan's step 19): the Polar columns
-- that 0146 kept beside their provider-neutral twins go, with the triggers
-- that kept the two equal. The code has read and written only the new columns
-- since 0146, so no running release touches what this drops.
--
-- Before it runs on a deployment with data, its operator checks that every
-- link and verify run names its provider, that every billing account's source
-- and every usage row's rate pass the checks below, and that no Polar event
-- stored before the webhook seam still waits to apply (docs/billing/data-model.md).
--
-- billing_accounts.source keeps its default: reconcile's upsert leaves the
-- source out for an account that exists, and PostgreSQL checks NOT NULL on the
-- row it would insert before it finds the conflict.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- The sync triggers and their functions.
DROP TRIGGER IF EXISTS billing_prices_ref_sync ON public.billing_prices;
DROP TRIGGER IF EXISTS billing_plans_disc_sync ON public.billing_plans;
DROP TRIGGER IF EXISTS billing_transactions_customer_sync ON public.billing_transactions;
DROP TRIGGER IF EXISTS billing_runs_provider_sync ON public.billing_runs;
DROP FUNCTION IF EXISTS app.billing_prices_ref_sync();
DROP FUNCTION IF EXISTS app.billing_plans_disc_sync();
DROP FUNCTION IF EXISTS app.billing_transactions_customer_sync();
DROP FUNCTION IF EXISTS app.billing_runs_provider_sync();

-- A Polar link run was written with the kind polar while the release before
-- 0146 could still run; it's a link run like any other.
UPDATE public.billing_runs SET kind = 'link' WHERE kind = 'polar';

-- The offers view and the code offers function read the Polar columns: they go
-- first, and are made again below without them.
DROP FUNCTION IF EXISTS app.billing_code_offers(text);
DROP VIEW IF EXISTS public.billing_offers;

-- Runs: the provider columns alone name a link's or a verify's account.
ALTER TABLE public.billing_runs DROP CONSTRAINT IF EXISTS billing_runs_provider;
ALTER TABLE public.billing_runs DROP CONSTRAINT IF EXISTS billing_runs_kind_check;
ALTER TABLE public.billing_runs DROP COLUMN IF EXISTS polar_env, DROP COLUMN IF EXISTS polar_org;
ALTER TABLE public.billing_runs ADD CONSTRAINT billing_runs_kind_check CHECK (kind IN ('catalog', 'link', 'verify'));
ALTER TABLE public.billing_runs ADD CONSTRAINT billing_runs_provider CHECK (
  kind = 'catalog' OR num_nulls(provider, provider_env, provider_account) = 0
);
COMMENT ON COLUMN public.billing_runs.kind IS 'catalog (an apply), link (provider objects linked to the catalog) or verify (a check of the file, the tables and the provider).';

-- Prices, plans and transactions: their Polar twins.
DROP INDEX IF EXISTS public.billing_prices_polar_unique;
ALTER TABLE public.billing_prices DROP COLUMN IF EXISTS polar_id;
DROP INDEX IF EXISTS public.billing_plans_polar_disc_unique;
ALTER TABLE public.billing_plans DROP COLUMN IF EXISTS polar_disc;
ALTER TABLE public.billing_transactions DROP COLUMN IF EXISTS polar_customer_id;

-- The checks 0146 added without checking the rows already there.
ALTER TABLE public.billing_accounts VALIDATE CONSTRAINT billing_accounts_source_check;
ALTER TABLE public.billing_usage_events VALIDATE CONSTRAINT billing_usage_events_rate_cents_check;

-- 0114's index for Polar events still waiting; 0146's covers either provider.
DROP INDEX IF EXISTS public.provider_events_polar_received_idx;

-- The offers view and the code offers function as in 0146, without polar_disc and polar_id.
CREATE VIEW public.billing_offers WITH (security_invoker = true) AS
SELECT p.code, p.tier, p.access, p.sold, p.custom, p.overage, p.names,
  p.voice_sec, p.sms_seg, p.calls_out, p.chat_units, p.kb_bytes, p.numbers,
  p.voice_rate, p.sms_rate, p.call_rate, p.months, p.ends, p.offer_end,
  p.discount, p.sort,
  r.period, r.currency, r.cents, r.per_month,
  p.receptionists,
  p.provider_disc, r.provider_ref
FROM public.billing_plans p
LEFT JOIN public.billing_prices r ON r.plan = p.code AND r.retired_at IS NULL
WHERE p.status = 'active' AND (p.offer_end IS NULL OR p.offer_end > now());

COMMENT ON VIEW public.billing_offers IS 'Plans on offer now: active, offer not ended, with their live prices. Reads with the caller''s row-level security.';
REVOKE ALL ON public.billing_offers FROM PUBLIC;
GRANT SELECT ON public.billing_offers TO lobbystack_app, lobbystack_worker, lobbystack_readonly;

CREATE FUNCTION app.billing_code_offers(p_code text)
RETURNS TABLE (
  code_id uuid, plan varchar, tier varchar, names jsonb, discount jsonb,
  months smallint, ends varchar,
  voice_sec integer, sms_seg integer, calls_out integer, chat_units integer, kb_bytes bigint, numbers smallint,
  overage boolean, voice_rate integer, sms_rate integer, call_rate integer,
  period varchar, currency char(3), cents integer, per_month integer,
  receptionists smallint,
  provider_disc text, provider_ref text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT c.id, o.code, o.tier, o.names, o.discount, o.months, o.ends,
    o.voice_sec, o.sms_seg, o.calls_out, o.chat_units, o.kb_bytes, o.numbers,
    o.overage, o.voice_rate, o.sms_rate, o.call_rate,
    o.period, o.currency, o.cents, o.per_month,
    o.receptionists,
    o.provider_disc, o.provider_ref
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
