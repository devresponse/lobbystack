-- lobbystack:concurrent-index knowledge_snippets_business_ranked_idx
-- The same ranking for text entries: a business's active entries in the
-- order the prompt takes them, highest priority first, then the newest.
CREATE INDEX CONCURRENTLY IF NOT EXISTS knowledge_snippets_business_ranked_idx
ON public.knowledge_snippets (business_id, priority DESC, updated_at DESC, id)
WHERE active;
