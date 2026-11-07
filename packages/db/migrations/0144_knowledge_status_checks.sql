-- The statuses a knowledge document and a passage's embedding can have, which
-- only the code kept to until now. The database now refuses anything else, so
-- a misspelled status fails where it's written, instead of leaving a document
-- no receptionist reads and no owner can retry. The columns stay varchar:
-- smallints would save too little to be worth the change.
--
-- A new status needs this check changed in a migration, with the column's
-- type in packages/db/src/schema/index.ts and, for a document,
-- apiKnowledgeSourceSchema in packages/shared/src/publicApi/schemas.ts, which
-- a test compares with this list.
--
-- A deployment runs this file with the ones before it on an empty database,
-- as with 0143, so nothing here splits a step to spare a large table its
-- locks. The statements under "Rows from before" find nothing to change on a
-- new database; they only keep this file from failing on one with older rows.

SET LOCAL lock_timeout = '5s';

-- Rows from before. No receptionist reads a document with another status,
-- since search and the snapshot take only indexed ones, and the owner can
-- retry one in error. The dashboard words the error when the row has none.
UPDATE public.knowledge_documents
SET status = 'error', processing_progress = 0, revision = revision + 1, updated_at = now()
WHERE status NOT IN ('pending', 'processing', 'indexed', 'error', 'cancelled');

-- Rows from before. Search takes only completed passages, and the next
-- re-embedding takes pending ones.
UPDATE public.knowledge_chunks
SET embedding_status = 'pending', updated_at = now()
WHERE embedding_status NOT IN ('pending', 'completed', 'failed');

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'knowledge_documents_status_check') THEN
    ALTER TABLE public.knowledge_documents
      ADD CONSTRAINT knowledge_documents_status_check CHECK (status IN ('pending', 'processing', 'indexed', 'error', 'cancelled'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'knowledge_chunks_embedding_status_check') THEN
    ALTER TABLE public.knowledge_chunks
      ADD CONSTRAINT knowledge_chunks_embedding_status_check CHECK (embedding_status IN ('pending', 'completed', 'failed'));
  END IF;
END
$$;

COMMENT ON COLUMN public.knowledge_documents.status IS 'pending: a file waits its turn. processing: it is being read. indexed: receptionists can use it. error: reading failed, and the owner can retry. cancelled: the owner stopped it.';
COMMENT ON COLUMN public.knowledge_chunks.embedding_status IS 'pending: waits for its embedding. completed: search can use its embedding. failed: the last try failed, and the next re-embedding takes it again.';
