-- Selling top-ups (docs/features/top-ups.md): a business on Free or on a
-- prepaid pack pays once, through the deployment's billing provider, for a
-- top-up its brand's billing.json puts on sale, such as 100 voice minutes
-- that last 90 days. It is the same top-up an operator grants or a code adds
-- (0154): it never changes the plan, its uses draw on it only once the plan's
-- own allowance of their kind is used up, and it ends on its date.
--
-- A top-up on sale is sold the way a prepaid pack is (0148), so nothing new
-- talks to the provider:
--
-- 1. billing_pack_plans gains kind: pack, as every row so far, or top_up. A
--    top-up's row has a pack's allowances and price, and limits of 0, since a
--    top-up never changes a limit. billing_pack_prices, the apply, the link
--    and the daily check take it as they take a pack, and billing_pack_offers
--    shows kind, so the screens tell the two apart.
-- 2. billing_pack_checkouts sells it as it sells a pack, so a business still
--    makes one purchase at a time. top_up_id names the top-up its payment
--    added, as pack_id names a pack.
-- 3. billing_top_ups takes a third source, purchase, with the payment beside
--    it: the provider, its payment, the order row, the amount, what was
--    refunded and the currency. One top-up per payment, so an event
--    delivered twice adds nothing. A refund takes its share off what the top-up
--    gives, as a pack's does, and one of the whole payment ends it (refunded);
--    a dispute holds it (frozen) until it closes.
--
-- A deployment whose billing.json sells no top-up sees nothing change: no row
-- is rewritten, every existing pack row is kind pack, and no function, policy
-- or grant changes. Undoing this file drops the new columns, the two new
-- checks and the payment index, and puts the three checks it replaces back,
-- once no row uses what they don't allow.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 1. The catalog. A default, so no row is rewritten and every row so far is a pack.
ALTER TABLE public.billing_pack_plans
  ADD COLUMN IF NOT EXISTS kind varchar(8) NOT NULL DEFAULT 'pack';

ALTER TABLE public.billing_pack_plans DROP CONSTRAINT IF EXISTS billing_pack_plans_kind;
ALTER TABLE public.billing_pack_plans ADD CONSTRAINT billing_pack_plans_kind CHECK (kind IN ('pack', 'top_up'));

-- A pack includes 1 to 50 receptionists, as before; a top-up changes no limit, so all three are 0.
ALTER TABLE public.billing_pack_plans DROP CONSTRAINT IF EXISTS billing_pack_plans_receptionists_check;
ALTER TABLE public.billing_pack_plans DROP CONSTRAINT IF EXISTS billing_pack_plans_limits;
ALTER TABLE public.billing_pack_plans ADD CONSTRAINT billing_pack_plans_limits CHECK (
  (kind = 'pack' AND receptionists BETWEEN 1 AND 50)
  OR (kind = 'top_up' AND kb_bytes = 0 AND numbers = 0 AND receptionists = 0)
);

-- The offers, with kind last, since a view only gains columns at its end.
CREATE OR REPLACE VIEW public.billing_pack_offers WITH (security_invoker = true) AS
SELECT p.code, p.names, p.voice_sec, p.days, p.sms_seg, p.calls_out, p.chat_units,
  p.kb_bytes, p.numbers, p.receptionists, p.sort,
  r.id AS price_id, r.currency, r.cents, r.provider_ref, p.kind
FROM public.billing_pack_plans p
JOIN public.billing_pack_prices r ON r.pack = p.code AND r.retired_at IS NULL
WHERE p.status = 'active';

-- 3. The ledger. Grants and codes keep amount 0, refunded 0 and no payment.
ALTER TABLE public.billing_top_ups
  ADD COLUMN IF NOT EXISTS offer varchar(48) REFERENCES public.billing_pack_plans(code),
  ADD COLUMN IF NOT EXISTS price_id uuid REFERENCES public.billing_pack_prices(id),
  ADD COLUMN IF NOT EXISTS provider varchar(8) CHECK (provider IN ('polar', 'stripe')),
  ADD COLUMN IF NOT EXISTS provider_ref text,
  ADD COLUMN IF NOT EXISTS transaction_id uuid REFERENCES public.billing_transactions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS amount_cents integer NOT NULL DEFAULT 0 CHECK (amount_cents >= 0),
  ADD COLUMN IF NOT EXISTS refunded_cents integer NOT NULL DEFAULT 0 CHECK (refunded_cents >= 0),
  ADD COLUMN IF NOT EXISTS currency char(3) CHECK (currency ~ '^[a-z]{3}$'),
  ADD COLUMN IF NOT EXISTS refunded_at timestamptz;

