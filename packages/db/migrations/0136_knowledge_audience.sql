-- Who may use each article: every receptionist (audience everyone, which every
-- existing article stays), or only the receptionists chosen for it (chosen,
-- with one link row per receptionist). Files, website pages and text entries
-- get the same choice. A receptionist whose knowledge_scope is audience
-- answers from the articles for everyone plus those chosen for it; one whose
-- scope is all, as the default receptionist's is, answers from every article.
-- An article chosen for receptionists that are all archived is left to the
-- default receptionist only, never to everyone.
--
-- A website rule gives a crawled site's pages under a path, such as
-- /stores/kitsilano/, to one receptionist on every crawl; the link rows a
-- rule made name it and go when it goes.
--
-- Every link names its business, and composite foreign keys on
-- (business_id, id) refuse a link between two businesses even if code has a
-- bug. Receptionists are archived, never deleted, so the links to one stay;
-- deleting a business removes everything through its cascade.

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.knowledge_documents
  ADD COLUMN IF NOT EXISTS audience varchar(16) NOT NULL DEFAULT 'everyone';
ALTER TABLE public.knowledge_snippets
  ADD COLUMN IF NOT EXISTS audience varchar(16) NOT NULL DEFAULT 'everyone';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'knowledge_documents_audience_check') THEN
    ALTER TABLE public.knowledge_documents
      ADD CONSTRAINT knowledge_documents_audience_check CHECK (audience IN ('everyone', 'chosen'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'knowledge_snippets_audience_check') THEN
    ALTER TABLE public.knowledge_snippets
      ADD CONSTRAINT knowledge_snippets_audience_check CHECK (audience IN ('everyone', 'chosen'));
  END IF;
END
$$;

COMMENT ON COLUMN public.knowledge_documents.audience IS 'everyone: every receptionist may use it. chosen: only the receptionists in knowledge_document_receptionists, and the default one when they are all archived.';
COMMENT ON COLUMN public.knowledge_snippets.audience IS 'everyone: every receptionist may use it. chosen: only the receptionists in knowledge_snippet_receptionists, and the default one when they are all archived.';

-- Text entries are few per business, so this index builds inside the transaction.
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_snippets_business_id_unique
  ON public.knowledge_snippets (business_id, id);

CREATE TABLE IF NOT EXISTS public.knowledge_website_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  -- The crawled site: the website source document its pages came from.
  root_document_id uuid NOT NULL,
  -- A path on the site, starting and ending with a slash, such as /stores/kitsilano/.
  path_prefix varchar(300) NOT NULL CHECK (path_prefix ~ '^/([^/?#\s]+/)*$'),
  receptionist_id uuid NOT NULL,
  created_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT knowledge_website_rules_document_fk FOREIGN KEY (business_id, root_document_id)
    REFERENCES public.knowledge_documents (business_id, id) ON DELETE CASCADE,
  CONSTRAINT knowledge_website_rules_receptionist_fk FOREIGN KEY (business_id, receptionist_id)
    REFERENCES public.receptionist_profiles (business_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_website_rules_unique
  ON public.knowledge_website_rules (root_document_id, path_prefix, receptionist_id);
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_website_rules_business_id_unique
  ON public.knowledge_website_rules (business_id, id);
CREATE INDEX IF NOT EXISTS knowledge_website_rules_business_receptionist_idx
  ON public.knowledge_website_rules (business_id, receptionist_id);

CREATE TABLE IF NOT EXISTS public.knowledge_document_receptionists (
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  document_id uuid NOT NULL,
  receptionist_id uuid NOT NULL,
  -- The website rule that made the link, which removes it when the rule goes. Null for a link someone chose.
  website_rule_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, receptionist_id),
  CONSTRAINT knowledge_document_receptionists_document_fk FOREIGN KEY (business_id, document_id)
    REFERENCES public.knowledge_documents (business_id, id) ON DELETE CASCADE,
  CONSTRAINT knowledge_document_receptionists_receptionist_fk FOREIGN KEY (business_id, receptionist_id)
    REFERENCES public.receptionist_profiles (business_id, id),
  CONSTRAINT knowledge_document_receptionists_rule_fk FOREIGN KEY (business_id, website_rule_id)
    REFERENCES public.knowledge_website_rules (business_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS knowledge_document_receptionists_receptionist_idx
  ON public.knowledge_document_receptionists (business_id, receptionist_id);
CREATE INDEX IF NOT EXISTS knowledge_document_receptionists_rule_idx
  ON public.knowledge_document_receptionists (business_id, website_rule_id)
  WHERE website_rule_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.knowledge_snippet_receptionists (
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  snippet_id uuid NOT NULL,
  receptionist_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (snippet_id, receptionist_id),
  CONSTRAINT knowledge_snippet_receptionists_snippet_fk FOREIGN KEY (business_id, snippet_id)
    REFERENCES public.knowledge_snippets (business_id, id) ON DELETE CASCADE,
  CONSTRAINT knowledge_snippet_receptionists_receptionist_fk FOREIGN KEY (business_id, receptionist_id)
    REFERENCES public.receptionist_profiles (business_id, id)
);
CREATE INDEX IF NOT EXISTS knowledge_snippet_receptionists_receptionist_idx
  ON public.knowledge_snippet_receptionists (business_id, receptionist_id);

-- Each table: forced row-level security with the standard tenant policy, and
-- grants to the dashboard and API role, the worker (crawls apply website
-- rules, snapshots read the links) and, for reading, the read-only role.
DO $$
DECLARE
  name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['knowledge_website_rules', 'knowledge_document_receptionists', 'knowledge_snippet_receptionists'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', name);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', name || '_tenant_isolation', name);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I
         USING (business_id = app.current_business_id() AND (app.current_actor_type() IN (''system'', ''worker'', ''dispatcher'') OR app.has_business_membership(business_id)))
         WITH CHECK (business_id = app.current_business_id() AND (app.current_actor_type() IN (''system'', ''worker'', ''dispatcher'') OR app.has_business_membership(business_id)))',
      name || '_tenant_isolation', name);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO lobbystack_app, lobbystack_worker', name);
    EXECUTE format('GRANT SELECT ON public.%I TO lobbystack_readonly', name);
  END LOOP;
END
$$;

COMMENT ON TABLE public.knowledge_website_rules IS 'Gives a crawled site''s pages under path_prefix to one receptionist, on every crawl.';
COMMENT ON TABLE public.knowledge_document_receptionists IS 'The receptionists a file or website page whose audience is chosen is for.';
COMMENT ON TABLE public.knowledge_snippet_receptionists IS 'The receptionists a text entry whose audience is chosen is for.';
