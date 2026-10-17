-- New businesses used to get the summary "<name> uses LobbyStack to answer
-- calls." (older ones: "...to handle calls and SMS.") until AI or a person
-- wrote one. Prompts and the dashboard already hide a placeholder, but the API
-- returned it, naming LobbyStack on a deployment with its own name. New
-- businesses now start with just their name, as the agent settings API does;
-- this gives the same to placeholders still holding the old sentence. Running
-- this file again changes nothing.
--
-- Updating every business needs a role that sees every row, like 0074.
DO $$
DECLARE
  renamed integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE NOTICE 'Skipping the placeholder summary rename: % is subject to row-level security.', current_user;
    RETURN;
  END IF;

  UPDATE public.receptionist_profiles profile
  SET summary = btrim(business.name), updated_at = now()
  FROM public.businesses business
  WHERE business.id = profile.business_id
    AND profile.summary_source = 'placeholder'
    AND profile.summary ~* 'uses LobbyStack to (answer calls|handle calls and SMS)\.?\s*$';
  GET DIAGNOSTICS renamed = ROW_COUNT;

  RAISE NOTICE 'Placeholder summaries: % now hold the business name.', renamed;
END
$$;
