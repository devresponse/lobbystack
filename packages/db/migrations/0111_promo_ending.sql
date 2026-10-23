-- Promo endings: a time-limited plan ends at the subscription's first renewal
-- on or after plan_ends. A week before, the worker emails the business's
-- owners and tells Polar what that renewal does: the subscription moves to its
-- tier's standard product without the plan's discount, or it cancels. A plan
-- whose ending is keep never ends, so it has no plan_ends.
--
-- end_with is an operator's choice that replaces the plan's own ending, set
-- when an operator ends a plan early. end_notice_at and end_set_at record the
-- two steps, so the daily check does each once per ending.

ALTER TABLE public.billing_accounts
  ADD COLUMN IF NOT EXISTS end_with varchar(8) CHECK (end_with IN ('tier', 'cancel')),
  ADD COLUMN IF NOT EXISTS end_notice_at timestamptz,
  ADD COLUMN IF NOT EXISTS end_set_at timestamptz;

COMMENT ON COLUMN public.billing_accounts.end_with IS 'What ends the plan when an operator chose it: tier or cancel. Null means the plan''s own ending.';
COMMENT ON COLUMN public.billing_accounts.end_notice_at IS 'When the owners were emailed that the plan ends.';
COMMENT ON COLUMN public.billing_accounts.end_set_at IS 'When Polar was told to change or cancel the subscription at the renewal that ends the plan.';

-- The owners to email about a business's billing, with what the email needs:
-- their language and the business's name and time zone. Only the worker, in
-- that business's transaction, finds anyone.
CREATE OR REPLACE FUNCTION app.billing_owner_recipients(target_business_id uuid)
RETURNS TABLE(user_id uuid, email text, name text, preferred_locale text, business_name text, timezone text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT u.id, u.email, u.name, u.preferred_locale::text, b.name, b.timezone::text
  FROM public.businesses b
  JOIN public.business_memberships m ON m.business_id = b.id AND m.role = 'business_owner' AND m.status = 'active'
  JOIN public.users u ON u.id = m.user_id
  WHERE session_user = 'lobbystack_worker'
    AND NULLIF(current_setting('app.actor_type', true), '') = 'worker'
    AND target_business_id = NULLIF(current_setting('app.business_id', true), '')::uuid
    AND b.id = target_business_id
  ORDER BY m.created_at, u.id
$$;

REVOKE ALL ON FUNCTION app.billing_owner_recipients(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.billing_owner_recipients(uuid) TO lobbystack_worker;
