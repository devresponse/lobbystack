-- Prepaid packs after their review (docs/features/prepaid-packs.md). Every
-- change here touches only the pack tables, or a business whose plan a pack
-- replaced, so a business that never bought a pack, and a deployment that
-- sells none, sees nothing change.
--
-- 1. A pack checkout keeps the terms the business saw when it asked for it:
--    the minutes, the length, the monthly allowances and the limits. The
--    payment adds the pack with those terms, so a catalog apply that changes
--    the pack while its payment page is open, or before a bank debit settles,
--    never gives the buyer less than they paid for. A row from before this
--    migration has none, and its payment reads the catalog, as before.
-- 2. A pack checkout names the pack its payment added, so the page that waits
--    for the payment can tell a pack the business has from one that ended at
--    once, as when a plan bought while the page was open came first.
-- 3. app.billing_code_offers no longer counts a subscription a pack's payment
--    replaced as live on a code's plan, as it doesn't once the provider ends
--    it: until then, a code the business already used would show its old
--    plan as the one it is on, or sell it again. Only a pack's payment sets
--    billing_accounts.replaced_subscription_id, so for every other business
--    the function reads as 0147 made it.
--
-- The app only reads a business's packs and what its calls drew from them:
-- every call's reservation, refund, dispute and expiry runs as the worker.
-- 0148 gave the app writes to billing_packs and billing_pack_draws it never
-- makes, and they stay for now: the release before this one checks for them
-- as its migrate step ends, so taking them back here would fail that step on
-- a rollback. A later migration takes them back once no deployment can go
-- back below this one.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

ALTER TABLE public.billing_pack_checkouts
  ADD COLUMN IF NOT EXISTS terms jsonb,
  ADD COLUMN IF NOT EXISTS pack_id uuid REFERENCES public.billing_packs(id) ON DELETE SET NULL;

ALTER TABLE public.billing_pack_checkouts DROP CONSTRAINT IF EXISTS billing_pack_checkouts_terms_object;
ALTER TABLE public.billing_pack_checkouts ADD CONSTRAINT billing_pack_checkouts_terms_object
  CHECK (terms IS NULL OR jsonb_typeof(terms) = 'object');

COMMENT ON COLUMN public.billing_pack_checkouts.terms IS 'The pack''s terms when the checkout was asked for (voiceSec, days, smsSeg, callsOut, chatUnits, kbBytes, numbers, receptionists), which its payment adds the pack with. Null on a row from before 0149.';
COMMENT ON COLUMN public.billing_pack_checkouts.pack_id IS 'The pack the checkout''s payment added, once it arrived.';

-- 0147's function, with the replaced subscription left out of the exception
-- that finds a used code for the business on its plan.
CREATE OR REPLACE FUNCTION app.billing_code_offers(p_code text)
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
          AND (a.replaced_subscription_id IS NULL OR a.replaced_subscription_id IS DISTINCT FROM a.subscription_id)
      )
    )
    AND o.access = 'code'
    AND o.sold
    AND o.period IS NOT NULL
  ORDER BY o.period
$$;

REVOKE ALL ON FUNCTION app.billing_code_offers(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.billing_code_offers(text) TO lobbystack_app, lobbystack_worker;
