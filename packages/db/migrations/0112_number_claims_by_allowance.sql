-- A dedicated number needs a plan that includes one: the number claims now
-- ask how many numbers the business's plan includes, as the dashboard's limits
-- do, instead of checking for the Starter, Pro or Enterprise names. A billing
-- catalog can then give any plan numbers, or none, and a new plan needs no
-- change here. Each function below is the one from 0084, 0026 and 0094 with
-- only that check changed.

-- How many dedicated numbers a business's plan includes, by the same rule as
-- limitsFor and billingPlanLimits in packages/domain/src/server/billingPlans.ts.
-- The plan in force is the account's plan while its subscription is live (Free
-- needs none), else Free. Once the catalog holds a Starter or Pro row, a promo
-- plan of that tier uses its own row, and the tier its row; a tier without a
-- row, or a deployment before its first apply, uses this build's plans: none
-- on Free, one on Starter and Pro. Null means no limit. Only the claim
-- functions, which run as their owner, call it.
CREATE OR REPLACE FUNCTION app.business_included_numbers(target_business_id uuid)
RETURNS integer LANGUAGE plpgsql STABLE SET search_path = public, pg_catalog AS $$
DECLARE account_plan text; account_code text; account_state text; plan_tier text; included integer;
BEGIN
  SELECT plan, plan_code, subscription_state INTO account_plan, account_code, account_state FROM public.billing_accounts WHERE business_id = target_business_id;
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

CREATE OR REPLACE FUNCTION app.reserve_onboarding_number_claim(target_business_id uuid, target_user_id uuid, target_e164 text, selection jsonb, token_hash text, request_key text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app, pg_catalog AS $$
DECLARE claim_id uuid; business_row public.businesses%ROWTYPE;
BEGIN
  IF session_user <> 'lobbystack_app' OR target_user_id <> NULLIF(current_setting('app.user_id', true), '')::uuid OR target_business_id <> NULLIF(current_setting('app.business_id', true), '')::uuid OR NOT app.has_business_membership(target_business_id) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('phone-claim:' || target_business_id::text, 0));
  SELECT id INTO claim_id FROM public.onboarding_number_claim_events WHERE business_id = target_business_id AND idempotency_key = request_key;
  IF claim_id IS NOT NULL THEN RETURN claim_id; END IF;
  UPDATE public.onboarding_number_claim_events SET status = 'failed', completed_at = now(), last_error = CASE WHEN status = 'reserved' THEN 'Number claim reservation expired.' ELSE 'Number provisioning stalled.' END, updated_at = now()
    WHERE business_id = target_business_id AND purpose = 'onboarding'
      AND ((status = 'reserved' AND reserved_at <= now() - interval '15 minutes') OR (status = 'provisioning' AND updated_at <= now() - interval '30 minutes'));
  IF EXISTS (SELECT 1 FROM public.onboarding_number_claim_events WHERE business_id = target_business_id AND purpose = 'onboarding' AND status IN ('reserved','provisioning')) THEN RAISE EXCEPTION 'number_claim_in_progress' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO business_row FROM public.businesses WHERE id = target_business_id;
  IF business_row.onboarding_stage NOT IN ('plan','phone_number','attribution','complete') THEN RAISE EXCEPTION 'invalid_onboarding_stage' USING ERRCODE = 'P0001'; END IF;
  IF EXISTS (SELECT 1 FROM public.phone_numbers WHERE business_id = target_business_id AND status IN ('active','provisioning')) THEN RAISE EXCEPTION 'business_number_exists' USING ERRCODE = 'P0001'; END IF;
  IF business_row.deployment_mode = 'cloud' AND app.business_included_numbers(target_business_id) = 0 THEN RAISE EXCEPTION 'dedicated_number_requires_paid_plan' USING ERRCODE = 'P0001'; END IF;
  IF (SELECT count(*) FROM public.onboarding_number_claim_events WHERE user_id = target_user_id AND reserved_at >= now() - interval '1 hour') >= 3 THEN RAISE EXCEPTION 'number_claim_rate_limited' USING ERRCODE = 'P0001'; END IF;
  IF (SELECT count(*) FROM public.onboarding_number_claim_events WHERE user_id = target_user_id AND status = 'claimed' AND purchased_at >= now() - interval '1 day') >= 2 THEN RAISE EXCEPTION 'daily_claim_quota_reached' USING ERRCODE = 'P0001'; END IF;
  IF (SELECT count(*) FROM public.onboarding_number_claim_events WHERE user_id = target_user_id AND status = 'claimed' AND purchased_at >= now() - interval '30 days') >= 5 THEN RAISE EXCEPTION 'monthly_claim_quota_reached' USING ERRCODE = 'P0001'; END IF;
  INSERT INTO public.onboarding_number_claim_events(business_id,user_id,requested_e164,selection_context,claim_token_hash,idempotency_key,status) VALUES(target_business_id,target_user_id,target_e164,selection,token_hash,request_key,'reserved') ON CONFLICT (business_id,idempotency_key) DO UPDATE SET updated_at = onboarding_number_claim_events.updated_at RETURNING id INTO claim_id;
  UPDATE public.businesses SET onboarding_stage = CASE WHEN onboarding_stage IN ('attribution','complete') THEN onboarding_stage ELSE 'phone_number_claiming' END, updated_at = now() WHERE id = target_business_id;
  RETURN claim_id;
