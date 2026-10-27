-- The plan screens and the v1 plans API show an annual price as what it comes
-- to a month. That was the price / 12 rounded down, so CA$370 a year showed as
-- CA$30.83 a month; now it is rounded to the nearest whole unit of the
-- currency, CA$31, as perMonthCents in packages/shared/src/billing.ts computes
-- it for a deployment that hasn't applied its billing.json yet. Only what is
-- shown changes: Polar charges the annual price itself.
--
-- PostgreSQL 16 can't change a generated column's expression, so per_month is
-- dropped and added again. billing_offers, the one view that reads it, is
-- dropped first and made again as 0108 made it. app.billing_code_offers reads
-- that view by name when it runs, so it needs no change.

SET LOCAL lock_timeout = '5s';

DROP VIEW IF EXISTS public.billing_offers;

ALTER TABLE public.billing_prices DROP COLUMN IF EXISTS per_month;
ALTER TABLE public.billing_prices
  ADD COLUMN per_month integer GENERATED ALWAYS AS (
    CASE WHEN period = 'annual' THEN (round(cents / 1200.0) * 100)::integer ELSE cents END
  ) STORED;

COMMENT ON COLUMN public.billing_prices.per_month IS 'Price per month, computed: cents, or for annual cents / 12 rounded to a whole unit of the currency.';

CREATE VIEW public.billing_offers WITH (security_invoker = true) AS
SELECT p.code, p.tier, p.access, p.sold, p.custom, p.overage, p.names,
  p.voice_sec, p.sms_seg, p.calls_out, p.chat_units, p.kb_bytes, p.numbers,
  p.voice_rate, p.sms_rate, p.call_rate, p.months, p.ends, p.offer_end,
  p.discount, p.polar_disc, p.sort,
  r.period, r.currency, r.cents, r.per_month, r.polar_id
FROM public.billing_plans p
LEFT JOIN public.billing_prices r ON r.plan = p.code AND r.retired_at IS NULL
WHERE p.status = 'active' AND (p.offer_end IS NULL OR p.offer_end > now());

COMMENT ON VIEW public.billing_offers IS 'Plans on offer now: active, offer not ended, with their live prices. Reads with the caller''s row-level security.';

-- The view adds no access of its own: it reads with each caller's policies (security_invoker).
REVOKE ALL ON public.billing_offers FROM PUBLIC;
GRANT SELECT ON public.billing_offers TO lobbystack_app, lobbystack_worker, lobbystack_readonly;
