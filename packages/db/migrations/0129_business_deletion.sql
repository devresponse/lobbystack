-- An owner can permanently delete a business they own from the dashboard,
-- along with everything in it, but never an account's root business: the
-- business each owner has owned longest, the first one for a normal sign-up.
-- Only a business that isn't any owner's root can go, so an owner needs
-- another, older business to delete one.
--
-- The dashboard and API role (lobbystack_app) may delete a business only as
-- an operator who is its active owner, and never a root business. The worker
-- and migrator roles keep their deletes for test fixtures and repair scripts.
-- Once a business is deleted, its OAuth grants go, and anyone whose active
-- business it was moves to another of theirs.

SET LOCAL lock_timeout = '5s';

-- The business an account has owned longest: its earliest active owner
-- membership, among the businesses its workspace list shows (closed demos
-- left out, as app.list_user_businesses leaves them out). Null when it owns none.
CREATE OR REPLACE FUNCTION app.root_business_id(p_user_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT membership.business_id
  FROM public.business_memberships membership
  INNER JOIN public.businesses business ON business.id = membership.business_id
  WHERE membership.user_id = p_user_id
    AND membership.role = 'business_owner'
    AND membership.status = 'active'
    AND business.status = 'active'
    AND NOT EXISTS (
      SELECT 1
      FROM public.prospect_demos demo
      WHERE demo.business_id = business.id
        AND demo.operator_user_id = p_user_id
        AND demo.claimed_by_user_id IS DISTINCT FROM p_user_id
        AND (demo.status IN ('revoked', 'claimed') OR demo.expires_at <= now())
    )
  ORDER BY membership.created_at, business.created_at, business.id
  LIMIT 1
$$;

REVOKE ALL ON FUNCTION app.root_business_id(uuid) FROM PUBLIC;

-- Whether a business is the root business of any of its active owners.
CREATE OR REPLACE FUNCTION app.is_root_business(p_business_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.business_memberships owner
    WHERE owner.business_id = p_business_id
      AND owner.role = 'business_owner'
      AND owner.status = 'active'
      AND app.root_business_id(owner.user_id) = p_business_id
  )
$$;

REVOKE ALL ON FUNCTION app.is_root_business(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.is_root_business(uuid) TO lobbystack_app;

-- Runs as the role that deletes, so current_user names it. The owner check
-- reads business_memberships under that role's row-level security, which
-- shows only the business the transaction is bound to.
CREATE OR REPLACE FUNCTION app.guard_business_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF current_user = 'lobbystack_app' THEN
    IF app.is_root_business(OLD.id) THEN
      RAISE EXCEPTION 'A root business can''t be deleted.'
        USING ERRCODE = 'restrict_violation', CONSTRAINT = 'businesses_root_business';
    END IF;
    IF app.current_actor_type() IS DISTINCT FROM 'operator' OR NOT EXISTS (
      SELECT 1
      FROM public.business_memberships membership
      WHERE membership.business_id = OLD.id
        AND membership.user_id = app.current_user_id()
        AND membership.role = 'business_owner'
        AND membership.status = 'active'
    ) THEN
      RAISE EXCEPTION 'Only an owner of the business can delete it.'
        USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'businesses_owner_delete';
    END IF;
  END IF;
  RETURN OLD;
END
$$;

REVOKE ALL ON FUNCTION app.guard_business_delete() FROM PUBLIC;

DROP TRIGGER IF EXISTS businesses_delete_guard ON public.businesses;
CREATE TRIGGER businesses_delete_guard
  BEFORE DELETE ON public.businesses
  FOR EACH ROW EXECUTE FUNCTION app.guard_business_delete();

-- Rows that name a deleted business without a foreign key: OAuth grants keep
-- the business id in reference_id, and users.active_business_id has none.
-- Each person whose active business it was moves to another active business
-- of theirs, one they own first, or to none.
CREATE OR REPLACE FUNCTION app.clear_deleted_business_references()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  DELETE FROM public.oauth_access_tokens WHERE reference_id = OLD.id::text;
  DELETE FROM public.oauth_refresh_tokens WHERE reference_id = OLD.id::text;
  DELETE FROM public.oauth_consents WHERE reference_id = OLD.id::text;
  UPDATE public.users person
  SET active_business_id = (
      SELECT membership.business_id
      FROM public.business_memberships membership
      INNER JOIN public.businesses business ON business.id = membership.business_id
      WHERE membership.user_id = person.id
        AND membership.business_id <> OLD.id
        AND membership.status = 'active'
        AND business.status = 'active'
      ORDER BY membership.role = 'business_owner' DESC, membership.created_at, membership.business_id
      LIMIT 1
    ),
    updated_at = now()
  WHERE person.active_business_id = OLD.id;
  RETURN OLD;
END
$$;

REVOKE ALL ON FUNCTION app.clear_deleted_business_references() FROM PUBLIC;

DROP TRIGGER IF EXISTS businesses_clear_references ON public.businesses;
CREATE TRIGGER businesses_clear_references
  AFTER DELETE ON public.businesses
  FOR EACH ROW EXECUTE FUNCTION app.clear_deleted_business_references();

-- The workspace list says which businesses can't be deleted: is_root when the
-- business is any owner's root, and is_account_root when it's the caller's
-- own. Adding columns changes the result type, which CREATE OR REPLACE can't do.
DROP FUNCTION IF EXISTS app.list_user_businesses(uuid);

CREATE FUNCTION app.list_user_businesses(p_user_id uuid)
RETURNS TABLE (
  business_id uuid,
  name text,
  slug varchar,
  role varchar,
  timezone varchar,
  business_type varchar,
  default_locale varchar,
  website_url text,
  onboarding_stage varchar,
  created_at timestamptz,
  is_root boolean,
  is_account_root boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT business.id, business.name, business.slug, membership.role,
    business.timezone, business.business_type, business.default_locale,
    business.website_url, business.onboarding_stage, business.created_at,
    app.is_root_business(business.id),
    business.id = app.root_business_id(p_user_id)
  FROM public.business_memberships membership
  INNER JOIN public.businesses business ON business.id = membership.business_id
  WHERE membership.user_id = p_user_id
    AND p_user_id = app.current_user_id()
    AND membership.status = 'active'
    AND business.status = 'active'
    AND NOT EXISTS (
      SELECT 1
      FROM public.prospect_demos demo
      WHERE demo.business_id = business.id
        AND demo.operator_user_id = p_user_id
        AND demo.claimed_by_user_id IS DISTINCT FROM p_user_id
        AND (demo.status IN ('revoked', 'claimed') OR demo.expires_at <= now())
    )
  ORDER BY business.name
$$;

REVOKE ALL ON FUNCTION app.list_user_businesses(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.list_user_businesses(uuid) TO lobbystack_app;
