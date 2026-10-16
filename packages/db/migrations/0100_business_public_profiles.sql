-- A business's public page at /profile/<slug>, on the deployment's own domain.
-- It is opt-in: a business with no row, or with published false, has no page.
-- Owners and admins publish it in Settings and fill in what LobbyStack doesn't
-- otherwise hold: a category, a short description, the address and a public
-- email. Everything else on the page (hours, services, the phone number) comes
-- from what the receptionist already uses.
CREATE TABLE IF NOT EXISTS public.business_public_profiles (
  business_id uuid PRIMARY KEY REFERENCES public.businesses(id) ON DELETE CASCADE,
  published boolean NOT NULL DEFAULT false,
  -- Set on each publish.
  published_at timestamptz,
  -- Free text such as "Dental clinic". business_type is service_company for
  -- most businesses, so it can't stand in.
  category varchar(80),
  description text CHECK (description IS NULL OR char_length(description) <= 750),
  -- Every part is optional: some businesses go to their customers.
  address_line1 text CHECK (address_line1 IS NULL OR char_length(address_line1) <= 200),
  address_line2 text CHECK (address_line2 IS NULL OR char_length(address_line2) <= 200),
  city text CHECK (city IS NULL OR char_length(city) <= 120),
  region text CHECK (region IS NULL OR char_length(region) <= 120),
  postal_code text CHECK (postal_code IS NULL OR char_length(postal_code) <= 20),
  country_code varchar(2) CHECK (country_code IS NULL OR country_code ~ '^[A-Z]{2}$'),
  public_email text CHECK (public_email IS NULL OR char_length(public_email) <= 254),
  -- One switch per section of the page.
  show_phone boolean NOT NULL DEFAULT true,
  show_hours boolean NOT NULL DEFAULT true,
  show_services boolean NOT NULL DEFAULT true,
  show_map boolean NOT NULL DEFAULT true,
  -- The website widget the page shows. Its chat may run on the deployment's
  -- own domain only while the page is published and names this key.
  widget_key_id uuid REFERENCES public.widget_keys(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.business_public_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.business_public_profiles FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS business_public_profiles_tenant_isolation ON public.business_public_profiles;
CREATE POLICY business_public_profiles_tenant_isolation ON public.business_public_profiles
  USING (business_id = app.current_business_id() AND (app.current_actor_type() IN ('system', 'worker', 'dispatcher') OR app.has_business_membership(business_id)))
  WITH CHECK (business_id = app.current_business_id() AND (app.current_actor_type() IN ('system', 'worker', 'dispatcher') OR app.has_business_membership(business_id)));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.business_public_profiles TO lobbystack_app, lobbystack_worker;
GRANT SELECT ON public.business_public_profiles TO lobbystack_readonly;

-- The business behind /profile/<slug>. An unknown slug, an unpublished
-- profile and an inactive business all get null, so the page answers them
-- with the same 404 and nobody can tell which businesses exist.
CREATE OR REPLACE FUNCTION app.resolve_public_profile(p_slug text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT business.id
  FROM public.businesses business
  JOIN public.business_public_profiles profile ON profile.business_id = business.id
  WHERE business.slug = p_slug AND business.status = 'active' AND profile.published
  LIMIT 1
$$;

REVOKE ALL ON FUNCTION app.resolve_public_profile(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_public_profile(text) TO lobbystack_app, lobbystack_worker;
