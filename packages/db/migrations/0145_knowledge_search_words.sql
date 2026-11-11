-- Each passage's words, its document's title included, stored with the
-- passage, so the receptionist's keyword search stops rebuilding them for
-- every passage of the business on every question (change 1 of the RAG speed
-- report). Row security keeps the word match off any index, so a search still
-- reads every passage the receptionist may use, but checking stored words was
-- 15 to 30 times faster on a test copy with the real row security: 0.16 to
-- 0.21 s at 10,000 passages instead of 2.6 to 4.1 s.
--
-- Two triggers keep the words current: one as a passage is written, one when
-- its document's title changes. Both write past row security, as the
-- function's owner, and touch only rows of the passage's own business. The
-- word index on the text alone goes: no search could use it under row
-- security, and the stored words replace it.
--
-- A deployment runs this file with the ones before it on an empty database,
-- as with 0143, so the fill under "Rows from before" finds nothing there. On
-- a database with knowledge it fills about a passage every 0.8 ms while
-- holding the table's lock, so a large one should fill them in batches first.

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.knowledge_chunks ADD COLUMN IF NOT EXISTS search_words tsvector;

-- Filled whenever a passage is written.
CREATE OR REPLACE FUNCTION app.knowledge_chunk_search_words()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  NEW.search_words := to_tsvector('simple',
    coalesce((SELECT d.title FROM public.knowledge_documents d WHERE d.id = NEW.document_id AND d.business_id = NEW.business_id), '')
    || ' ' || NEW.content);
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION app.knowledge_chunk_search_words() FROM PUBLIC;

DROP TRIGGER IF EXISTS knowledge_chunks_search_words ON public.knowledge_chunks;
CREATE TRIGGER knowledge_chunks_search_words
  BEFORE INSERT OR UPDATE OF content, document_id ON public.knowledge_chunks
  FOR EACH ROW EXECUTE FUNCTION app.knowledge_chunk_search_words();

-- Refreshed when a document's title changes.
CREATE OR REPLACE FUNCTION app.knowledge_document_search_words()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  UPDATE public.knowledge_chunks c
  SET search_words = to_tsvector('simple', NEW.title || ' ' || c.content)
  WHERE c.document_id = NEW.id AND c.business_id = NEW.business_id;
  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION app.knowledge_document_search_words() FROM PUBLIC;

DROP TRIGGER IF EXISTS knowledge_documents_search_words ON public.knowledge_documents;
CREATE TRIGGER knowledge_documents_search_words
  AFTER UPDATE OF title ON public.knowledge_documents
  FOR EACH ROW WHEN (OLD.title IS DISTINCT FROM NEW.title)
  EXECUTE FUNCTION app.knowledge_document_search_words();

-- Rows from before.
UPDATE public.knowledge_chunks c
SET search_words = to_tsvector('simple', d.title || ' ' || c.content)
FROM public.knowledge_documents d
WHERE d.id = c.document_id AND d.business_id = c.business_id AND c.search_words IS NULL;

DROP INDEX IF EXISTS public.knowledge_chunks_keyword_idx;

COMMENT ON COLUMN public.knowledge_chunks.search_words IS 'The passage''s words with its document''s title, to_tsvector(''simple'', title || '' '' || content), kept current by triggers. The keyword search matches and ranks on them.';
