-- Prepaid packs after their review (docs/features/prepaid-packs.md). Every
-- change here touches only the pack tables, so a business that never bought a
-- pack, and a deployment that sells none, sees nothing change.
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
-- 3. The app only reads a business's packs and what its calls drew from them:
--    every call's reservation, every refund, dispute and expiry runs as the
--    worker, which keeps its grants. 0148 gave the app writes it never makes.

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

REVOKE UPDATE ON public.billing_packs FROM lobbystack_app;
REVOKE INSERT, UPDATE ON public.billing_pack_draws FROM lobbystack_app;
