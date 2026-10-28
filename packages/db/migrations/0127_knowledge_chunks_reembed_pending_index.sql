-- lobbystack:concurrent-index knowledge_chunks_reembed_pending_idx
-- The re-embed listing in 0125 finds chunks without an embedding, or pending or
-- failed, through this index. Few chunks are ever in those states, so it stays small.
-- The original project's 0100.
CREATE INDEX CONCURRENTLY IF NOT EXISTS knowledge_chunks_reembed_pending_idx
ON public.knowledge_chunks (business_id)
WHERE embedding IS NULL OR embedding_status IN ('pending', 'failed');
