-- Prepaid minute packs (docs/features/prepaid-packs.md): a business pays once
-- through the deployment's billing provider for a number of voice minutes it
-- may use for a number of days, set per pack in billing.json's packs section.
-- The provider only takes the payment; LobbyStack keeps the minutes, their end
-- date and what each call drew from them. The packs are an additional option:
-- a business that never buys one keeps its plan, its allowances and its bills
-- exactly as they were, and nothing below is backfilled.
--
-- Five tables and a view are new. billing_accounts gains two empty columns,
-- written only when a business switches between a pack and a subscription,
-- and app.business_included_numbers gains a first step for a live pack. No
-- other existing column, constraint or function changes. Undoing this file
-- drops the five tables, the view and the two columns, and restores the
-- function from 0112.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- The packs on sale, from billing.json. Like billing_plans they belong to the
-- whole deployment, only the worker writes them, and they are retired, never
-- deleted. Minutes are stored as seconds, like billing_plans.voice_sec; the
-- monthly allowances and the limits are the ones a business on the pack gets.
CREATE TABLE IF NOT EXISTS public.billing_pack_plans (
  code varchar(48) PRIMARY KEY CHECK (code ~ '^[a-z0-9][a-z0-9_-]{1,46}[a-z0-9]$'),
  status varchar(8) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'retired')),
  names jsonb NOT NULL CHECK (jsonb_typeof(names) = 'object' AND names ?& ARRAY['en', 'fr', 'es', 'sr']),
  voice_sec integer NOT NULL CHECK (voice_sec > 0),
  days smallint CHECK (days BETWEEN 1 AND 1095),
  sms_seg integer NOT NULL CHECK (sms_seg >= 0),
  calls_out integer NOT NULL CHECK (calls_out >= 0),
  chat_units integer NOT NULL CHECK (chat_units >= 0),
  kb_bytes bigint NOT NULL CHECK (kb_bytes >= 0),
  numbers smallint NOT NULL CHECK (numbers BETWEEN 0 AND 1),
  receptionists smallint NOT NULL CHECK (receptionists BETWEEN 1 AND 50),
  terms_hash char(64) NOT NULL CHECK (terms_hash ~ '^[0-9a-f]{64}$'),
  frozen_at timestamptz,
  sort smallint NOT NULL DEFAULT 100,
  run_id uuid REFERENCES public.billing_runs(id),
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_pack_plans_retired CHECK ((status = 'retired') = (retired_at IS NOT NULL))
);

-- Each pack's price. One live price per pack, so every live price is in the
-- file's one currency; a retired price keeps its provider reference, so a
-- payment made at that price still finds its pack.
CREATE TABLE IF NOT EXISTS public.billing_pack_prices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pack varchar(48) NOT NULL REFERENCES public.billing_pack_plans(code),
  currency char(3) NOT NULL CHECK (currency ~ '^[a-z]{3}$'),
  cents integer NOT NULL CHECK (cents > 0),
  provider_ref text,
  run_id uuid REFERENCES public.billing_runs(id),
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS billing_pack_prices_live_unique
  ON public.billing_pack_prices (pack) WHERE retired_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS billing_pack_prices_provider_ref_unique
  ON public.billing_pack_prices (provider_ref) WHERE provider_ref IS NOT NULL;

-- Each pack checkout a business starts. The app creates the row and the
-- worker fills in the provider's session, as with billing_checkout_requests,
-- which stays as it is. A row is open until it is paid, fails or expires.
CREATE TABLE IF NOT EXISTS public.billing_pack_checkouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  requested_by_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  pack varchar(48) NOT NULL REFERENCES public.billing_pack_plans(code),
  price_id uuid NOT NULL REFERENCES public.billing_pack_prices(id),
  status varchar(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'ready', 'paid', 'failed', 'expired')),
  checkout_id text,
  checkout_url text,
  error text,
  billing_email varchar(320),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_pack_checkouts_ready CHECK (status <> 'ready' OR num_nulls(checkout_id, checkout_url) = 0)
);

CREATE INDEX IF NOT EXISTS billing_pack_checkouts_business_idx
  ON public.billing_pack_checkouts (business_id, status, created_at);

