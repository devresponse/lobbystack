-- Promo codes: an operator's platform key issues a code for a plan whose access
-- is code, and a business that enters it buys that plan through Polar with the
-- plan's discount. A code is shared (no business_id, so it needs a use limit
-- and an end) or bound to one business. Codes live only here, never in the
-- public repository.
--
-- A business has one plan at a time, so its billing account is the grant:
-- plan_code names the exact plan when it isn't the standard plan of its tier
-- (plan stays the tier), plan_ends when a time-limited plan ends, and code_id
-- the code it redeemed. A checkout request carries the plan and code it sells,
-- so Polar's webhook knows which code a subscription came from.

CREATE TABLE IF NOT EXISTS public.billing_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code varchar(32) NOT NULL CHECK (code ~ '^[A-Z0-9]+(-[A-Z0-9]+)*$' AND length(code) >= 4),
  plan varchar(48) NOT NULL REFERENCES public.billing_plans(code),
  business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE,
  max_uses integer CHECK (max_uses >= 1),
  uses integer NOT NULL DEFAULT 0 CHECK (uses >= 0),
  expires_at timestamptz,
  status varchar(8) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  note varchar(200),
  key_id uuid NOT NULL,
  partner varchar(40) NOT NULL,
  idem_key varchar(255),
  req_hash char(64),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now())
    CHECK (created_at = date_trunc('milliseconds', created_at)),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- A code anyone may enter needs a use limit and an end, so a leaked one can't run forever.
  CONSTRAINT billing_codes_shared CHECK (business_id IS NOT NULL OR num_nulls(max_uses, expires_at) = 0),
  CONSTRAINT billing_codes_revoked CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  CONSTRAINT billing_codes_idem CHECK ((idem_key IS NULL) = (req_hash IS NULL))
);

-- Codes are stored in upper case and entered in any case, so one index answers a lookup.
CREATE UNIQUE INDEX IF NOT EXISTS billing_codes_code_unique ON public.billing_codes (code);
-- One code per operator key and Idempotency-Key.
CREATE UNIQUE INDEX IF NOT EXISTS billing_codes_idem_unique
  ON public.billing_codes (key_id, idem_key) WHERE idem_key IS NOT NULL;
-- Newest first, of every plan or of one. The API's cursor is (created_at, id).
CREATE INDEX IF NOT EXISTS billing_codes_created_idx ON public.billing_codes (created_at, id);
CREATE INDEX IF NOT EXISTS billing_codes_plan_idx ON public.billing_codes (plan, created_at, id);
CREATE INDEX IF NOT EXISTS billing_codes_business_idx ON public.billing_codes (business_id) WHERE business_id IS NOT NULL;

ALTER TABLE public.billing_accounts
  ADD COLUMN IF NOT EXISTS plan_code varchar(48) REFERENCES public.billing_plans(code),
  ADD COLUMN IF NOT EXISTS plan_ends timestamptz,
  ADD COLUMN IF NOT EXISTS code_id uuid REFERENCES public.billing_codes(id);

ALTER TABLE public.billing_checkout_requests
  ADD COLUMN IF NOT EXISTS plan_code varchar(48) REFERENCES public.billing_plans(code),
  ADD COLUMN IF NOT EXISTS code_id uuid REFERENCES public.billing_codes(id);

-- Polar's webhook finds the code a subscription came from by its checkout request.
CREATE INDEX IF NOT EXISTS billing_checkout_requests_plan_code_idx
  ON public.billing_checkout_requests (business_id, plan_code, created_at) WHERE code_id IS NOT NULL;

