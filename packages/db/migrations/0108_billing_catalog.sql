-- Billing catalog: every plan in brands/<brand>/billing.json, standard or not,
-- its prices, and the runs that wrote them. One table holds every kind of plan;
-- tier, access, sold and custom say how each behaves. The tables belong to the
-- whole deployment, so they have no business_id. Nothing reads them yet:
-- checkout and limits still read billingPlanCatalog and POLAR_*_PRODUCT_ID.
-- Rows are retired, never deleted, so no role may delete them.

CREATE TABLE IF NOT EXISTS public.billing_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind varchar(8) NOT NULL CHECK (kind IN ('catalog', 'polar', 'verify')),
  status varchar(10) NOT NULL CHECK (status IN ('applied', 'unchanged', 'failed', 'passed', 'drift')),
  brand varchar(64) NOT NULL,
  ver smallint NOT NULL CHECK (ver >= 1),
  hash char(64) NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$'),
  prev_hash char(64) CHECK (prev_hash ~ '^[0-9a-f]{64}$'),
  code_hash char(64) CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  profile jsonb NOT NULL CHECK (jsonb_typeof(profile) = 'object'),
  changes jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(changes) = 'array'),
  problems jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(problems) = 'array'),
  polar_env varchar(10) CHECK (polar_env IN ('sandbox', 'production')),
  polar_org text,
  key_id uuid,
  partner varchar(40),
  idem_key varchar(255),
  req_hash char(64),
  started_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now())
    CHECK (started_at = date_trunc('milliseconds', started_at)),
  ended_at timestamptz,
  CONSTRAINT billing_runs_catalog_status CHECK (kind <> 'catalog' OR status IN ('applied', 'unchanged')),
  -- Every run but a scheduled verify was asked for by an operator key, with an Idempotency-Key.
  CONSTRAINT billing_runs_asked CHECK (kind = 'verify' OR num_nulls(key_id, partner, idem_key, req_hash) = 0),
  CONSTRAINT billing_runs_polar CHECK (kind = 'catalog' OR num_nulls(polar_env, polar_org) = 0)
);

-- One run per operator key and Idempotency-Key, whatever its kind: req_hash covers the operation.
CREATE UNIQUE INDEX IF NOT EXISTS billing_runs_idem_unique
  ON public.billing_runs (key_id, idem_key) WHERE idem_key IS NOT NULL;
-- Newest runs first, of one kind or of every kind. The API's cursor is (started_at, id).
CREATE INDEX IF NOT EXISTS billing_runs_kind_idx
  ON public.billing_runs (kind, started_at, id);
CREATE INDEX IF NOT EXISTS billing_runs_started_idx
  ON public.billing_runs (started_at, id);

