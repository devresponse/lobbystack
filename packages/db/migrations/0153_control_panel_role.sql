-- The control panel (docs/features/control-panel.md) shows the deployment's
-- operator every business and account, and changes nothing. It signs in to
-- the database as lobbystack_control, which this migration makes and which
-- db bootstrap gives a login once LOBBYSTACK_CONTROL_PASSWORD is set, as it
-- does for lobbystack_finance_export.
--
-- What keeps it read-only is what it is granted: SELECT on the columns named
-- below, USAGE on schema public, and nothing else. Row-level security alone
-- would not: the tenant policies apply to every role and accept whatever
-- app.business_id a session sets, so a role with a write grant could write.
-- The role gets no USAGE on schema app either, so none of the SECURITY
-- DEFINER functions there can run as it. Its sessions also start read-only,
-- with time limits, which a session could turn off but which keep a mistake
-- in the panel from writing or holding locks.
--
-- Columns that hold secrets, or what callers and visitors said, stay out:
-- password hashes, sign-in and provider tokens, session tokens, IP addresses,
-- message bodies, transcripts, callers' numbers and recordings. Each table
-- gets a policy that shows the role every row, as the finance export's do.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lobbystack_control') THEN
    CREATE ROLE lobbystack_control NOLOGIN NOBYPASSRLS;
  END IF;
END $$;

-- One copy of the panel holds at most 3 connections, and a release briefly
-- runs the old copy beside the new one.
ALTER ROLE lobbystack_control NOBYPASSRLS CONNECTION LIMIT 6;
ALTER ROLE lobbystack_control SET default_transaction_read_only = on;
ALTER ROLE lobbystack_control SET statement_timeout = '15s';
ALTER ROLE lobbystack_control SET lock_timeout = '2s';
ALTER ROLE lobbystack_control SET idle_in_transaction_session_timeout = '60s';

GRANT USAGE ON SCHEMA public TO lobbystack_control;

GRANT SELECT (id, slug, name, legal_name, timezone, default_locale, business_type, deployment_mode, status,
  website_url, onboarding_stage, onboarding_attribution, canceled_at, created_at, updated_at)
  ON public.businesses TO lobbystack_control;
GRANT SELECT (business_id, published, published_at, category, address_line1, address_line2, city, region,
  postal_code, country_code, public_email, updated_at)
  ON public.business_public_profiles TO lobbystack_control;
GRANT SELECT (id, name, email, email_verified, phone, phone_verified_at, platform_role, preferred_locale,
  created_by_partner_id, created_at, updated_at)
  ON public.users TO lobbystack_control;
-- Only which ways an account signs in, never what with.
GRANT SELECT (id, user_id, provider_id, created_at) ON public.accounts TO lobbystack_control;
-- When an account signed in and was last seen, never the token, address or browser.
GRANT SELECT (id, user_id, expires_at, created_at, updated_at) ON public.sessions TO lobbystack_control;
GRANT SELECT (id, business_id, user_id, role, status, created_at) ON public.business_memberships TO lobbystack_control;
GRANT SELECT (id, business_id, email, role, status, expires_at, transfers_ownership, created_at)
  ON public.business_invitations TO lobbystack_control;
GRANT SELECT (id, business_id, e164, voice_enabled, sms_enabled, status, reclaim_scheduled_at, voice_webhook_status,
  sms_webhook_status, receptionist_id, created_at)
  ON public.phone_numbers TO lobbystack_control;
GRANT SELECT (id, business_id, name, handle, is_default, status, locale, listed, booking_mode, transfer_mode,
  archived_at, created_at)
  ON public.receptionist_profiles TO lobbystack_control;
GRANT SELECT (business_id, source, customer_id, subscription_id, plan, plan_code, billing_interval, subscription_state,
  current_period_start, current_period_end, overage_spending_cap_cents, plan_ends, cancel_at, next_plan_code,
  next_interval, next_change_at, created_at, updated_at)
  ON public.billing_accounts TO lobbystack_control;
GRANT SELECT (code, tier, status, access, names, sold, custom, overage, voice_sec, sms_seg, calls_out, chat_units,
  numbers, receptionists, months, sort)
  ON public.billing_plans TO lobbystack_control;
GRANT SELECT (business_id, period_key, plan_at_snapshot, voice_seconds_used, alert_sms_segments_used,
  outbound_call_attempts_used, chat_ai_tokens_used, voice_blocked, alert_sms_blocked, outbound_call_attempts_blocked,
  chat_ai_tokens_blocked, overage_spend_cents, last_recorded_at)
  ON public.billing_usage_months TO lobbystack_control;
GRANT SELECT (id, business_id, kind, status, amount_cents, refunded_amount_cents, currency, description, occurred_at)
  ON public.billing_transactions TO lobbystack_control;
GRANT SELECT (id, business_id, pack, days, provider, amount_cents, currency, seconds_total, seconds_used, sms_seg,
  sms_used, calls_out, calls_used, chat_units, chat_used, paid_at, ends_at, status, refunded_cents, ended_at)
  ON public.billing_packs TO lobbystack_control;
GRANT SELECT (business_id, month_key, total_cost_usd, provider_cost_usd, ai_cost_usd, infra_cost_usd, voice_cost_usd,
  sms_cost_usd, alert_sms_cost_usd, voice_call_count, voice_minutes, outbound_sms_count, sms_thread_count,
  active_user_count, recomputed_at)
  ON public.unit_economics_rollups TO lobbystack_control;
-- Calls, chats, texts and bookings are counted and timed, never read.
GRANT SELECT (id, business_id, transport, provider, status, disposition, session_purpose, billing_excluded, started_at,
  ended_at, provider_duration_seconds, provider_cost_usd, receptionist_id, archived_at)
  ON public.calls TO lobbystack_control;
GRANT SELECT (id, business_id, channel, status, created_at) ON public.conversations TO lobbystack_control;
GRANT SELECT (id, business_id, direction, channel, status, sender_role, ai_generated, provider_cost_usd,
  provider_num_segments, created_at)
  ON public.messages TO lobbystack_control;
GRANT SELECT (id, business_id, status, source_channel, starts_at, created_at) ON public.appointments TO lobbystack_control;
GRANT SELECT (app_name) ON public.deployment_branding TO lobbystack_control;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'businesses', 'business_public_profiles', 'users', 'accounts', 'sessions', 'business_memberships',
    'business_invitations', 'phone_numbers', 'receptionist_profiles', 'billing_accounts', 'billing_plans',
    'billing_usage_months', 'billing_transactions', 'billing_packs', 'unit_economics_rollups', 'calls',
    'conversations', 'messages', 'appointments', 'deployment_branding'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', table_name || '_control_select', table_name);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO lobbystack_control USING (true)', table_name || '_control_select', table_name);
  END LOOP;
END $$;