COMMENT ON TABLE public.billing_codes IS 'Promo codes operators issue. Each unlocks one plan whose access is code.';
COMMENT ON COLUMN public.billing_codes.code IS 'What people type, in upper case; compared regardless of case.';
COMMENT ON COLUMN public.billing_codes.plan IS 'The plan it unlocks.';
COMMENT ON COLUMN public.billing_codes.business_id IS 'The one business that may use it; null for a shared code.';
COMMENT ON COLUMN public.billing_codes.max_uses IS 'How many businesses may subscribe with it; null for no limit (bound codes only).';
COMMENT ON COLUMN public.billing_codes.uses IS 'Businesses that subscribed with it. Checkouts open at once can take it past max_uses.';
COMMENT ON COLUMN public.billing_codes.expires_at IS 'No new checkout after this moment.';
COMMENT ON COLUMN public.billing_codes.status IS 'active or revoked. Used-up and expired are read from uses and expires_at.';
COMMENT ON COLUMN public.billing_codes.note IS 'The operator''s note, such as who it was for.';
COMMENT ON COLUMN public.billing_codes.key_id IS 'The operator platform key that issued it.';
COMMENT ON COLUMN public.billing_codes.partner IS 'That key''s partner.';
COMMENT ON COLUMN public.billing_codes.idem_key IS 'The request''s Idempotency-Key.';
COMMENT ON COLUMN public.billing_codes.req_hash IS 'SHA-256 of the request.';
COMMENT ON COLUMN public.billing_codes.revoked_at IS 'When it was revoked. Businesses already on its plan keep it.';
COMMENT ON COLUMN public.billing_codes.created_at IS 'When it was issued, to the millisecond, as the API cursor carries it.';
COMMENT ON COLUMN public.billing_accounts.plan_code IS 'The exact plan when it isn''t the standard plan of plan''s tier; null otherwise.';
COMMENT ON COLUMN public.billing_accounts.plan_ends IS 'When a time-limited plan ends.';
COMMENT ON COLUMN public.billing_accounts.code_id IS 'The promo code the business subscribed with.';
COMMENT ON COLUMN public.billing_checkout_requests.plan_code IS 'The exact plan sold when it isn''t the target''s standard plan.';
COMMENT ON COLUMN public.billing_checkout_requests.code_id IS 'The promo code entered for it.';

-- Codes are written by the worker, as the v1 API's worker actor, and read by it
-- and the read-only role. The app never reads them: a business finds its code's
-- offer through app.billing_code_offers, which needs the code itself. Nobody
-- deletes a code; it is revoked.
ALTER TABLE public.billing_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_codes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS billing_codes_read_all ON public.billing_codes;
DROP POLICY IF EXISTS billing_codes_worker_insert ON public.billing_codes;
DROP POLICY IF EXISTS billing_codes_worker_update ON public.billing_codes;
CREATE POLICY billing_codes_read_all ON public.billing_codes FOR SELECT TO lobbystack_worker, lobbystack_readonly USING (true);
CREATE POLICY billing_codes_worker_insert ON public.billing_codes FOR INSERT TO lobbystack_worker WITH CHECK (app.current_actor_type() = 'worker');
CREATE POLICY billing_codes_worker_update ON public.billing_codes FOR UPDATE TO lobbystack_worker USING (app.current_actor_type() = 'worker') WITH CHECK (app.current_actor_type() = 'worker');
REVOKE ALL ON public.billing_codes FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON public.billing_codes TO lobbystack_worker;
GRANT SELECT ON public.billing_codes TO lobbystack_readonly;

-- A business reads the plan it is on and its prices, so Settings > Plan can
-- show a promo plan's name, price and discount.
DROP POLICY IF EXISTS billing_plans_read_own ON public.billing_plans;
CREATE POLICY billing_plans_read_own ON public.billing_plans FOR SELECT
  TO lobbystack_app USING (code IN (
    SELECT a.plan_code FROM public.billing_accounts a WHERE a.business_id = app.current_business_id()
  ));
DROP POLICY IF EXISTS billing_prices_read_own ON public.billing_prices;
CREATE POLICY billing_prices_read_own ON public.billing_prices FOR SELECT
  TO lobbystack_app USING (plan IN (
    SELECT a.plan_code FROM public.billing_accounts a WHERE a.business_id = app.current_business_id()
  ));

-- The offer a code unlocks for the business in the transaction: one row per
-- live price of its plan. A code that is revoked, expired, used up or bound to
-- another business finds nothing, and so does one whose plan is draft, retired,
-- past its offer end or not sold, so every reason reads the same to whoever
-- typed it. It reads as its owner, past the policies above, but only by the
-- whole code; callers authorize the business first.
CREATE OR REPLACE FUNCTION app.billing_code_offers(p_code text)
RETURNS TABLE (
  code_id uuid, plan varchar, tier varchar, names jsonb, discount jsonb, polar_disc text,
  months smallint, ends varchar, period varchar, currency char(3), cents integer, per_month integer, polar_id text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT c.id, o.code, o.tier, o.names, o.discount, o.polar_disc, o.months, o.ends, o.period, o.currency, o.cents, o.per_month, o.polar_id
  FROM public.billing_codes c
  JOIN public.billing_offers o ON o.code = c.plan
  WHERE c.code = p_code
    AND c.status = 'active'
    AND (c.expires_at IS NULL OR c.expires_at > now())
    AND (c.max_uses IS NULL OR c.uses < c.max_uses)
    AND (c.business_id IS NULL OR c.business_id = app.current_business_id())
    AND o.access = 'code'
    AND o.sold
    AND o.period IS NOT NULL
  ORDER BY o.period
$$;

REVOKE ALL ON FUNCTION app.billing_code_offers(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.billing_code_offers(text) TO lobbystack_app, lobbystack_worker;
