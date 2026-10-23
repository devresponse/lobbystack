-- Promo plans with their own allowances: a business on a plan other than the
-- standard one of its tier uses that plan's allowances, limits and overage
-- rates, as Polar already bills them, instead of its tier's.
--
-- Each usage event remembers the plan it was used under beside its tier, so a
-- month that moves into or out of a promo plan prices every event on the terms
-- it was used under. Null is the tier's standard plan, as on every event
-- recorded before this migration.

ALTER TABLE public.billing_usage_events
  ADD COLUMN IF NOT EXISTS plan_code_at_record_time varchar(48) REFERENCES public.billing_plans(code);

COMMENT ON COLUMN public.billing_usage_events.plan_code_at_record_time IS 'The plan the usage counted under when it isn''t the standard plan of plan_at_record_time; null otherwise.';

-- The plans a business's events name, for the policy below.
CREATE INDEX IF NOT EXISTS billing_usage_events_plan_code_idx
  ON public.billing_usage_events (business_id, plan_code_at_record_time)
  WHERE plan_code_at_record_time IS NOT NULL;

-- A business reads the plan it is on and every plan its usage counted under,
-- so it can replay a month it started on a promo plan it has since left.
DROP POLICY IF EXISTS billing_plans_read_own ON public.billing_plans;
CREATE POLICY billing_plans_read_own ON public.billing_plans FOR SELECT
  TO lobbystack_app USING (
    code IN (
      SELECT a.plan_code FROM public.billing_accounts a WHERE a.business_id = app.current_business_id()
    )
    OR code IN (
      SELECT e.plan_code_at_record_time FROM public.billing_usage_events e
      WHERE e.business_id = app.current_business_id() AND e.plan_code_at_record_time IS NOT NULL
    )
  );

-- The offer a code unlocks now also says what its plan includes, so the
-- dashboard can show it before anyone buys. A function's columns can't change
-- in place, so it is made again with the same rules as 0109.
DROP FUNCTION IF EXISTS app.billing_code_offers(text);
CREATE FUNCTION app.billing_code_offers(p_code text)
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
    AND o.access = 'code'
    AND o.sold
    AND o.period IS NOT NULL
  ORDER BY o.period
$$;

REVOKE ALL ON FUNCTION app.billing_code_offers(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.billing_code_offers(text) TO lobbystack_app, lobbystack_worker;
