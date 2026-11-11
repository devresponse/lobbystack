-- lobbystack:concurrent-index knowledge_documents_business_id_unique
-- The key that 0136's links from an article to its receptionists point at
-- with a composite foreign key, so the database refuses a link to another
-- business's article. Built concurrently: a business with a crawled website
-- can have thousands of pages.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS knowledge_documents_business_id_unique
ON public.knowledge_documents (business_id, id);
