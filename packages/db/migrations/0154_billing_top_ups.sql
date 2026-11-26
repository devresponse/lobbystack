-- Top-ups (docs/features/top-ups.md): extra voice minutes, alert texts,
-- transfers and website chats a business gets on top of its plan. A top-up
-- never changes the plan: the business keeps its plan, its subscription, its
-- prices and its allowances, and its uses draw on a top-up only once the
-- plan's own allowance of their kind is used up (on the prepaid tier, once
-- its packs hold none of it). On Free and on a pack that is the difference
-- between a use refused and a use made; on Starter and Pro it is usage the
-- billing provider is never sent, since the top-up paid for it.
--
-- Two ways in, neither through the billing provider:
--
-- 1. An operator grants one to a business with a platform key (POST
--    /v1/billing/top-ups), for a promotion, as goodwill or for support,
--    with an end date or none.
-- 2. A business types a top-up code under Have a promo code?: an operator
--    issues it as a promo code that adds credit instead of unlocking a plan.
--    It adds the code's top-up at once, without a payment, once per business
--    and once per person, and lasts the code's days from then.
--
-- 1. billing_top_ups is the ledger: one row per top-up, with what it gives,
--    what uses drew from it, when it ends and where it came from.
-- 2. billing_top_up_draws says which top-up paid for each use, by the usage
--    row's key, as billing_pack_draws does for packs.
-- 3. billing_usage_events gains top_up_quantity, how much of the row a
--    top-up paid for. It is 0 on every row but those a top-up paid for, and
--    the usage replay, the spending cap and the provider's billable quantity
--    leave that part out.
-- 4. billing_codes takes top-up codes: plan may be null, and a code without
--    a plan carries the top-up it adds (voice_sec, sms_seg, calls_out,
--    chat_units) and how many days it lasts (days, null for no end).
--    app.billing_code_offers joins on plan, so it never finds one.
-- 5. Two functions read and redeem a top-up code for the business and the
--    person in the transaction, under the code's row lock, so its last use
--    can't be taken twice.
--
-- A business that never gets a top-up sees nothing change: no row is
-- rewritten, top_up_quantity defaults to 0, and no existing function, policy
-- or grant changes. Undoing this file drops the two tables, the five code
-- columns, top_up_quantity, the two functions and the two checks, and makes
-- billing_codes.plan required again once no top-up code is left.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- The ledger. Everything a top-up gives is set on its row when it is made,
-- and so is its end, so nothing later changes a top-up already given. Uses add
-- to the used columns through billing_top_up_draws; an operator may revoke a
-- top-up, which stops what it still holds. Rows are never deleted but with
-- their business.
CREATE TABLE IF NOT EXISTS public.billing_top_ups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  source varchar(8) NOT NULL CHECK (source IN ('grant', 'code')),
  code_id uuid REFERENCES public.billing_codes(id),
  code varchar(32),
  key_id uuid,
  partner varchar(40),
  redeemed_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  note varchar(200),
  voice_sec integer NOT NULL DEFAULT 0 CHECK (voice_sec >= 0),
  sms_seg integer NOT NULL DEFAULT 0 CHECK (sms_seg >= 0),
  calls_out integer NOT NULL DEFAULT 0 CHECK (calls_out >= 0),
  chat_units integer NOT NULL DEFAULT 0 CHECK (chat_units >= 0),
  voice_used integer NOT NULL DEFAULT 0,
  sms_used integer NOT NULL DEFAULT 0,
  calls_used integer NOT NULL DEFAULT 0,
  chat_used integer NOT NULL DEFAULT 0,
  starts_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz,
  status varchar(8) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now())
    CHECK (created_at = date_trunc('milliseconds', created_at)),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_top_ups_gives CHECK (voice_sec + sms_seg + calls_out + chat_units > 0),
  CONSTRAINT billing_top_ups_used CHECK (
    voice_used BETWEEN 0 AND voice_sec AND sms_used BETWEEN 0 AND sms_seg
    AND calls_used BETWEEN 0 AND calls_out AND chat_used BETWEEN 0 AND chat_units
  ),
  -- A grant names the operator key that made it; a code's top-up names its code.
  CONSTRAINT billing_top_ups_source CHECK (
    (source = 'grant' AND key_id IS NOT NULL AND partner IS NOT NULL AND code_id IS NULL AND code IS NULL)
    OR (source = 'code' AND code_id IS NOT NULL AND code IS NOT NULL AND key_id IS NULL AND partner IS NULL)
  ),
  CONSTRAINT billing_top_ups_ends CHECK (ends_at IS NULL OR ends_at > starts_at),
  CONSTRAINT billing_top_ups_revoked CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);

