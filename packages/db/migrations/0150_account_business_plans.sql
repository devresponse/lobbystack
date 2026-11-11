-- Businesses per account by plan (docs/features/multitenancy.md). A brand's
-- billing.json can give each plan its own cap (accounts.maxBusinessesByPlan),
-- and an account may own as many businesses as the best plan among them
-- allows. Checking that needs the plan of every business the account owns,
-- while the transaction that creates or claims a business is bound to that
-- one business, so row-level security shows no other business's billing.
--
-- app.list_user_business_plans gives the signed-in account, and only that
-- account, one row for each open business it owns, as the workspace list and
-- the limit count them (app.list_user_businesses): the billing account's plan
-- columns, and whether a prepaid pack has time left. It decides nothing: the
-- app works out each plan in force from them the way usage does (usage.ts),
-- so that rule stays in one place. Nothing else changes, so a deployment whose
-- billing.json sets no cap per plan behaves as before.

SET LOCAL lock_timeout = '5s';

CREATE FUNCTION app.list_user_business_plans(p_user_id uuid)
RETURNS TABLE (
  business_id uuid,
  deployment_mode varchar,
  plan varchar,
  plan_code varchar,
  subscription_state varchar,
  subscription_id text,
  replaced_subscription_id text,
  live_pack boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT owned.business_id, business.deployment_mode, account.plan, account.plan_code,
    account.subscription_state, account.subscription_id, account.replaced_subscription_id,
    EXISTS (
      SELECT 1
      FROM public.billing_packs pack
      WHERE pack.business_id = owned.business_id
        AND pack.status = 'active'
        AND (pack.ends_at IS NULL OR pack.ends_at > now())
    )
  FROM app.list_user_businesses(p_user_id) owned
  INNER JOIN public.businesses business ON business.id = owned.business_id
  LEFT JOIN public.billing_accounts account ON account.business_id = owned.business_id
  WHERE owned.role = 'business_owner'
  ORDER BY owned.business_id
$$;

COMMENT ON FUNCTION app.list_user_business_plans(uuid) IS 'Each open business the signed-in account owns, with its billing account''s plan columns and whether a prepaid pack has time left, for the business cap per plan. Returns nothing for any other account.';

REVOKE ALL ON FUNCTION app.list_user_business_plans(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.list_user_business_plans(uuid) TO lobbystack_app;
