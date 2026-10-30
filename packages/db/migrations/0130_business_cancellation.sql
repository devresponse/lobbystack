-- An owner can cancel their account's root business once it's the only
-- business they own, from its Team page. Nothing is deleted: the business is
-- marked canceled, and from then on nobody on its team can open it, its phone
-- numbers stop answering calls and texts, and its website widget, public page,
-- API keys, connected apps and invitations stop working. The owner then
-- starts again as a new account, with onboarding.
--
-- Asking emails the owner a link that works for 24 hours, and the deployment's
-- inbox a note; the owner opens the link signed in and confirms with their
-- password (business_cancellation_requests). app.cancel_business then marks
-- the business canceled. An operator brings one back with
-- app.reactivate_business, as postgres.

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS canceled_at timestamptz,
  ADD COLUMN IF NOT EXISTS canceled_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.businesses.canceled_at IS 'When an owner canceled the business (status canceled). Null for a business that isn''t canceled. Nothing of it is deleted.';
COMMENT ON COLUMN public.businesses.canceled_by_user_id IS 'The owner who confirmed the cancellation.';

-- One row each time an owner asks: the link's token (hashed), who asked, the
-- address the link went to and until when it works. Asking again replaces the
-- earlier link.
CREATE TABLE IF NOT EXISTS public.business_cancellation_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  requested_by_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  email text NOT NULL,
  token_hash text NOT NULL,
  status varchar(32) NOT NULL DEFAULT 'pending',
  expires_at timestamptz NOT NULL,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT business_cancellation_requests_status_check CHECK (status IN ('pending', 'confirmed', 'replaced'))
);

CREATE UNIQUE INDEX IF NOT EXISTS business_cancellation_requests_token_unique ON public.business_cancellation_requests (token_hash);
CREATE INDEX IF NOT EXISTS business_cancellation_requests_business_idx ON public.business_cancellation_requests (business_id, status);

ALTER TABLE public.business_cancellation_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.business_cancellation_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS business_cancellation_requests_tenant_isolation ON public.business_cancellation_requests;
CREATE POLICY business_cancellation_requests_tenant_isolation ON public.business_cancellation_requests
  USING (business_id = app.current_business_id() AND (app.current_actor_type() IN ('system', 'worker', 'dispatcher') OR app.has_business_membership(business_id)))
  WITH CHECK (business_id = app.current_business_id() AND (app.current_actor_type() IN ('system', 'worker', 'dispatcher') OR app.has_business_membership(business_id)));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.business_cancellation_requests TO lobbystack_app, lobbystack_worker;
GRANT SELECT ON public.business_cancellation_requests TO lobbystack_readonly;