CREATE TABLE IF NOT EXISTS public.billing_plans (
  code varchar(48) PRIMARY KEY CHECK (code ~ '^[a-z0-9][a-z0-9_-]{1,46}[a-z0-9]$'),
  tier varchar(16) NOT NULL CHECK (tier IN ('free_cloud', 'starter', 'pro', 'enterprise')),
  status varchar(8) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'retired')),
  access varchar(8) NOT NULL DEFAULT 'public' CHECK (access IN ('public', 'code', 'hidden')),
  sold boolean NOT NULL DEFAULT false,
  custom boolean NOT NULL DEFAULT false,
  overage boolean NOT NULL DEFAULT false,
  src varchar(8) NOT NULL DEFAULT 'file' CHECK (src IN ('file', 'api')),
  names jsonb CHECK (names IS NULL OR (jsonb_typeof(names) = 'object' AND names ?& ARRAY['en', 'fr', 'es', 'sr'])),
  voice_sec integer CHECK (voice_sec >= 0),
  sms_seg integer CHECK (sms_seg >= 0),
  calls_out integer CHECK (calls_out >= 0),
  chat_units integer CHECK (chat_units >= 0),
  kb_bytes bigint CHECK (kb_bytes >= 0),
  numbers smallint CHECK (numbers >= 0),
  voice_rate integer CHECK (voice_rate >= 0),
  sms_rate integer CHECK (sms_rate >= 0),
  call_rate integer CHECK (call_rate >= 0),
  months smallint CHECK (months BETWEEN 1 AND 36),
  ends varchar(8) CHECK (ends IN ('tier', 'keep', 'cancel')),
  offer_end timestamptz,
  discount jsonb CHECK (discount IS NULL OR jsonb_typeof(discount) = 'object'),
  polar_disc text,
  terms_hash char(64) NOT NULL CHECK (terms_hash ~ '^[0-9a-f]{64}$'),
  frozen_at timestamptz,
  sort smallint NOT NULL DEFAULT 100,
  run_id uuid REFERENCES public.billing_runs(id),
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- The four standard plans are the rows whose code is their tier. Translations
  -- name them, and the promo fields belong to the other plans.
  CONSTRAINT billing_plans_standard CHECK (
    (code = tier AND names IS NULL AND access <> 'code'
      AND num_nulls(months, offer_end, discount, frozen_at) = 4)
    OR (code NOT IN ('free_cloud', 'starter', 'pro', 'enterprise') AND names IS NOT NULL)
  ),
  -- A custom plan is priced by hand: never sold, no allowances. Any other plan has all six.
  CONSTRAINT billing_plans_custom CHECK (
    NOT (custom AND sold)
    AND num_nulls(voice_sec, sms_seg, calls_out, chat_units, kb_bytes, numbers) = CASE WHEN custom THEN 6 ELSE 0 END
  ),
  -- Overage rates exist exactly when overage is billed at fixed rates.
  CONSTRAINT billing_plans_rates CHECK (
    num_nulls(voice_rate, sms_rate, call_rate) = CASE WHEN overage AND NOT custom THEN 0 ELSE 3 END
  ),
  CONSTRAINT billing_plans_ends CHECK ((months IS NULL) = (ends IS NULL)),
  CONSTRAINT billing_plans_retired CHECK ((status = 'retired') = (retired_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS billing_plans_polar_disc_unique
  ON public.billing_plans (polar_disc) WHERE polar_disc IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.billing_prices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan varchar(48) NOT NULL REFERENCES public.billing_plans(code),
  period varchar(8) NOT NULL CHECK (period IN ('monthly', 'annual')),
  currency char(3) NOT NULL CHECK (currency ~ '^[a-z]{3}$'),
  cents integer NOT NULL CHECK (cents > 0),
  per_month integer GENERATED ALWAYS AS (CASE WHEN period = 'annual' THEN cents / 12 ELSE cents END) STORED,
  polar_id text,
  run_id uuid REFERENCES public.billing_runs(id),
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One live price per plan and period, so every live price is in the file's one currency;
-- retired rows stay as history. A currency change retires the old rows before it inserts.
CREATE UNIQUE INDEX IF NOT EXISTS billing_prices_live_unique
  ON public.billing_prices (plan, period) WHERE retired_at IS NULL;
-- One row per Polar product, across every kind of plan.
CREATE UNIQUE INDEX IF NOT EXISTS billing_prices_polar_unique
  ON public.billing_prices (polar_id) WHERE polar_id IS NOT NULL;

-- The plans on offer now: active, offer not ended, each with its live prices (none for
-- an unsold plan). security_invoker makes the view read with the caller's own row-level
-- security, so the app sees public offers only. Without it the view would read as its
-- owner and, since the tables force row-level security, return nothing.
CREATE OR REPLACE VIEW public.billing_offers WITH (security_invoker = true) AS
SELECT p.code, p.tier, p.access, p.sold, p.custom, p.overage, p.names,
  p.voice_sec, p.sms_seg, p.calls_out, p.chat_units, p.kb_bytes, p.numbers,
  p.voice_rate, p.sms_rate, p.call_rate, p.months, p.ends, p.offer_end,
  p.discount, p.polar_disc, p.sort,
  r.period, r.currency, r.cents, r.per_month, r.polar_id
FROM public.billing_plans p
LEFT JOIN public.billing_prices r ON r.plan = p.code AND r.retired_at IS NULL
WHERE p.status = 'active' AND (p.offer_end IS NULL OR p.offer_end > now());

-- What each short name means, so \d+ in psql explains it.
COMMENT ON TABLE public.billing_plans IS 'Every plan of billing.json, standard or not. Standard plans are the rows whose code is their tier.';
COMMENT ON COLUMN public.billing_plans.code IS 'Permanent plan code, its key in billing.json.';
COMMENT ON COLUMN public.billing_plans.tier IS 'Built-in tier the code treats the plan as: free_cloud, starter, pro or enterprise.';
COMMENT ON COLUMN public.billing_plans.status IS 'draft (not sellable yet), active, or retired (no one new may take it).';
COMMENT ON COLUMN public.billing_plans.access IS 'Who can get it: public, code (promo code only) or hidden (operator only).';
COMMENT ON COLUMN public.billing_plans.sold IS 'Polar sells it; it has prices.';
COMMENT ON COLUMN public.billing_plans.custom IS 'Priced by hand outside Polar, with no fixed allowances.';
COMMENT ON COLUMN public.billing_plans.overage IS 'Usage past the allowance is billed rather than blocked.';
COMMENT ON COLUMN public.billing_plans.src IS 'Where the plan is defined: file (billing.json) or api.';
COMMENT ON COLUMN public.billing_plans.names IS 'Display names by language (en, fr, es, sr); null for standard plans.';
COMMENT ON COLUMN public.billing_plans.voice_sec IS 'Voice seconds included a month.';
COMMENT ON COLUMN public.billing_plans.sms_seg IS 'Alert SMS segments included a month.';
COMMENT ON COLUMN public.billing_plans.calls_out IS 'Outbound call attempts (transfers) included a month.';
COMMENT ON COLUMN public.billing_plans.chat_units IS 'Website chat AI units included a month.';
COMMENT ON COLUMN public.billing_plans.kb_bytes IS 'Knowledge storage limit in bytes.';
COMMENT ON COLUMN public.billing_plans.numbers IS 'Business phone numbers included.';
COMMENT ON COLUMN public.billing_plans.voice_rate IS 'Overage cents per voice minute.';
COMMENT ON COLUMN public.billing_plans.sms_rate IS 'Overage cents per alert SMS segment.';
COMMENT ON COLUMN public.billing_plans.call_rate IS 'Overage cents per outbound call attempt.';
COMMENT ON COLUMN public.billing_plans.months IS 'Months the plan lasts from the first charge; null means no end.';
COMMENT ON COLUMN public.billing_plans.ends IS 'After months: tier (back to the tier plan), keep or cancel.';
COMMENT ON COLUMN public.billing_plans.offer_end IS 'No new subscription after this moment.';
COMMENT ON COLUMN public.billing_plans.discount IS 'Code-less Polar discount applied at checkout.';
COMMENT ON COLUMN public.billing_plans.polar_disc IS 'Polar ID of that discount.';
COMMENT ON COLUMN public.billing_plans.terms_hash IS 'SHA-256 of the terms subscribers and Polar depend on.';
COMMENT ON COLUMN public.billing_plans.frozen_at IS 'When the first business took it; its terms are fixed from then.';
COMMENT ON COLUMN public.billing_plans.sort IS 'Order on plan cards and lists.';
COMMENT ON COLUMN public.billing_plans.run_id IS 'The run that last changed the row.';
COMMENT ON COLUMN public.billing_plans.retired_at IS 'When the plan was retired.';

COMMENT ON TABLE public.billing_prices IS 'One live row per plan and period; retired rows are kept.';
COMMENT ON COLUMN public.billing_prices.plan IS 'The plan code.';
COMMENT ON COLUMN public.billing_prices.period IS 'monthly or annual.';
COMMENT ON COLUMN public.billing_prices.currency IS 'Three lowercase letters.';
COMMENT ON COLUMN public.billing_prices.cents IS 'Price for one period.';
COMMENT ON COLUMN public.billing_prices.per_month IS 'Price per month, computed: cents, or cents / 12 for annual.';
COMMENT ON COLUMN public.billing_prices.polar_id IS 'The Polar product that sells it.';
COMMENT ON COLUMN public.billing_prices.run_id IS 'The run that last changed the row.';
COMMENT ON COLUMN public.billing_prices.retired_at IS 'When this price stopped being sold.';

COMMENT ON TABLE public.billing_runs IS 'Catalog applies, and later Polar runs and verifies.';
COMMENT ON COLUMN public.billing_runs.kind IS 'catalog, polar or verify.';
COMMENT ON COLUMN public.billing_runs.status IS 'applied or unchanged; failed, passed or drift for later kinds.';
COMMENT ON COLUMN public.billing_runs.brand IS 'The brand whose file it was.';
COMMENT ON COLUMN public.billing_runs.ver IS 'The file''s version.';
COMMENT ON COLUMN public.billing_runs.hash IS 'SHA-256 of the normalized file.';
COMMENT ON COLUMN public.billing_runs.prev_hash IS 'The previous catalog run''s hash.';
COMMENT ON COLUMN public.billing_runs.code_hash IS 'The file hash built into the code that ran it.';
COMMENT ON COLUMN public.billing_runs.profile IS 'The normalized file.';
COMMENT ON COLUMN public.billing_runs.changes IS 'One entry per row written.';
COMMENT ON COLUMN public.billing_runs.problems IS 'Drift found by a verify.';
COMMENT ON COLUMN public.billing_runs.polar_env IS 'sandbox or production.';
COMMENT ON COLUMN public.billing_runs.polar_org IS 'The Polar organization ID.';
COMMENT ON COLUMN public.billing_runs.key_id IS 'The operator platform key that asked.';
COMMENT ON COLUMN public.billing_runs.partner IS 'That key''s partner.';
COMMENT ON COLUMN public.billing_runs.idem_key IS 'The request''s Idempotency-Key.';
COMMENT ON COLUMN public.billing_runs.req_hash IS 'SHA-256 of the request body.';
COMMENT ON COLUMN public.billing_runs.started_at IS 'When the run started, to the millisecond, as the API cursor carries it.';
COMMENT ON COLUMN public.billing_runs.ended_at IS 'When the run finished.';

COMMENT ON VIEW public.billing_offers IS 'Plans on offer now: active, offer not ended, with their live prices. Reads with the caller''s row-level security.';

-- Only the worker writes, as the v1 API's worker actor, as platform_partner_businesses
-- does (0092). The app may read public plans and their prices, for the plan cards a
-- later PR moves onto these tables; the promo PRs add a policy for a business's own
-- plan. Runs are read only by the worker and the read-only role.
DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['billing_runs', 'billing_plans', 'billing_prices'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS %I_read_all ON public.%I', table_name, table_name);
    EXECUTE format('DROP POLICY IF EXISTS %I_read_public ON public.%I', table_name, table_name);
    EXECUTE format('DROP POLICY IF EXISTS %I_worker_insert ON public.%I', table_name, table_name);
    EXECUTE format('DROP POLICY IF EXISTS %I_worker_update ON public.%I', table_name, table_name);
    EXECUTE format('CREATE POLICY %I_read_all ON public.%I FOR SELECT TO lobbystack_worker, lobbystack_readonly USING (true)', table_name, table_name);
    EXECUTE format('CREATE POLICY %I_worker_insert ON public.%I FOR INSERT TO lobbystack_worker WITH CHECK (app.current_actor_type() = ''worker'')', table_name, table_name);
    EXECUTE format('CREATE POLICY %I_worker_update ON public.%I FOR UPDATE TO lobbystack_worker USING (app.current_actor_type() = ''worker'') WITH CHECK (app.current_actor_type() = ''worker'')', table_name, table_name);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC', table_name);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON public.%I TO lobbystack_worker', table_name);
    EXECUTE format('GRANT SELECT ON public.%I TO lobbystack_readonly', table_name);
  END LOOP;
END
$$;

CREATE POLICY billing_plans_read_public ON public.billing_plans FOR SELECT
  TO lobbystack_app USING (access = 'public');
CREATE POLICY billing_prices_read_public ON public.billing_prices FOR SELECT
  TO lobbystack_app USING (EXISTS (
    SELECT 1 FROM public.billing_plans p WHERE p.code = billing_prices.plan AND p.access = 'public'
  ));
GRANT SELECT ON public.billing_plans, public.billing_prices TO lobbystack_app;

-- The view adds no access of its own: it reads with each caller's policies (security_invoker).
REVOKE ALL ON public.billing_offers FROM PUBLIC;
GRANT SELECT ON public.billing_offers TO lobbystack_app, lobbystack_worker, lobbystack_readonly;
