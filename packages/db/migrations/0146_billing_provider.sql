-- Billing stops assuming Polar (ADR 0010, the Stripe plan's step 5). Expand
-- only: every Polar column stays, and the triggers below keep each one equal to
-- its new provider-neutral twin until the contract migration drops them, so the
-- release before this one keeps working while Railway restarts the services,
-- and going back to it stays safe. From this release on the code reads and
-- writes only the new columns.
--
-- The columns Stripe needs later are added here too (the overage
-- subscription, a plan's coming end or change, usage priced as money, the
-- daily totals check), so the Stripe steps need no migration of their own.
--
-- Rows from before: the UPDATEs below fill the new columns from the Polar
-- ones. They run on a deployment's own billing tables, a few rows per plan,
-- price and run, and one per transaction.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- Runs: which provider, environment and account a link or a verify ran against.
ALTER TABLE public.billing_runs
  ADD COLUMN IF NOT EXISTS provider varchar(8),
  ADD COLUMN IF NOT EXISTS provider_env varchar(8),
  ADD COLUMN IF NOT EXISTS provider_account text,
  ADD COLUMN IF NOT EXISTS provider_objects jsonb;
ALTER TABLE public.billing_runs DROP CONSTRAINT IF EXISTS billing_runs_provider_values;
ALTER TABLE public.billing_runs ADD CONSTRAINT billing_runs_provider_values CHECK (
  (provider IS NULL OR provider IN ('polar', 'stripe'))
  AND (provider_env IS NULL OR provider_env IN ('sandbox', 'live'))
  AND (provider_objects IS NULL OR jsonb_typeof(provider_objects) = 'object')
);
UPDATE public.billing_runs
SET provider = 'polar',
    provider_env = CASE polar_env WHEN 'production' THEN 'live' ELSE 'sandbox' END,
    provider_account = polar_org
WHERE provider IS NULL AND polar_env IS NOT NULL;
-- A link run may be named link, which the contract migration makes of every polar one.
ALTER TABLE public.billing_runs DROP CONSTRAINT IF EXISTS billing_runs_kind_check;
ALTER TABLE public.billing_runs ADD CONSTRAINT billing_runs_kind_check CHECK (kind IN ('catalog', 'polar', 'link', 'verify'));
-- A link or verify run names its provider's account, by either set of columns while both exist.
ALTER TABLE public.billing_runs DROP CONSTRAINT IF EXISTS billing_runs_polar;
ALTER TABLE public.billing_runs DROP CONSTRAINT IF EXISTS billing_runs_provider;
ALTER TABLE public.billing_runs ADD CONSTRAINT billing_runs_provider CHECK (
  kind = 'catalog'
  OR num_nulls(provider, provider_env, provider_account) = 0
  OR num_nulls(polar_env, polar_org) = 0
);
COMMENT ON COLUMN public.billing_runs.provider IS 'polar or stripe: the billing provider a link or verify run ran against. Null for a catalog run.';
COMMENT ON COLUMN public.billing_runs.provider_env IS 'sandbox or live: the provider''s environment.';
COMMENT ON COLUMN public.billing_runs.provider_account IS 'The provider''s account: the Polar organization ID or the Stripe account ID.';
COMMENT ON COLUMN public.billing_runs.provider_objects IS 'The provider''s objects a link recorded beyond plans and prices, such as Stripe''s meters; null for Polar.';
COMMENT ON COLUMN public.billing_runs.polar_env IS 'Deprecated: provider_env. Kept equal to it by a trigger until the contract migration drops it.';
COMMENT ON COLUMN public.billing_runs.polar_org IS 'Deprecated: provider_account. Kept equal to it by a trigger until the contract migration drops it.';

-- Prices and plans: the provider's object that sells each, Polar's or Stripe's.
ALTER TABLE public.billing_prices ADD COLUMN IF NOT EXISTS provider_ref text;
UPDATE public.billing_prices SET provider_ref = polar_id WHERE provider_ref IS NULL AND polar_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS billing_prices_provider_ref_unique
  ON public.billing_prices (provider_ref) WHERE provider_ref IS NOT NULL;
COMMENT ON COLUMN public.billing_prices.provider_ref IS 'The provider''s object that sells the price, recorded by a link: a Polar product or a Stripe price. A retired price keeps it so its subscribers still match.';
COMMENT ON COLUMN public.billing_prices.polar_id IS 'Deprecated: provider_ref. Kept equal to it by a trigger until the contract migration drops it.';

ALTER TABLE public.billing_plans ADD COLUMN IF NOT EXISTS provider_disc text;
UPDATE public.billing_plans SET provider_disc = polar_disc WHERE provider_disc IS NULL AND polar_disc IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS billing_plans_provider_disc_unique
  ON public.billing_plans (provider_disc) WHERE provider_disc IS NOT NULL;
COMMENT ON COLUMN public.billing_plans.provider_disc IS 'The provider''s discount for the plan, recorded by a link: a Polar discount or a Stripe coupon.';
COMMENT ON COLUMN public.billing_plans.polar_disc IS 'Deprecated: provider_disc. Kept equal to it by a trigger until the contract migration drops it.';

-- Transactions: the payer's customer at the provider.
ALTER TABLE public.billing_transactions ADD COLUMN IF NOT EXISTS provider_customer_id text;
UPDATE public.billing_transactions SET provider_customer_id = polar_customer_id
WHERE provider_customer_id IS NULL AND polar_customer_id IS NOT NULL;
COMMENT ON COLUMN public.billing_transactions.provider_customer_id IS 'The payer''s customer at the billing provider.';
COMMENT ON COLUMN public.billing_transactions.polar_customer_id IS 'Deprecated: provider_customer_id. Kept equal to it by a trigger until the contract migration drops it.';

-- Accounts: Stripe's second subscription, and a plan's coming end or change.
ALTER TABLE public.billing_accounts
  ADD COLUMN IF NOT EXISTS overage_subscription_id text,
  ADD COLUMN IF NOT EXISTS cancel_at timestamptz,
  ADD COLUMN IF NOT EXISTS next_plan_code varchar(48) REFERENCES public.billing_plans(code),
  ADD COLUMN IF NOT EXISTS next_interval varchar(16),
  ADD COLUMN IF NOT EXISTS next_change_at timestamptz;
ALTER TABLE public.billing_accounts DROP CONSTRAINT IF EXISTS billing_accounts_next_change;
ALTER TABLE public.billing_accounts ADD CONSTRAINT billing_accounts_next_change CHECK (
  (next_interval IS NULL OR next_interval IN ('monthly', 'annual'))
  AND num_nulls(next_plan_code, next_interval, next_change_at) IN (0, 3)
);
CREATE UNIQUE INDEX IF NOT EXISTS billing_accounts_overage_subscription_unique
  ON public.billing_accounts (overage_subscription_id) WHERE overage_subscription_id IS NOT NULL;
-- The default stays until the contract migration: the previous release inserts rows without a source.
ALTER TABLE public.billing_accounts DROP CONSTRAINT IF EXISTS billing_accounts_source_check;
ALTER TABLE public.billing_accounts ADD CONSTRAINT billing_accounts_source_check
  CHECK (source IN ('polar', 'stripe', 'managed')) NOT VALID;
COMMENT ON COLUMN public.billing_accounts.overage_subscription_id IS 'Stripe''s monthly overage subscription, beside the plan''s; null on Polar.';
COMMENT ON COLUMN public.billing_accounts.cancel_at IS 'When the subscription ends unless resumed, as the provider last said; null when it renews.';
COMMENT ON COLUMN public.billing_accounts.next_plan_code IS 'The plan a change waiting for the renewal moves the business to; set with next_interval and next_change_at, or none of them.';
COMMENT ON COLUMN public.billing_accounts.next_interval IS 'monthly or annual: the waiting change''s billing interval.';
COMMENT ON COLUMN public.billing_accounts.next_change_at IS 'When the waiting change takes effect.';

-- Usage: the rate a row was priced at, and when its event last went out.
ALTER TABLE public.billing_usage_events
  ADD COLUMN IF NOT EXISTS rate_cents integer,
  ADD COLUMN IF NOT EXISTS sync_sent_at timestamptz;
ALTER TABLE public.billing_usage_events DROP CONSTRAINT IF EXISTS billing_usage_events_rate_cents_check;
ALTER TABLE public.billing_usage_events ADD CONSTRAINT billing_usage_events_rate_cents_check
  CHECK (rate_cents >= 0) NOT VALID;
COMMENT ON COLUMN public.billing_usage_events.rate_cents IS 'Overage cents per unit of the plan the row counted under, set at its first claim, where the provider meters money (Stripe).';
COMMENT ON COLUMN public.billing_usage_events.sync_sent_at IS 'When the row''s latest event last went to the provider.';

-- Months: what the provider held at the last daily totals check.
ALTER TABLE public.billing_usage_months
  ADD COLUMN IF NOT EXISTS provider_overage_cents numeric(14, 4),
  ADD COLUMN IF NOT EXISTS provider_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS fix_seq integer NOT NULL DEFAULT 0;
COMMENT ON COLUMN public.billing_usage_months.provider_overage_cents IS 'The month''s overage the provider held at the last daily totals check (Stripe).';
COMMENT ON COLUMN public.billing_usage_months.provider_checked_at IS 'When the daily totals check last compared the month.';
COMMENT ON COLUMN public.billing_usage_months.fix_seq IS 'The number of the next correction the totals check sends for the month.';

-- The sweep's read of billing events still waiting, from either billing provider.
-- provider_events also holds Twilio's and Resend's events, so it names them.
CREATE INDEX IF NOT EXISTS provider_events_billing_received_idx
  ON public.provider_events (created_at)
  WHERE status = 'received' AND provider IN ('polar', 'stripe');

-- Sync triggers, dropped by the contract migration: each new column and its
-- Polar twin stay equal whichever release writes the row.
CREATE OR REPLACE FUNCTION app.billing_prices_ref_sync() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.provider_ref := coalesce(NEW.provider_ref, NEW.polar_id);
    NEW.polar_id := coalesce(NEW.polar_id, NEW.provider_ref);
  ELSIF NEW.provider_ref IS DISTINCT FROM OLD.provider_ref THEN
    NEW.polar_id := NEW.provider_ref;
  ELSIF NEW.polar_id IS DISTINCT FROM OLD.polar_id THEN
    NEW.provider_ref := NEW.polar_id;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.billing_prices_ref_sync() FROM PUBLIC;
DROP TRIGGER IF EXISTS billing_prices_ref_sync ON public.billing_prices;
CREATE TRIGGER billing_prices_ref_sync BEFORE INSERT OR UPDATE ON public.billing_prices
  FOR EACH ROW EXECUTE FUNCTION app.billing_prices_ref_sync();

CREATE OR REPLACE FUNCTION app.billing_plans_disc_sync() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.provider_disc := coalesce(NEW.provider_disc, NEW.polar_disc);
    NEW.polar_disc := coalesce(NEW.polar_disc, NEW.provider_disc);
  ELSIF NEW.provider_disc IS DISTINCT FROM OLD.provider_disc THEN
    NEW.polar_disc := NEW.provider_disc;
  ELSIF NEW.polar_disc IS DISTINCT FROM OLD.polar_disc THEN
    NEW.provider_disc := NEW.polar_disc;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.billing_plans_disc_sync() FROM PUBLIC;
DROP TRIGGER IF EXISTS billing_plans_disc_sync ON public.billing_plans;
CREATE TRIGGER billing_plans_disc_sync BEFORE INSERT OR UPDATE ON public.billing_plans
  FOR EACH ROW EXECUTE FUNCTION app.billing_plans_disc_sync();

CREATE OR REPLACE FUNCTION app.billing_transactions_customer_sync() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.provider_customer_id := coalesce(NEW.provider_customer_id, NEW.polar_customer_id);
    NEW.polar_customer_id := coalesce(NEW.polar_customer_id, NEW.provider_customer_id);
  ELSIF NEW.provider_customer_id IS DISTINCT FROM OLD.provider_customer_id THEN
    NEW.polar_customer_id := NEW.provider_customer_id;
  ELSIF NEW.polar_customer_id IS DISTINCT FROM OLD.polar_customer_id THEN
    NEW.provider_customer_id := NEW.polar_customer_id;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.billing_transactions_customer_sync() FROM PUBLIC;
DROP TRIGGER IF EXISTS billing_transactions_customer_sync ON public.billing_transactions;
CREATE TRIGGER billing_transactions_customer_sync BEFORE INSERT OR UPDATE ON public.billing_transactions
  FOR EACH ROW EXECUTE FUNCTION app.billing_transactions_customer_sync();

-- billing_runs fills one set of columns from the other, for Polar only.
CREATE OR REPLACE FUNCTION app.billing_runs_provider_sync() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF NEW.provider IS NULL AND NEW.polar_env IS NOT NULL THEN
    NEW.provider := 'polar';
    NEW.provider_env := CASE NEW.polar_env WHEN 'production' THEN 'live' ELSE 'sandbox' END;
    NEW.provider_account := NEW.polar_org;
  ELSIF NEW.provider = 'polar' AND NEW.polar_env IS NULL THEN
    NEW.polar_env := CASE NEW.provider_env WHEN 'live' THEN 'production' ELSE 'sandbox' END;
    NEW.polar_org := NEW.provider_account;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.billing_runs_provider_sync() FROM PUBLIC;
DROP TRIGGER IF EXISTS billing_runs_provider_sync ON public.billing_runs;
CREATE TRIGGER billing_runs_provider_sync BEFORE INSERT OR UPDATE ON public.billing_runs
  FOR EACH ROW EXECUTE FUNCTION app.billing_runs_provider_sync();

-- The offers view gains the new columns at its end, which CREATE OR REPLACE
-- allows. app.billing_code_offers returns them last: a function's result
-- columns only change by making it again, as in 0134. The previous code reads
-- both by column name, so the added columns change nothing for it.
CREATE OR REPLACE VIEW public.billing_offers WITH (security_invoker = true) AS
SELECT p.code, p.tier, p.access, p.sold, p.custom, p.overage, p.names,
  p.voice_sec, p.sms_seg, p.calls_out, p.chat_units, p.kb_bytes, p.numbers,
  p.voice_rate, p.sms_rate, p.call_rate, p.months, p.ends, p.offer_end,
  p.discount, p.polar_disc, p.sort,
  r.period, r.currency, r.cents, r.per_month, r.polar_id,
  p.receptionists,
  p.provider_disc, r.provider_ref
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
  receptionists smallint,
  provider_disc text, provider_ref text
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

-- The sweep: 0114's function with one line changed in its first branch, so it
-- queues waiting events of either billing provider (was: e.provider = 'polar').
CREATE OR REPLACE FUNCTION app.list_billing_sweep_work(
  p_events_before timestamptz,
  p_usage_before timestamptz,
  p_checkouts_before timestamptz,
  p_checkouts_expired_before timestamptz,
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
      AND e.provider IN ('polar', 'stripe')
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
      AND (
        r.created_at < p_checkouts_expired_before
        OR NOT EXISTS (SELECT 1 FROM public.outbox_messages o WHERE o.dedupe_key = 'billing-sweep:checkout_request:' || r.id::text || ':' || p_hour::text)
      )
      AND session_user = 'lobbystack_worker'
      AND NULLIF(current_setting('app.actor_type', true), '') = 'worker'
    ORDER BY r.updated_at
    LIMIT p_limit
  )
$$;

REVOKE ALL ON FUNCTION app.list_billing_sweep_work(timestamptz, timestamptz, timestamptz, timestamptz, bigint, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.list_billing_sweep_work(timestamptz, timestamptz, timestamptz, timestamptz, bigint, integer) TO lobbystack_worker;
