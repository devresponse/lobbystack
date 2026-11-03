-- QR short links and more receptionists. An entry link is a short address,
-- /q/<code>, that a printed sign carries: it opens one receptionist's page,
-- or the business page for the default receptionist. A paused link, or one
-- whose receptionist is paused or archived, opens the business page, so a
-- printed sign always reaches someone. Codes are unique across the
-- deployment; a 6-character one keeps a sign's address short enough to leave
-- room for a logo in the QR code.
--
-- Scans are counted per link and day for the scan chart, and nothing about
-- the visitor is stored. The privacy sweep deletes days older than 13 months.
--
-- The unique index on receptionist_profiles.business_id, kept by 0133 for the
-- upsert of the code from before receptionists, goes: a business can now have
-- more than one receptionist. (Deploying this together with 0133 means an AI
-- settings save in the previous release fails until the new release serves.)

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.entry_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  receptionist_id uuid NOT NULL,
  -- Lower-case letters and digits; the dashboard makes 6-character codes.
  code varchar(12) NOT NULL CHECK (code ~ '^[a-z0-9]{4,12}$'),
  -- Where the sign hangs, such as "Front window", for the owner.
  label varchar(80) NOT NULL DEFAULT '',
  status varchar(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  created_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT entry_links_receptionist_fk FOREIGN KEY (business_id, receptionist_id)
    REFERENCES public.receptionist_profiles (business_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS entry_links_code_unique ON public.entry_links (code);
CREATE UNIQUE INDEX IF NOT EXISTS entry_links_business_id_unique ON public.entry_links (business_id, id);
CREATE INDEX IF NOT EXISTS entry_links_business_created_idx ON public.entry_links (business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS entry_links_business_receptionist_idx ON public.entry_links (business_id, receptionist_id);

CREATE TABLE IF NOT EXISTS public.entry_link_daily_scans (
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  entry_link_id uuid NOT NULL,
  day date NOT NULL,
  scans integer NOT NULL DEFAULT 0 CHECK (scans >= 0),
  PRIMARY KEY (entry_link_id, day),
  CONSTRAINT entry_link_daily_scans_link_fk FOREIGN KEY (business_id, entry_link_id)
    REFERENCES public.entry_links (business_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS entry_link_daily_scans_business_day_idx ON public.entry_link_daily_scans (business_id, day);

DO $$
DECLARE
  name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['entry_links', 'entry_link_daily_scans'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', name);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', name || '_tenant_isolation', name);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I
         USING (business_id = app.current_business_id() AND (app.current_actor_type() IN (''system'', ''worker'', ''dispatcher'') OR app.has_business_membership(business_id)))
         WITH CHECK (business_id = app.current_business_id() AND (app.current_actor_type() IN (''system'', ''worker'', ''dispatcher'') OR app.has_business_membership(business_id)))',
      name || '_tenant_isolation', name);
    -- The dashboard manages links; the public /q/<code> route counts scans as the worker role.
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO lobbystack_app, lobbystack_worker', name);
    EXECUTE format('GRANT SELECT ON public.%I TO lobbystack_readonly', name);
  END LOOP;
END
$$;

COMMENT ON TABLE public.entry_links IS 'QR short links, /q/<code>: each opens one receptionist''s page, or the business page when it or its receptionist is paused or archived.';
COMMENT ON TABLE public.entry_link_daily_scans IS 'Scans of each entry link per UTC day. Nothing about the visitor is stored; kept 13 months.';

-- The link behind a code, found before the request knows the business, like
-- app.resolve_public_profile: its business, if active, and the receptionist it
-- opens now. A paused link opens the default receptionist.
CREATE OR REPLACE FUNCTION app.resolve_entry_link(p_code text)
RETURNS TABLE (business_id uuid, entry_link_id uuid, receptionist_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT link.business_id,
    link.id,
    app.effective_receptionist(link.business_id, CASE WHEN link.status = 'active' THEN link.receptionist_id END)
  FROM public.entry_links link
  INNER JOIN public.businesses business ON business.id = link.business_id
  WHERE link.code = lower(btrim(p_code)) AND business.status = 'active'
  LIMIT 1
$$;

REVOKE ALL ON FUNCTION app.resolve_entry_link(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_entry_link(text) TO lobbystack_app, lobbystack_worker;

-- More receptionists per business from here on.
DROP INDEX IF EXISTS public.receptionist_profiles_business_unique;
