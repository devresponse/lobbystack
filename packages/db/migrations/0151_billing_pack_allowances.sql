-- Prepaid packs as fixed-length plans (docs/features/prepaid-packs.md). A
-- pack is a plan paid for once that lasts a number of days without renewing,
-- so everything it includes lasts its whole length: its alert texts,
-- transfers and website chats now count against the pack until it ends, as
-- its minutes always have, instead of starting afresh each UTC month.
-- billing.json gives each pack's allowances for its whole length, and the
-- ledger counts them per pack as it counts seconds:
--
-- 1. billing_packs gains sms_used, calls_used and chat_used: what the
--    business's texts, transfers and chats drew from the pack, never more
--    than it holds. A pack bought before this migration starts at zero, and
--    the numbers copied onto it now last its whole length; none was sold for
--    real money before this release.
-- 2. billing_pack_draws gains usage_kind, the kind of the usage row a draw
--    is for, so a text's segments, a transfer's attempts and a chat's units
--    are told apart from a call's seconds; the seconds column holds the
--    amount, whatever the kind. Every row from before this migration is a
--    call's, which the default says.
-- 3. The pack columns' comments say the allowances last the pack's length.
--
-- No row is rewritten and no function, policy or grant changes: the app and
-- the worker already write both tables (0148). A business that never bought
-- a pack, and a deployment that sells none, sees nothing change. Undoing this
-- file drops the four columns and their two checks.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

ALTER TABLE public.billing_packs
  ADD COLUMN IF NOT EXISTS sms_used integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS calls_used integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS chat_used integer NOT NULL DEFAULT 0;

ALTER TABLE public.billing_packs DROP CONSTRAINT IF EXISTS billing_packs_allowances_used;
ALTER TABLE public.billing_packs ADD CONSTRAINT billing_packs_allowances_used
  CHECK (sms_used BETWEEN 0 AND sms_seg AND calls_used BETWEEN 0 AND calls_out AND chat_used BETWEEN 0 AND chat_units);

ALTER TABLE public.billing_pack_draws
  ADD COLUMN IF NOT EXISTS usage_kind varchar(32) NOT NULL DEFAULT 'voice_seconds';

ALTER TABLE public.billing_pack_draws DROP CONSTRAINT IF EXISTS billing_pack_draws_usage_kind;
ALTER TABLE public.billing_pack_draws ADD CONSTRAINT billing_pack_draws_usage_kind
  CHECK (usage_kind IN ('voice_seconds', 'alert_sms_segments', 'outbound_call_attempts', 'chat_ai_tokens'));

COMMENT ON COLUMN public.billing_pack_plans.sms_seg IS 'Alert SMS segments included for the pack''s whole length.';
COMMENT ON COLUMN public.billing_pack_plans.calls_out IS 'Outbound call attempts (transfers) included for the pack''s whole length.';
COMMENT ON COLUMN public.billing_pack_plans.chat_units IS 'Website chat AI units included for the pack''s whole length.';

COMMENT ON COLUMN public.billing_packs.sms_seg IS 'Alert SMS segments bought, for the pack''s whole length.';
COMMENT ON COLUMN public.billing_packs.calls_out IS 'Outbound call attempts (transfers) bought, for the pack''s whole length.';
COMMENT ON COLUMN public.billing_packs.chat_units IS 'Website chat AI units bought, for the pack''s whole length.';
COMMENT ON COLUMN public.billing_packs.sms_used IS 'Alert SMS segments texts have drawn; never more than bought.';
COMMENT ON COLUMN public.billing_packs.calls_used IS 'Outbound call attempts transfers have drawn; never more than bought.';
COMMENT ON COLUMN public.billing_packs.chat_used IS 'Website chat AI units chats have drawn; never more than bought.';
COMMENT ON COLUMN public.billing_packs.refunded_cents IS 'Refunds so far, from the provider''s events; a partial refund takes its share of every allowance off the pack.';

COMMENT ON TABLE public.billing_pack_draws IS 'Which pack paid for each use, by the usage row''s key.';
COMMENT ON COLUMN public.billing_pack_draws.source_key IS 'The usage row''s source_key, such as voice:<call id>.';
COMMENT ON COLUMN public.billing_pack_draws.usage_kind IS 'The usage row''s kind: voice_seconds for a call, alert_sms_segments for a text, outbound_call_attempts for a transfer, chat_ai_tokens for a website chat.';
COMMENT ON COLUMN public.billing_pack_draws.seconds IS 'What the use took from the pack: seconds for a call, segments for a text, attempts for a transfer, units for a chat.';