-- The ledger: one row per pack bought. Everything a business gets from the
-- pack is copied onto its row at purchase, so a later change to the catalog
-- never changes a pack already bought, and the end date is fixed then: the
-- payment time plus the pack's days, counted as 24-hour days. Calls add to
-- seconds_used through billing_pack_draws; refunds, disputes and the expiry
-- job change the status. Rows are never deleted but with their business.
CREATE TABLE IF NOT EXISTS public.billing_packs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  pack varchar(48) NOT NULL REFERENCES public.billing_pack_plans(code),
  price_id uuid REFERENCES public.billing_pack_prices(id),
  days smallint CHECK (days BETWEEN 1 AND 1095),
  provider varchar(8) NOT NULL CHECK (provider IN ('polar', 'stripe')),
  provider_ref text NOT NULL,
  transaction_id uuid REFERENCES public.billing_transactions(id) ON DELETE SET NULL,
  amount_cents integer NOT NULL CHECK (amount_cents >= 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[a-z]{3}$'),
  seconds_total integer NOT NULL CHECK (seconds_total > 0),
  seconds_used integer NOT NULL DEFAULT 0 CHECK (seconds_used >= 0),
  sms_seg integer NOT NULL CHECK (sms_seg >= 0),
  calls_out integer NOT NULL CHECK (calls_out >= 0),
  chat_units integer NOT NULL CHECK (chat_units >= 0),
  kb_bytes bigint NOT NULL CHECK (kb_bytes >= 0),
  numbers smallint NOT NULL CHECK (numbers BETWEEN 0 AND 1),
  receptionists smallint NOT NULL CHECK (receptionists BETWEEN 1 AND 50),
  paid_at timestamptz NOT NULL,
  ends_at timestamptz,
  status varchar(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'replaced', 'refunded', 'frozen')),
  refunded_cents integer NOT NULL DEFAULT 0 CHECK (refunded_cents >= 0),
  ended_at timestamptz,
  unused_seconds integer CHECK (unused_seconds >= 0),
  notices text[] NOT NULL DEFAULT '{}' CHECK (notices <@ ARRAY['low', 'empty', 'ends_30', 'ends_7', 'ended']::text[]),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_packs_used CHECK (seconds_used <= seconds_total),
  CONSTRAINT billing_packs_ends CHECK ((days IS NULL) = (ends_at IS NULL)),
  -- A pack has ended exactly when it is expired, replaced or refunded; a frozen one may still come back.
  CONSTRAINT billing_packs_ended CHECK ((status IN ('expired', 'replaced', 'refunded')) = (ended_at IS NOT NULL)),
  CONSTRAINT billing_packs_unused CHECK ((ended_at IS NULL) = (unused_seconds IS NULL))
);

-- One pack per payment, so an event delivered twice adds nothing.
CREATE UNIQUE INDEX IF NOT EXISTS billing_packs_provider_ref_unique
  ON public.billing_packs (provider, provider_ref);
-- Every pack of a business, newest first: its pack list, the daily job's check
-- that it has any, and the delete that cascades from businesses.
CREATE INDEX IF NOT EXISTS billing_packs_business_idx
  ON public.billing_packs (business_id, paid_at DESC);
-- A business's live packs, earliest end first, for reservations and the plan in force.
CREATE INDEX IF NOT EXISTS billing_packs_live_idx
  ON public.billing_packs (business_id, ends_at) WHERE status = 'active';
-- Packs whose end has come, for the daily expiry job.
CREATE INDEX IF NOT EXISTS billing_packs_ending_idx
  ON public.billing_packs (ends_at) WHERE status IN ('active', 'frozen') AND ends_at IS NOT NULL;