-- The link carries the token, and the page it opens has no business yet.
CREATE OR REPLACE FUNCTION app.resolve_business_by_cancellation(p_token_hash text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT business_id FROM public.business_cancellation_requests WHERE token_hash = p_token_hash LIMIT 1
$$;

REVOKE ALL ON FUNCTION app.resolve_business_by_cancellation(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_business_by_cancellation(text) TO lobbystack_app;

-- Every operator read and write of a business's rows passes through this in
-- row-level security, so a business that isn't active (canceled) is closed to
-- its whole team at once: the dashboard, its API routes and the Team page.
-- The worker and system actors keep their access.
CREATE OR REPLACE FUNCTION app.has_business_membership(target_business_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.business_memberships membership
    INNER JOIN public.businesses business ON business.id = membership.business_id
    WHERE membership.business_id = target_business_id
      AND membership.user_id = app.current_user_id()
      AND membership.status = 'active'
      AND business.status = 'active'
  )
$$;

-- An invitation to a canceled business no longer opens it: its link reads as
-- invalid, and accepting it fails.
CREATE OR REPLACE FUNCTION app.resolve_business_by_invitation(p_token_hash text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT invitation.business_id
  FROM public.business_invitations invitation
  INNER JOIN public.businesses business ON business.id = invitation.business_id
  WHERE invitation.token_hash = p_token_hash AND business.status = 'active'
  LIMIT 1
$$;

-- A canceled business's numbers stay with it until they go back to Twilio,
-- but answer nothing: calls and texts to them find no business.
CREATE OR REPLACE FUNCTION app.resolve_business_by_phone(phone_e164 text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT number.business_id
  FROM public.phone_numbers number
  INNER JOIN public.businesses business ON business.id = number.business_id
  WHERE number.e164 = phone_e164 AND number.status = 'active' AND business.status = 'active'
  LIMIT 1
$$;

-- Whether a number is this deployment's but its business is canceled, so an
-- incoming call can be turned away rather than left ringing.
CREATE OR REPLACE FUNCTION app.is_closed_business_phone(phone_e164 text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.phone_numbers number
    INNER JOIN public.businesses business ON business.id = number.business_id
    WHERE number.e164 = phone_e164 AND number.status = 'active' AND business.status <> 'active'
  )
$$;

REVOKE ALL ON FUNCTION app.is_closed_business_phone(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.is_closed_business_phone(text) TO lobbystack_app;

-- The dashboard's role can't change a business's status, or when and by whom
-- it was canceled, except through app.cancel_business below.
CREATE OR REPLACE FUNCTION app.guard_business_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF current_user = 'lobbystack_app' AND (
    NEW.status IS DISTINCT FROM OLD.status
    OR NEW.canceled_at IS DISTINCT FROM OLD.canceled_at
    OR NEW.canceled_by_user_id IS DISTINCT FROM OLD.canceled_by_user_id
  ) THEN
    RAISE EXCEPTION 'A business is canceled only through app.cancel_business.'
      USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'businesses_status_change';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION app.guard_business_status() FROM PUBLIC;

DROP TRIGGER IF EXISTS businesses_status_guard ON public.businesses;
CREATE TRIGGER businesses_status_guard
  BEFORE UPDATE OF status, canceled_at, canceled_by_user_id ON public.businesses
  FOR EACH ROW EXECUTE FUNCTION app.guard_business_status();

-- Each person whose active business closes moves to another active business
-- of theirs, one they own first, or to none, which starts onboarding.
CREATE OR REPLACE FUNCTION app.move_people_off_closed_business()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF OLD.status = 'active' AND NEW.status <> 'active' THEN
    UPDATE public.users person
    SET active_business_id = (
        SELECT membership.business_id
        FROM public.business_memberships membership
        INNER JOIN public.businesses business ON business.id = membership.business_id
        WHERE membership.user_id = person.id
          AND membership.business_id <> NEW.id
          AND membership.status = 'active'
          AND business.status = 'active'
        ORDER BY membership.role = 'business_owner' DESC, membership.created_at, membership.business_id
        LIMIT 1
      ),
      updated_at = now()
    WHERE person.active_business_id = NEW.id;
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION app.move_people_off_closed_business() FROM PUBLIC;

DROP TRIGGER IF EXISTS businesses_move_people ON public.businesses;
CREATE TRIGGER businesses_move_people
  AFTER UPDATE OF status ON public.businesses
  FOR EACH ROW EXECUTE FUNCTION app.move_people_off_closed_business();

-- Cancels the business the transaction is bound to, for the signed-in owner
-- whose root it is and who owns no other business. Called last in the
-- confirming transaction: once the business is canceled, row-level security
-- closes its rows to the owner too.
CREATE OR REPLACE FUNCTION app.cancel_business(p_business_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_user_id uuid := app.current_user_id();
  v_owned integer;
BEGIN
  -- Inside SECURITY DEFINER current_user is the owner, so read the setting
  -- that app.current_actor_type() checks; only lobbystack_app can execute this.
  IF v_user_id IS NULL
    OR p_business_id IS DISTINCT FROM app.current_business_id()
    OR current_setting('app.actor_type', true) IS DISTINCT FROM 'operator'
    OR NOT EXISTS (
      SELECT 1
      FROM public.business_memberships membership
      WHERE membership.business_id = p_business_id
        AND membership.user_id = v_user_id
        AND membership.role = 'business_owner'
        AND membership.status = 'active'
    ) THEN
    RAISE EXCEPTION 'Only an owner of the business can cancel it.'
      USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'businesses_owner_cancel';
  END IF;
  PERFORM 1 FROM public.businesses WHERE id = p_business_id AND status = 'active' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The business is already canceled.'
      USING ERRCODE = 'object_not_in_prerequisite_state', CONSTRAINT = 'businesses_already_canceled';
  END IF;
  SELECT count(*) INTO v_owned FROM app.list_user_businesses(v_user_id) WHERE role = 'business_owner';
  IF v_owned <> 1 OR app.root_business_id(v_user_id) IS DISTINCT FROM p_business_id THEN
    RAISE EXCEPTION 'An account is canceled only once its root business is the only business it owns.'
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'businesses_cancel_other_owned';
  END IF;
  UPDATE public.businesses
  SET status = 'canceled', canceled_at = now(), canceled_by_user_id = v_user_id, updated_at = now()
  WHERE id = p_business_id;
END
$$;

REVOKE ALL ON FUNCTION app.cancel_business(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.cancel_business(uuid) TO lobbystack_app;

-- For the deployment's operator, signed in to the database as postgres:
-- opens a canceled business again to its team, and keeps the numbers that the
-- cancellation had set to go back to Twilio. Its paid plan stays ended.
CREATE OR REPLACE FUNCTION app.reactivate_business(p_business_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  UPDATE public.businesses
  SET status = 'active', canceled_at = NULL, canceled_by_user_id = NULL, updated_at = now()
  WHERE id = p_business_id AND status = 'canceled';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No canceled business has the id %.', p_business_id;
  END IF;
  UPDATE public.phone_numbers
  SET reclaim_scheduled_at = NULL, reclaim_reason = NULL, updated_at = now()
  WHERE business_id = p_business_id AND status = 'active' AND reclaim_reason = 'cancellation';
  INSERT INTO public.audit_logs (business_id, event_type, entity_type, entity_id, payload)
  VALUES (p_business_id, 'business.reactivated', 'business', p_business_id, jsonb_build_object('actor', 'operator'));
END
$$;

REVOKE ALL ON FUNCTION app.reactivate_business(uuid) FROM PUBLIC;

-- The worker keeps only a closed business's housekeeping jobs: retention,
-- upload cleanup and its numbers' release. A closed business is never active.
DROP FUNCTION IF EXISTS app.list_scheduler_businesses();

CREATE FUNCTION app.list_scheduler_businesses()
RETURNS TABLE (business_id uuid, active boolean, closed boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT b.id,
    b.status = 'active'
    AND EXISTS (SELECT 1 FROM public.business_memberships m WHERE m.business_id = b.id AND m.status = 'active')
    AND (
      b.onboarding_stage = 'complete'
      OR EXISTS (SELECT 1 FROM public.calls c WHERE c.business_id = b.id AND c.started_at > now() - interval '30 days')
      OR EXISTS (SELECT 1 FROM public.messages msg WHERE msg.business_id = b.id AND msg.created_at > now() - interval '30 days')
      OR EXISTS (
        SELECT 1
        FROM public.business_memberships m
        JOIN public.sessions s ON s.user_id = m.user_id
        WHERE m.business_id = b.id
          AND m.status = 'active'
          AND greatest(s.created_at, s.updated_at) > now() - interval '30 days'
      )
    ),
    b.status <> 'active'
  FROM public.businesses b
  WHERE session_user = 'lobbystack_dispatcher'
    AND NULLIF(current_setting('app.actor_type', true), '') = 'dispatcher'
$$;

REVOKE ALL ON FUNCTION app.list_scheduler_businesses() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.list_scheduler_businesses() TO lobbystack_dispatcher;
