-- lobbystack:concurrent-index knowledge_documents_business_ranked_idx
-- The snapshot's ranking of each receptionist's documents
-- (rankArticlesForReceptionists): a business's active, indexed documents,
-- newest first, so each receptionist's view walks the index and stops at its
-- limit instead of sorting every document the business has. Built
-- concurrently: a business with a crawled website can have thousands of pages.
CREATE INDEX CONCURRENTLY IF NOT EXISTS knowledge_documents_business_ranked_idx
ON public.knowledge_documents (business_id, updated_at DESC, id)
WHERE active AND status = 'indexed';