-- Which pack paid for each call: the call's usage key and the seconds it took
-- from the pack. A reservation that grows or shrinks updates its own rows, in
-- the same transaction as the call's usage row. There is no foreign key into
-- billing_usage_events, so that table's rules stay as they are.
CREATE TABLE IF NOT EXISTS public.billing_pack_draws (
  pack_id uuid NOT NULL REFERENCES public.billing_packs(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  source_key varchar(255) NOT NULL,
  seconds integer NOT NULL CHECK (seconds >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pack_id, source_key)
);

CREATE INDEX IF NOT EXISTS billing_pack_draws_source_idx
  ON public.billing_pack_draws (business_id, source_key);

-- The packs on sale now, each with its live price. security_invoker makes the
-- view read with the caller's own row-level security, as billing_offers does.
CREATE OR REPLACE VIEW public.billing_pack_offers WITH (security_invoker = true) AS
SELECT p.code, p.names, p.voice_sec, p.days, p.sms_seg, p.calls_out, p.chat_units,
  p.kb_bytes, p.numbers, p.receptionists, p.sort,
  r.id AS price_id, r.currency, r.cents, r.provider_ref
FROM public.billing_pack_plans p
JOIN public.billing_pack_prices r ON r.pack = p.code AND r.retired_at IS NULL
WHERE p.status = 'active';

-- Decision 6: a business moves between a pack and a subscription. Both
-- columns stay empty for every business that never does.
ALTER TABLE public.billing_accounts
  ADD COLUMN IF NOT EXISTS allowances_since timestamptz,
  ADD COLUMN IF NOT EXISTS replaced_subscription_id text;

COMMENT ON TABLE public.billing_pack_plans IS 'Every prepaid pack of billing.json''s packs section.';
COMMENT ON COLUMN public.billing_pack_plans.code IS 'Permanent pack code, its key in billing.json.';
COMMENT ON COLUMN public.billing_pack_plans.status IS 'draft (not sellable yet), active, or retired (no one new may buy it).';
COMMENT ON COLUMN public.billing_pack_plans.names IS 'Display names by language (en, fr, es, sr).';
COMMENT ON COLUMN public.billing_pack_plans.voice_sec IS 'Voice seconds the pack holds for its whole length.';
COMMENT ON COLUMN public.billing_pack_plans.days IS 'How long the pack lasts from its payment, in 24-hour days; null means it never ends.';
COMMENT ON COLUMN public.billing_pack_plans.sms_seg IS 'Alert SMS segments included a month while the pack lasts.';
COMMENT ON COLUMN public.billing_pack_plans.calls_out IS 'Outbound call attempts (transfers) included a month.';
COMMENT ON COLUMN public.billing_pack_plans.chat_units IS 'Website chat AI units included a month.';
COMMENT ON COLUMN public.billing_pack_plans.kb_bytes IS 'Knowledge storage limit in bytes.';
COMMENT ON COLUMN public.billing_pack_plans.numbers IS 'Business phone numbers included.';
COMMENT ON COLUMN public.billing_pack_plans.receptionists IS 'Receptionists included, the default one too.';
COMMENT ON COLUMN public.billing_pack_plans.terms_hash IS 'SHA-256 of the minutes, length, allowances, limits and price.';
COMMENT ON COLUMN public.billing_pack_plans.frozen_at IS 'When the first business bought it; its minutes and length are fixed from then.';
COMMENT ON COLUMN public.billing_pack_plans.sort IS 'Order on pack lists.';
COMMENT ON COLUMN public.billing_pack_plans.run_id IS 'The run that last changed the row.';
COMMENT ON COLUMN public.billing_pack_plans.retired_at IS 'When the pack was retired; set exactly when status is retired.';

COMMENT ON TABLE public.billing_pack_prices IS 'One live row per pack; retired rows are kept.';
COMMENT ON COLUMN public.billing_pack_prices.pack IS 'The pack code.';
COMMENT ON COLUMN public.billing_pack_prices.currency IS 'Three lowercase letters, from the file.';
COMMENT ON COLUMN public.billing_pack_prices.cents IS 'The one-time price.';
COMMENT ON COLUMN public.billing_pack_prices.provider_ref IS 'The provider''s object that sells it, recorded by a link: a Polar product or a Stripe price.';
COMMENT ON COLUMN public.billing_pack_prices.run_id IS 'The run that last changed the row.';
COMMENT ON COLUMN public.billing_pack_prices.retired_at IS 'When this price stopped being sold.';

COMMENT ON TABLE public.billing_pack_checkouts IS 'Pack checkouts businesses started; the worker fills in the provider''s session.';
COMMENT ON COLUMN public.billing_pack_checkouts.status IS 'pending, processing, ready (the link works), paid, failed or expired.';
COMMENT ON COLUMN public.billing_pack_checkouts.checkout_id IS 'The provider''s checkout: a Stripe Checkout Session or a Polar checkout.';
COMMENT ON COLUMN public.billing_pack_checkouts.checkout_url IS 'Where the business pays.';
COMMENT ON COLUMN public.billing_pack_checkouts.billing_email IS 'The email a new provider customer gets instead of the requester''s.';
COMMENT ON COLUMN public.billing_pack_checkouts.expires_at IS 'When the checkout stops being open, whatever its status.';

COMMENT ON TABLE public.billing_packs IS 'The prepaid pack ledger: one row per pack bought.';
COMMENT ON COLUMN public.billing_packs.pack IS 'The pack bought, from the catalog.';
COMMENT ON COLUMN public.billing_packs.price_id IS 'The price it was bought at.';
COMMENT ON COLUMN public.billing_packs.days IS 'The pack''s length in days, copied at purchase; null for a pack that never ends.';
COMMENT ON COLUMN public.billing_packs.provider IS 'polar or stripe.';
COMMENT ON COLUMN public.billing_packs.provider_ref IS 'The payment: a Stripe PaymentIntent or a Polar order.';
COMMENT ON COLUMN public.billing_packs.transaction_id IS 'The payment''s row in billing_transactions.';
COMMENT ON COLUMN public.billing_packs.amount_cents IS 'What was paid, in currency.';
COMMENT ON COLUMN public.billing_packs.seconds_total IS 'Voice seconds bought.';
COMMENT ON COLUMN public.billing_packs.seconds_used IS 'Voice seconds calls have drawn; never more than bought.';
COMMENT ON COLUMN public.billing_packs.paid_at IS 'When the payment cleared.';
COMMENT ON COLUMN public.billing_packs.ends_at IS 'paid_at plus days times 24 hours, fixed at purchase; null means never.';
COMMENT ON COLUMN public.billing_packs.status IS 'active, expired, replaced (a subscription started), refunded or frozen (a dispute).';
COMMENT ON COLUMN public.billing_packs.refunded_cents IS 'Refunds so far, from the provider''s events; a partial refund takes its share of the seconds off the pack.';
COMMENT ON COLUMN public.billing_packs.ended_at IS 'When it ended.';
COMMENT ON COLUMN public.billing_packs.unused_seconds IS 'The seconds left when it ended, for the accounts.';
COMMENT ON COLUMN public.billing_packs.notices IS 'What the daily expiry job already did about the pack: the reminder emails it sent, low (a fifth of the balance left), empty, ends_30 and ends_7 (days before its end), and ended once it settled the pack''s end. The outbox forgets a sent message after 14 days; this does not.';

COMMENT ON TABLE public.billing_pack_draws IS 'Which pack paid for each call, by the call''s usage key.';
COMMENT ON COLUMN public.billing_pack_draws.source_key IS 'The usage row''s source_key, such as voice:<call id>.';
COMMENT ON COLUMN public.billing_pack_draws.seconds IS 'Seconds the call took from the pack.';

COMMENT ON VIEW public.billing_pack_offers IS 'Packs on sale now, with their live prices. Reads with the caller''s row-level security.';

COMMENT ON COLUMN public.billing_accounts.allowances_since IS 'Where this month''s allowances start counting, set only when the business switches between a pack and a subscription; null means the whole month.';
COMMENT ON COLUMN public.billing_accounts.replaced_subscription_id IS 'The subscription a pack replaced, which LobbyStack treats as ended while the provider confirms it; null for every other business.';

-- The pack catalog, as the plan catalog of 0108: only the worker writes it,
-- as the v1 API's worker actor; everyone may read it, since every pack is on
-- public sale; no role may delete it.
DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['billing_pack_plans', 'billing_pack_prices'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS %I_read_all ON public.%I', table_name, table_name);
    EXECUTE format('DROP POLICY IF EXISTS %I_worker_insert ON public.%I', table_name, table_name);
    EXECUTE format('DROP POLICY IF EXISTS %I_worker_update ON public.%I', table_name, table_name);
    EXECUTE format('CREATE POLICY %I_read_all ON public.%I FOR SELECT TO lobbystack_app, lobbystack_worker, lobbystack_readonly USING (true)', table_name, table_name);
    EXECUTE format('CREATE POLICY %I_worker_insert ON public.%I FOR INSERT TO lobbystack_worker WITH CHECK (app.current_actor_type() = ''worker'')', table_name, table_name);
    EXECUTE format('CREATE POLICY %I_worker_update ON public.%I FOR UPDATE TO lobbystack_worker USING (app.current_actor_type() = ''worker'') WITH CHECK (app.current_actor_type() = ''worker'')', table_name, table_name);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC', table_name);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON public.%I TO lobbystack_worker', table_name);
    EXECUTE format('GRANT SELECT ON public.%I TO lobbystack_app, lobbystack_readonly', table_name);
  END LOOP;
END
$$;

-- The view adds no access of its own: it reads with each caller's policies (security_invoker).
REVOKE ALL ON public.billing_pack_offers FROM PUBLIC;
GRANT SELECT ON public.billing_pack_offers TO lobbystack_app, lobbystack_worker, lobbystack_readonly;

-- A business's pack checkouts, as its billing_checkout_requests (0013).
ALTER TABLE public.billing_pack_checkouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_pack_checkouts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS billing_pack_checkouts_tenant_isolation ON public.billing_pack_checkouts;
CREATE POLICY billing_pack_checkouts_tenant_isolation ON public.billing_pack_checkouts
  USING (business_id = app.current_business_id() AND (app.current_actor_type() IN ('worker', 'dispatcher') OR app.has_business_membership(business_id)))
  WITH CHECK (business_id = app.current_business_id() AND (app.current_actor_type() IN ('worker', 'dispatcher') OR app.has_business_membership(business_id)));
REVOKE ALL ON public.billing_pack_checkouts FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON public.billing_pack_checkouts TO lobbystack_app, lobbystack_worker;
GRANT SELECT ON public.billing_pack_checkouts TO lobbystack_readonly;

-- A business's packs and draws, with billing_usage_months' policy (0030):
-- the app and the worker both reserve minutes for calls. The policy names no
-- role, so app.business_included_numbers, which the number claims run as
-- their owner, reads a business's packs under it too. Only the worker adds a
-- pack; nobody deletes one but with its business.
DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['billing_packs', 'billing_pack_draws'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS %I_tenant_isolation ON public.%I', table_name, table_name);
    EXECUTE format('CREATE POLICY %I_tenant_isolation ON public.%I USING (business_id = app.current_business_id() AND (app.current_actor_type() IN (''system'', ''worker'', ''dispatcher'') OR app.has_business_membership(business_id))) WITH CHECK (business_id = app.current_business_id() AND (app.current_actor_type() IN (''system'', ''worker'', ''dispatcher'') OR app.has_business_membership(business_id)))', table_name, table_name);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC', table_name);
    EXECUTE format('GRANT SELECT ON public.%I TO lobbystack_readonly', table_name);
  END LOOP;
END
$$;
GRANT SELECT, UPDATE ON public.billing_packs TO lobbystack_app;
GRANT SELECT, INSERT, UPDATE ON public.billing_packs TO lobbystack_worker;
GRANT SELECT, INSERT, UPDATE ON public.billing_pack_draws TO lobbystack_app, lobbystack_worker;

-- 0112's function with one new first step: while the business has a live
-- pack and no live subscription that the pack didn't replace, it returns the
-- number limit copied onto the pack, and a subscription a pack replaced counts
-- as ended while the provider confirms it. A business without a live pack or
-- a replaced subscription gets exactly what 0112 gave it.
CREATE OR REPLACE FUNCTION app.business_included_numbers(target_business_id uuid)
RETURNS integer LANGUAGE plpgsql STABLE SET search_path = public, pg_catalog AS $$
DECLARE account_plan text; account_code text; account_state text; account_subscription text; replaced_subscription text; plan_tier text; included integer;
BEGIN
  SELECT plan, plan_code, subscription_state, subscription_id, replaced_subscription_id INTO account_plan, account_code, account_state, account_subscription, replaced_subscription FROM public.billing_accounts WHERE business_id = target_business_id;
  IF replaced_subscription IS NOT NULL AND replaced_subscription = account_subscription THEN
    account_state := 'replaced';
  END IF;
  IF NOT (account_plan IN ('self_host','starter','pro','enterprise') AND COALESCE(account_state,'') IN ('active','trialing','past_due')) THEN
    SELECT max(numbers) INTO included FROM public.billing_packs WHERE business_id = target_business_id AND status = 'active' AND (ends_at IS NULL OR ends_at > now());
    IF included IS NOT NULL THEN RETURN included; END IF;
  END IF;
  plan_tier := CASE WHEN account_plan = 'free_cloud' OR (account_plan IN ('self_host','starter','pro','enterprise') AND COALESCE(account_state,'') IN ('active','trialing','past_due')) THEN account_plan ELSE 'free_cloud' END;
  IF EXISTS (SELECT 1 FROM public.billing_plans WHERE code IN ('starter','pro') AND tier = code) THEN
    IF account_code IS NOT NULL AND account_code <> plan_tier AND account_plan = plan_tier AND COALESCE(account_state,'') IN ('active','trialing','past_due') THEN
      SELECT numbers INTO included FROM public.billing_plans WHERE code = account_code AND tier = plan_tier AND NOT custom;
      IF FOUND THEN RETURN included; END IF;
    END IF;
    SELECT numbers INTO included FROM public.billing_plans WHERE code = plan_tier AND tier = code;
    IF FOUND THEN RETURN included; END IF;
  END IF;
  RETURN CASE plan_tier WHEN 'free_cloud' THEN 0 WHEN 'starter' THEN 1 WHEN 'pro' THEN 1 ELSE NULL END;
END $$;
REVOKE ALL ON FUNCTION app.business_included_numbers(uuid) FROM PUBLIC;