-- A business's top-ups, newest first: Settings > Plan, the API and the delete that cascades from businesses.
CREATE INDEX IF NOT EXISTS billing_top_ups_business_idx
  ON public.billing_top_ups (business_id, created_at DESC);
-- A business's live top-ups, the one that ends first first, for every use.
CREATE INDEX IF NOT EXISTS billing_top_ups_live_idx
  ON public.billing_top_ups (business_id, ends_at) WHERE status = 'active';
-- A code adds its top-up once per business and once per person.
CREATE UNIQUE INDEX IF NOT EXISTS billing_top_ups_code_business_unique
  ON public.billing_top_ups (code_id, business_id) WHERE code_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS billing_top_ups_code_person_unique
  ON public.billing_top_ups (code_id, redeemed_by) WHERE code_id IS NOT NULL AND redeemed_by IS NOT NULL;

-- Which top-up paid for each use: the usage row's key, its kind and what it
-- took. A use that grows or shrinks updates its own rows, in the same
-- transaction as its usage row. No foreign key into billing_usage_events, so
-- that table's rules stay as they are.
CREATE TABLE IF NOT EXISTS public.billing_top_up_draws (
  top_up_id uuid NOT NULL REFERENCES public.billing_top_ups(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  source_key varchar(255) NOT NULL,
  usage_kind varchar(32) NOT NULL CHECK (usage_kind IN ('voice_seconds', 'alert_sms_segments', 'outbound_call_attempts', 'chat_ai_tokens')),
  units integer NOT NULL CHECK (units >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (top_up_id, source_key)
);

CREATE INDEX IF NOT EXISTS billing_top_up_draws_source_idx
  ON public.billing_top_up_draws (business_id, source_key);

-- How much of a usage row a top-up paid for. A default, so no row is rewritten.
ALTER TABLE public.billing_usage_events
  ADD COLUMN IF NOT EXISTS top_up_quantity double precision NOT NULL DEFAULT 0;

-- Top-up codes: a code without a plan adds the top-up its columns describe.
ALTER TABLE public.billing_codes
  ALTER COLUMN plan DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS voice_sec integer,
  ADD COLUMN IF NOT EXISTS sms_seg integer,
  ADD COLUMN IF NOT EXISTS calls_out integer,
  ADD COLUMN IF NOT EXISTS chat_units integer,
  ADD COLUMN IF NOT EXISTS days smallint;

-- A plan's code carries no top-up; a top-up code carries no plan, gives something and lasts 1 to 1,095 days or has no end.
ALTER TABLE public.billing_codes DROP CONSTRAINT IF EXISTS billing_codes_kind;
ALTER TABLE public.billing_codes ADD CONSTRAINT billing_codes_kind CHECK (
  (plan IS NOT NULL AND num_nonnulls(voice_sec, sms_seg, calls_out, chat_units, days) = 0)
  OR (
    plan IS NULL AND num_nulls(voice_sec, sms_seg, calls_out, chat_units) = 0
    AND voice_sec >= 0 AND sms_seg >= 0 AND calls_out >= 0 AND chat_units >= 0
    AND voice_sec + sms_seg + calls_out + chat_units > 0
    AND (days IS NULL OR days BETWEEN 1 AND 1095)
  )
);

COMMENT ON TABLE public.billing_top_ups IS 'Top-ups: extra allowances a business gets on top of its plan, granted by an operator or added by a code.';
COMMENT ON COLUMN public.billing_top_ups.source IS 'grant (an operator''s platform key) or code (a business typed a top-up code).';
COMMENT ON COLUMN public.billing_top_ups.code_id IS 'The top-up code that added it.';
COMMENT ON COLUMN public.billing_top_ups.code IS 'That code as it was typed and stored, which the business may read where it may not read billing_codes.';
COMMENT ON COLUMN public.billing_top_ups.key_id IS 'The operator platform key that granted it.';
COMMENT ON COLUMN public.billing_top_ups.partner IS 'That key''s partner.';
COMMENT ON COLUMN public.billing_top_ups.redeemed_by IS 'The person who typed the code.';
COMMENT ON COLUMN public.billing_top_ups.note IS 'The operator''s note, such as the promotion it is for.';
COMMENT ON COLUMN public.billing_top_ups.voice_sec IS 'Voice seconds it gives.';
COMMENT ON COLUMN public.billing_top_ups.sms_seg IS 'Alert SMS segments it gives.';
COMMENT ON COLUMN public.billing_top_ups.calls_out IS 'Outbound call attempts (transfers) it gives.';
COMMENT ON COLUMN public.billing_top_ups.chat_units IS 'Website chat AI units it gives.';
COMMENT ON COLUMN public.billing_top_ups.voice_used IS 'Voice seconds uses drew; never more than it gives.';
COMMENT ON COLUMN public.billing_top_ups.sms_used IS 'Alert SMS segments uses drew.';
COMMENT ON COLUMN public.billing_top_ups.calls_used IS 'Outbound call attempts uses drew.';
COMMENT ON COLUMN public.billing_top_ups.chat_used IS 'Website chat AI units uses drew.';
COMMENT ON COLUMN public.billing_top_ups.starts_at IS 'When it was granted or added.';
COMMENT ON COLUMN public.billing_top_ups.ends_at IS 'When it stops counting, fixed when it is made; null means never.';
COMMENT ON COLUMN public.billing_top_ups.status IS 'active, or revoked by an operator, which stops what it still holds.';
COMMENT ON COLUMN public.billing_top_ups.revoked_at IS 'When it was revoked; set exactly when status is revoked.';
COMMENT ON COLUMN public.billing_top_ups.created_at IS 'When it was made, to the millisecond.';

COMMENT ON TABLE public.billing_top_up_draws IS 'Which top-up paid for each use, by the usage row''s key.';
COMMENT ON COLUMN public.billing_top_up_draws.source_key IS 'The usage row''s source_key, such as voice:<call id>.';
COMMENT ON COLUMN public.billing_top_up_draws.usage_kind IS 'The usage row''s kind.';
COMMENT ON COLUMN public.billing_top_up_draws.units IS 'What the use took from the top-up: seconds for a call, segments for a text, attempts for a transfer, units for a chat.';

COMMENT ON COLUMN public.billing_usage_events.top_up_quantity IS 'The part of quantity a top-up paid for (0154): counted as used, never billed and never past the allowance.';

COMMENT ON COLUMN public.billing_codes.plan IS 'The plan it unlocks; null for a top-up code.';
COMMENT ON COLUMN public.billing_codes.voice_sec IS 'A top-up code''s voice seconds; null on a plan''s code.';
COMMENT ON COLUMN public.billing_codes.sms_seg IS 'A top-up code''s alert SMS segments.';
COMMENT ON COLUMN public.billing_codes.calls_out IS 'A top-up code''s outbound call attempts (transfers).';
COMMENT ON COLUMN public.billing_codes.chat_units IS 'A top-up code''s website chat AI units.';
COMMENT ON COLUMN public.billing_codes.days IS 'How long a top-up code''s top-up lasts from when it is added, in 24-hour days; null for no end.';

-- A business's top-ups and draws, with billing_packs' policy (0148). Only the
-- worker role writes them: it makes an operator's grant, as the v1 API's
-- worker actor, and every use draws on them through it, the admin's call,
-- chat and text routes included. The dashboard only reads them, and a code
-- adds its top-up through app.redeem_billing_top_up_code, as that function's
-- owner. Nobody deletes one but with its business.
DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['billing_top_ups', 'billing_top_up_draws'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS %I_tenant_isolation ON public.%I', table_name, table_name);
    EXECUTE format('CREATE POLICY %I_tenant_isolation ON public.%I USING (business_id = app.current_business_id() AND (app.current_actor_type() IN (''system'', ''worker'', ''dispatcher'') OR app.has_business_membership(business_id))) WITH CHECK (business_id = app.current_business_id() AND (app.current_actor_type() IN (''system'', ''worker'', ''dispatcher'') OR app.has_business_membership(business_id)))', table_name, table_name);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC', table_name);
    EXECUTE format('GRANT SELECT ON public.%I TO lobbystack_readonly', table_name);
  END LOOP;
END
$$;
GRANT SELECT ON public.billing_top_ups, public.billing_top_up_draws TO lobbystack_app;
GRANT SELECT, INSERT, UPDATE ON public.billing_top_ups, public.billing_top_up_draws TO lobbystack_worker;

-- What a top-up code adds for the business and the person in the
-- transaction, or no row for a code that doesn't work for them: unknown, a
-- plan's code, revoked, expired, used up or bound to another business, so
-- every such reason reads the same to whoever typed it. One the business or
-- the person already added comes back with used_here or used_by_you, so the
-- dashboard can say so; it can't be added again. It reads as its owner, past
-- billing_codes' policies, but only by the whole code, and only for a person
-- with an active membership of the business; callers authorize the role first.
CREATE OR REPLACE FUNCTION app.billing_top_up_code(p_code text)
RETURNS TABLE (
  code_id uuid, code varchar, voice_sec integer, sms_seg integer, calls_out integer, chat_units integer,
  days smallint, used_here boolean, used_by_you boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT c.id, c.code, c.voice_sec, c.sms_seg, c.calls_out, c.chat_units, c.days,
    EXISTS (SELECT 1 FROM public.billing_top_ups t WHERE t.code_id = c.id AND t.business_id = app.current_business_id()),
    EXISTS (SELECT 1 FROM public.billing_top_ups t WHERE t.code_id = c.id AND t.redeemed_by = app.current_user_id())
  FROM public.billing_codes c
  WHERE c.code = p_code
    AND c.plan IS NULL
    AND c.status = 'active'
    AND (c.expires_at IS NULL OR c.expires_at > now())
    AND (c.business_id IS NULL OR c.business_id = app.current_business_id())
    AND app.current_user_id() IS NOT NULL
    AND app.has_business_membership(app.current_business_id())
    -- A use the business or the person already made still finds the code, which then says so.
    AND (
      c.max_uses IS NULL OR c.uses < c.max_uses
      OR EXISTS (SELECT 1 FROM public.billing_top_ups t WHERE t.code_id = c.id AND (t.business_id = app.current_business_id() OR t.redeemed_by = app.current_user_id()))
    )
$$;

REVOKE ALL ON FUNCTION app.billing_top_up_code(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.billing_top_up_code(text) TO lobbystack_app;

-- Adds a top-up code's top-up to the business in the transaction, for the
-- person in it, and counts the use: the new top-up's id, or null when the
-- code doesn't work for them, as app.billing_top_up_code reads it, or the
-- business or the person already added it. The code's row is locked first,
-- so two businesses can't both take its last use, and its uses never pass
-- max_uses. The top-up lasts the code's days from now, as 24-hour days, so no
-- clock change moves its end.
CREATE OR REPLACE FUNCTION app.redeem_billing_top_up_code(p_code text)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  target_business uuid := app.current_business_id();
  person uuid := app.current_user_id();
  found_code public.billing_codes%ROWTYPE;
  added uuid;
BEGIN
  IF target_business IS NULL OR person IS NULL OR NOT app.has_business_membership(target_business) THEN
    RETURN NULL;
  END IF;
  SELECT * INTO found_code FROM public.billing_codes WHERE code = p_code AND plan IS NULL FOR UPDATE;
  IF NOT FOUND
    OR found_code.status <> 'active'
    OR (found_code.expires_at IS NOT NULL AND found_code.expires_at <= now())
    OR (found_code.max_uses IS NOT NULL AND found_code.uses >= found_code.max_uses)
    OR (found_code.business_id IS NOT NULL AND found_code.business_id <> target_business)
    OR EXISTS (SELECT 1 FROM public.billing_top_ups t WHERE t.code_id = found_code.id AND (t.business_id = target_business OR t.redeemed_by = person))
  THEN
    RETURN NULL;
  END IF;
  INSERT INTO public.billing_top_ups (business_id, source, code_id, code, redeemed_by, voice_sec, sms_seg, calls_out, chat_units, starts_at, ends_at)
  VALUES (
    target_business, 'code', found_code.id, found_code.code, person,
    found_code.voice_sec, found_code.sms_seg, found_code.calls_out, found_code.chat_units,
    now(), CASE WHEN found_code.days IS NULL THEN NULL ELSE now() + make_interval(hours => found_code.days * 24) END
  )
  RETURNING id INTO added;
  UPDATE public.billing_codes SET uses = uses + 1, updated_at = now() WHERE id = found_code.id;
  RETURN added;
END
$$;

REVOKE ALL ON FUNCTION app.redeem_billing_top_up_code(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.redeem_billing_top_up_code(text) TO lobbystack_app;