ALTER TABLE public.billing_top_ups DROP CONSTRAINT IF EXISTS billing_top_ups_source_check;
ALTER TABLE public.billing_top_ups ADD CONSTRAINT billing_top_ups_source_check CHECK (source IN ('grant', 'code', 'purchase'));

-- active and revoked as before; frozen while a dispute holds its payment; refunded once the whole payment went back.
ALTER TABLE public.billing_top_ups DROP CONSTRAINT IF EXISTS billing_top_ups_status_check;
ALTER TABLE public.billing_top_ups ADD CONSTRAINT billing_top_ups_status_check CHECK (status IN ('active', 'frozen', 'revoked', 'refunded'));

-- A grant names the operator key that made it; a code's top-up names its code; a purchase names its payment.
ALTER TABLE public.billing_top_ups DROP CONSTRAINT IF EXISTS billing_top_ups_source;
ALTER TABLE public.billing_top_ups ADD CONSTRAINT billing_top_ups_source CHECK (
  (source = 'grant' AND key_id IS NOT NULL AND partner IS NOT NULL AND code_id IS NULL AND code IS NULL AND offer IS NULL AND provider IS NULL AND provider_ref IS NULL)
  OR (source = 'code' AND code_id IS NOT NULL AND code IS NOT NULL AND key_id IS NULL AND partner IS NULL AND offer IS NULL AND provider IS NULL AND provider_ref IS NULL)
  OR (source = 'purchase' AND offer IS NOT NULL AND provider IS NOT NULL AND provider_ref IS NOT NULL AND currency IS NOT NULL AND code_id IS NULL AND code IS NULL AND key_id IS NULL AND partner IS NULL)
);

ALTER TABLE public.billing_top_ups DROP CONSTRAINT IF EXISTS billing_top_ups_refunded;
ALTER TABLE public.billing_top_ups ADD CONSTRAINT billing_top_ups_refunded CHECK ((status = 'refunded') = (refunded_at IS NOT NULL));

-- One top-up per payment, so an event delivered twice adds nothing. Grants and codes have none.
CREATE UNIQUE INDEX IF NOT EXISTS billing_top_ups_payment_unique
  ON public.billing_top_ups (provider, provider_ref);

-- 2. The checkout names the top-up its payment added, as pack_id names a pack.
ALTER TABLE public.billing_pack_checkouts
  ADD COLUMN IF NOT EXISTS top_up_id uuid REFERENCES public.billing_top_ups(id) ON DELETE SET NULL;

ALTER TABLE public.billing_pack_checkouts DROP CONSTRAINT IF EXISTS billing_pack_checkouts_one_result;
ALTER TABLE public.billing_pack_checkouts ADD CONSTRAINT billing_pack_checkouts_one_result CHECK (num_nonnulls(pack_id, top_up_id) <= 1);

COMMENT ON COLUMN public.billing_pack_plans.kind IS 'pack (a plan paid once for its length) or top_up (extra allowances on top of the plan, which change no limit).';
COMMENT ON VIEW public.billing_pack_offers IS 'Packs and top-ups on sale now, with their live prices and kind. Reads with the caller''s row-level security.';
COMMENT ON COLUMN public.billing_pack_checkouts.top_up_id IS 'The top-up the checkout''s payment added, once it arrived.';

COMMENT ON COLUMN public.billing_top_ups.source IS 'grant (an operator''s platform key), code (a business typed a top-up code) or purchase (a business paid for one on sale).';
COMMENT ON COLUMN public.billing_top_ups.status IS 'active; frozen while a dispute holds its payment; revoked by an operator; refunded once its whole payment went back. Only active counts.';
COMMENT ON COLUMN public.billing_top_ups.offer IS 'The top-up on sale it was bought as: its code in billing.json''s topUps.';
COMMENT ON COLUMN public.billing_top_ups.price_id IS 'The price it was bought at.';
COMMENT ON COLUMN public.billing_top_ups.provider IS 'The billing provider that took the payment.';
COMMENT ON COLUMN public.billing_top_ups.provider_ref IS 'The payment: a Stripe PaymentIntent or a Polar order.';
COMMENT ON COLUMN public.billing_top_ups.transaction_id IS 'The payment''s order row in billing_transactions.';
COMMENT ON COLUMN public.billing_top_ups.amount_cents IS 'What was paid, in currency; 0 for a grant or a code.';
COMMENT ON COLUMN public.billing_top_ups.refunded_cents IS 'What of the payment was refunded; a partial refund takes its share off what the top-up gives.';
COMMENT ON COLUMN public.billing_top_ups.currency IS 'The payment''s currency; null for a grant or a code.';
COMMENT ON COLUMN public.billing_top_ups.refunded_at IS 'When its whole payment went back; set exactly when status is refunded.';
