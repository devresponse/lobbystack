import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { businesses, createDatabaseClient, knowledgeChunks, knowledgeDocuments, rlsContextStatement, type DatabaseTransaction } from "@lobbystack/db";
import { apiKnowledgeSourceSchema } from "@lobbystack/shared";

// Explicit opt-in only; never fall back to DATABASE_URL or load an env file.
const testUrl = process.env.LOBBYSTACK_RELIABILITY_TEST_DATABASE_URL;
if (testUrl) {
  const url = new URL(testUrl);
  if (process.env.NODE_ENV === "production" || !["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname) || !/test/i.test(url.pathname)) {
    throw new Error("Knowledge status integration tests require a dedicated local test database.");
  }
}
const client = testUrl ? createDatabaseClient("lobbystack_migrator", { DATABASE_URL: testUrl }) : undefined;
afterAll(async () => { await client?.pool.end(); });

async function rollbackTest(run: (tx: DatabaseTransaction) => Promise<void>) {
  const rollback = new Error("rollback test fixture");
  await expect(client!.db.transaction(async (tx) => {
    await run(tx);
    throw rollback;
  })).rejects.toBe(rollback);
}

/** A business, then the worker's role under its row level security, as these rows are written on a deployment. */
async function asWorker(tx: DatabaseTransaction) {
  const id = randomUUID();
  await tx.insert(businesses).values({ id, slug: `status-${id}`, name: "Maple Clinic", timezone: "America/Vancouver", businessType: "clinic" });
  await tx.execute(sql`set local role lobbystack_worker`);
  await tx.execute(rlsContextStatement({ businessId: id, actorType: "worker" }));
  return id;
}

/** The check a statement broke, from a savepoint, so the transaction goes on after it. */
async function refusedBy(tx: DatabaseTransaction, run: (inner: DatabaseTransaction) => Promise<unknown>) {
  try {
    await tx.transaction(async (inner) => { await run(inner); });
  } catch (error) {
    const cause = (error as { cause?: { code?: string; constraint?: string } }).cause ?? (error as { code?: string; constraint?: string });
    return { code: cause.code, constraint: cause.constraint };
  }
  throw new Error("The statement went through.");
}

describe.skipIf(!testUrl)("knowledge statuses (migration 0144)", () => {
  it("takes every status a document can have, which are the ones the public API reports", async () => {
    await rollbackTest(async (tx) => {
      const businessId = await asWorker(tx);
      const statuses = apiKnowledgeSourceSchema.shape.status.options;
      const rows = await tx.insert(knowledgeDocuments).values(statuses.map((status) => ({ businessId, sourceType: "upload", title: status, status }))).returning({ status: knowledgeDocuments.status });
      expect(rows.map((row) => row.status)).toEqual([...statuses]);
    });
  });

  it("refuses any other document status, on an insert and on an update", async () => {
    await rollbackTest(async (tx) => {
      const businessId = await asWorker(tx);
      const refusal = { code: "23514", constraint: "knowledge_documents_status_check" };
      expect(await refusedBy(tx, (inner) => inner.insert(knowledgeDocuments).values({ businessId, sourceType: "upload", title: "Menu", status: "indexd" as never }))).toEqual(refusal);
      const [document] = await tx.insert(knowledgeDocuments).values({ businessId, sourceType: "upload", title: "Menu" }).returning();
      expect(document!.status).toBe("pending");
      // Upper case is another word to the search and snapshot queries, which read only 'indexed'.
      expect(await refusedBy(tx, (inner) => inner.update(knowledgeDocuments).set({ status: "INDEXED" as never }).where(eq(knowledgeDocuments.id, document!.id)))).toEqual(refusal);
    });
  });

  it("takes the three embedding statuses and refuses any other", async () => {
    await rollbackTest(async (tx) => {
      const businessId = await asWorker(tx);
      const [document] = await tx.insert(knowledgeDocuments).values({ businessId, sourceType: "upload", title: "Menu", status: "indexed" }).returning({ id: knowledgeDocuments.id });
      const passage = { businessId, documentId: document!.id, content: "Open 9 to 5.", contentHash: "hash" };
      const rows = await tx.insert(knowledgeChunks).values((["pending", "completed", "failed"] as const).map((embeddingStatus, sequence) => ({ ...passage, sequence, embeddingStatus }))).returning({ id: knowledgeChunks.id });
      const [unset] = await tx.insert(knowledgeChunks).values({ ...passage, sequence: 3 }).returning({ embeddingStatus: knowledgeChunks.embeddingStatus });
      expect(unset!.embeddingStatus).toBe("pending");
      const refusal = { code: "23514", constraint: "knowledge_chunks_embedding_status_check" };
      expect(await refusedBy(tx, (inner) => inner.insert(knowledgeChunks).values({ ...passage, sequence: 4, embeddingStatus: "complete" as never }))).toEqual(refusal);
      expect(await refusedBy(tx, (inner) => inner.update(knowledgeChunks).set({ embeddingStatus: "done" as never }).where(eq(knowledgeChunks.id, rows[0]!.id)))).toEqual(refusal);
    });
  });
});