END $$;
REVOKE ALL ON FUNCTION app.reserve_onboarding_number_claim(uuid,uuid,text,jsonb,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reserve_onboarding_number_claim(uuid,uuid,text,jsonb,text,text) TO lobbystack_app;

CREATE OR REPLACE FUNCTION app.reserve_replacement_number_claim(target_business_id uuid, target_user_id uuid, target_e164 text, selection jsonb, token_hash text, request_key text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app, pg_catalog AS $$
DECLARE claim_id uuid; claim_reserved_at timestamptz; old_number_id uuid; old_number_e164 text; business_row public.businesses%ROWTYPE;
BEGIN
  IF session_user <> 'lobbystack_app' OR target_user_id <> NULLIF(current_setting('app.user_id', true), '')::uuid OR target_business_id <> NULLIF(current_setting('app.business_id', true), '')::uuid OR NOT app.has_business_membership(target_business_id) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('phone-claim:' || target_business_id::text, 0));
  SELECT id INTO claim_id FROM public.onboarding_number_claim_events WHERE business_id = target_business_id AND idempotency_key = request_key;
  IF claim_id IS NOT NULL THEN RETURN claim_id; END IF;
  UPDATE public.onboarding_number_claim_events SET status = 'failed', completed_at = now(), last_error = 'Number replacement reservation expired.', updated_at = now()
    WHERE business_id = target_business_id AND purpose = 'replacement' AND status = 'reserved' AND reserved_at <= now() - interval '15 minutes';
  SELECT * INTO business_row FROM public.businesses WHERE id = target_business_id;
  IF business_row.phone_number_replacement_used_at IS NOT NULL THEN RAISE EXCEPTION 'replacement_already_used' USING ERRCODE = 'P0001'; END IF;
  IF EXISTS (SELECT 1 FROM public.onboarding_number_claim_events WHERE business_id = target_business_id AND purpose = 'replacement' AND status IN ('reserved','provisioning')) THEN RAISE EXCEPTION 'replacement_already_reserved' USING ERRCODE = 'P0001'; END IF;
  SELECT id, e164 INTO old_number_id, old_number_e164 FROM public.phone_numbers WHERE business_id = target_business_id AND status = 'active' AND reclaim_scheduled_at IS NULL ORDER BY created_at DESC LIMIT 1;
  IF old_number_id IS NULL THEN RAISE EXCEPTION 'active_number_required' USING ERRCODE = 'P0001'; END IF;
  IF old_number_e164 = target_e164 THEN RAISE EXCEPTION 'replacement_number_must_differ' USING ERRCODE = 'P0001'; END IF;
  IF business_row.deployment_mode = 'cloud' AND app.business_included_numbers(target_business_id) = 0 THEN RAISE EXCEPTION 'dedicated_number_requires_paid_plan' USING ERRCODE = 'P0001'; END IF;
  IF (SELECT count(*) FROM public.onboarding_number_claim_events WHERE user_id = target_user_id AND reserved_at >= now() - interval '1 hour') >= 3 THEN RAISE EXCEPTION 'number_claim_rate_limited' USING ERRCODE = 'P0001'; END IF;
  IF (SELECT count(*) FROM public.onboarding_number_claim_events WHERE user_id = target_user_id AND status = 'claimed' AND purchased_at >= now() - interval '1 day') >= 2 THEN RAISE EXCEPTION 'daily_claim_quota_reached' USING ERRCODE = 'P0001'; END IF;
  IF (SELECT count(*) FROM public.onboarding_number_claim_events WHERE user_id = target_user_id AND status = 'claimed' AND purchased_at >= now() - interval '30 days') >= 5 THEN RAISE EXCEPTION 'monthly_claim_quota_reached' USING ERRCODE = 'P0001'; END IF;
  INSERT INTO public.onboarding_number_claim_events(business_id,user_id,purpose,replacing_phone_number_id,requested_e164,selection_context,claim_token_hash,idempotency_key,status) VALUES(target_business_id,target_user_id,'replacement',old_number_id,target_e164,selection,token_hash,request_key,'reserved') RETURNING id, reserved_at INTO claim_id, claim_reserved_at;
  UPDATE public.businesses SET phone_number_replacement_reserved_at = claim_reserved_at, updated_at = now() WHERE id = target_business_id;
  RETURN claim_id;
END $$;
REVOKE ALL ON FUNCTION app.reserve_replacement_number_claim(uuid,uuid,text,jsonb,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reserve_replacement_number_claim(uuid,uuid,text,jsonb,text,text) TO lobbystack_app;

CREATE OR REPLACE FUNCTION app.reserve_api_number_claim(target_business_id uuid, target_user_id uuid, claim_purpose text, replacing_number_id uuid, target_e164 text, selection jsonb, token_hash text, request_key text, quota_by_business boolean)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app, pg_catalog AS $$
DECLARE claim_id uuid; claim_reserved_at timestamptz; old_number_e164 text; business_row public.businesses%ROWTYPE;
BEGIN
  -- Inside SECURITY DEFINER current_user is the owner, so read the caller's
  -- settings. Only lobbystack_worker, which serves /api/v1, may execute this.
  IF NULLIF(current_setting('app.actor_type', true), '') IS DISTINCT FROM 'worker'
    OR target_business_id IS DISTINCT FROM NULLIF(current_setting('app.business_id', true), '')::uuid
    OR target_user_id IS NULL
    OR quota_by_business IS NULL
    OR COALESCE(claim_purpose, '') NOT IN ('onboarding', 'replacement')
    OR (claim_purpose = 'replacement') <> (replacing_number_id IS NOT NULL) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('phone-claim:' || target_business_id::text, 0));
  SELECT id INTO claim_id FROM public.onboarding_number_claim_events WHERE business_id = target_business_id AND idempotency_key = request_key;
  IF claim_id IS NOT NULL THEN RETURN claim_id; END IF;
  SELECT * INTO business_row FROM public.businesses WHERE id = target_business_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  IF claim_purpose = 'onboarding' THEN
    UPDATE public.onboarding_number_claim_events SET status = 'failed', completed_at = now(), last_error = CASE WHEN status = 'reserved' THEN 'Number claim reservation expired.' ELSE 'Number provisioning stalled.' END, updated_at = now()
      WHERE business_id = target_business_id AND purpose = 'onboarding'
        AND ((status = 'reserved' AND reserved_at <= now() - interval '15 minutes') OR (status = 'provisioning' AND updated_at <= now() - interval '30 minutes'));
    IF EXISTS (SELECT 1 FROM public.onboarding_number_claim_events WHERE business_id = target_business_id AND purpose = 'onboarding' AND status IN ('reserved','provisioning')) THEN RAISE EXCEPTION 'number_claim_in_progress' USING ERRCODE = 'P0001'; END IF;
    IF EXISTS (SELECT 1 FROM public.phone_numbers WHERE business_id = target_business_id AND status IN ('active','provisioning')) THEN RAISE EXCEPTION 'business_number_exists' USING ERRCODE = 'P0001'; END IF;
  ELSE
    UPDATE public.onboarding_number_claim_events SET status = 'failed', completed_at = now(), last_error = 'Number replacement reservation expired.', updated_at = now()
      WHERE business_id = target_business_id AND purpose = 'replacement' AND status = 'reserved' AND reserved_at <= now() - interval '15 minutes';
    IF business_row.phone_number_replacement_used_at IS NOT NULL THEN RAISE EXCEPTION 'replacement_already_used' USING ERRCODE = 'P0001'; END IF;
    IF EXISTS (SELECT 1 FROM public.onboarding_number_claim_events WHERE business_id = target_business_id AND purpose = 'replacement' AND status IN ('reserved','provisioning')) THEN RAISE EXCEPTION 'replacement_already_reserved' USING ERRCODE = 'P0001'; END IF;
    SELECT e164 INTO old_number_e164 FROM public.phone_numbers WHERE id = replacing_number_id AND business_id = target_business_id AND status = 'active' AND reclaim_scheduled_at IS NULL;
    IF old_number_e164 IS NULL THEN RAISE EXCEPTION 'active_number_required' USING ERRCODE = 'P0001'; END IF;
    IF old_number_e164 = target_e164 THEN RAISE EXCEPTION 'replacement_number_must_differ' USING ERRCODE = 'P0001'; END IF;
  END IF;
  IF business_row.deployment_mode = 'cloud' AND app.business_included_numbers(target_business_id) = 0 THEN RAISE EXCEPTION 'dedicated_number_requires_paid_plan' USING ERRCODE = 'P0001'; END IF;
  IF (SELECT count(*) FROM public.onboarding_number_claim_events WHERE (CASE WHEN quota_by_business THEN business_id = target_business_id ELSE user_id = target_user_id END) AND reserved_at >= now() - interval '1 hour') >= 3 THEN RAISE EXCEPTION 'number_claim_rate_limited' USING ERRCODE = 'P0001'; END IF;
  IF (SELECT count(*) FROM public.onboarding_number_claim_events WHERE (CASE WHEN quota_by_business THEN business_id = target_business_id ELSE user_id = target_user_id END) AND status = 'claimed' AND purchased_at >= now() - interval '1 day') >= 2 THEN RAISE EXCEPTION 'daily_claim_quota_reached' USING ERRCODE = 'P0001'; END IF;
  IF (SELECT count(*) FROM public.onboarding_number_claim_events WHERE (CASE WHEN quota_by_business THEN business_id = target_business_id ELSE user_id = target_user_id END) AND status = 'claimed' AND purchased_at >= now() - interval '30 days') >= 5 THEN RAISE EXCEPTION 'monthly_claim_quota_reached' USING ERRCODE = 'P0001'; END IF;
  INSERT INTO public.onboarding_number_claim_events(business_id, user_id, purpose, replacing_phone_number_id, requested_e164, selection_context, claim_token_hash, idempotency_key, status)
    VALUES (target_business_id, target_user_id, claim_purpose, replacing_number_id, target_e164, selection, token_hash, request_key, 'reserved')
    RETURNING id, reserved_at INTO claim_id, claim_reserved_at;
  IF claim_purpose = 'onboarding' THEN
    UPDATE public.businesses SET onboarding_stage = CASE WHEN onboarding_stage IN ('attribution','complete') THEN onboarding_stage ELSE 'phone_number_claiming' END, updated_at = now() WHERE id = target_business_id;
  ELSE
    UPDATE public.businesses SET phone_number_replacement_reserved_at = claim_reserved_at, updated_at = now() WHERE id = target_business_id;
  END IF;
  RETURN claim_id;
END $$;
REVOKE ALL ON FUNCTION app.reserve_api_number_claim(uuid, uuid, text, uuid, text, jsonb, text, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reserve_api_number_claim(uuid, uuid, text, uuid, text, jsonb, text, text, boolean) TO lobbystack_worker;
