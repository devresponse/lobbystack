import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { businesses, createDatabaseClient, knowledgeChunks, knowledgeDocuments, rlsContextStatement, type Database, type DatabaseTransaction } from "@lobbystack/db";

import { searchKnowledgeEvidence } from "./knowledge";

// Explicit opt-in only; never fall back to DATABASE_URL or load an env file.
const testUrl = process.env.LOBBYSTACK_RELIABILITY_TEST_DATABASE_URL;
if (testUrl) {
  const url = new URL(testUrl);
  if (process.env.NODE_ENV === "production" || !["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname) || !/test/i.test(url.pathname)) {
    throw new Error("Knowledge search words integration tests require a dedicated local test database.");
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

/** As the worker under the business's row security, the way the worker writes passages; null goes back to the owner. */
async function as(tx: DatabaseTransaction, businessId: string | null) {
  await tx.execute(sql`reset role`);
  if (!businessId) return;
  await tx.execute(sql`set local role lobbystack_worker`);
  await tx.execute(rlsContextStatement({ businessId, actorType: "worker" }));
}

async function words(tx: DatabaseTransaction, chunkId: string): Promise<string> {
  const [row] = await tx.execute<{ words: string | null }>(sql`select search_words::text as words from public.knowledge_chunks where id = ${chunkId}`).then((result) => result.rows);
  return row?.words ?? "";
}

async function seed(tx: DatabaseTransaction, title: string, content: string) {
  const businessId = randomUUID();
  await as(tx, null);
  await tx.insert(businesses).values({ id: businessId, slug: `words-${businessId}`, name: "Maple Clinic", timezone: "America/Vancouver", businessType: "clinic" });
  await as(tx, businessId);
  const [document] = await tx.insert(knowledgeDocuments).values({ businessId, sourceType: "upload", title, status: "indexed" }).returning({ id: knowledgeDocuments.id });
  const [chunk] = await tx.insert(knowledgeChunks).values({ businessId, documentId: document!.id, sequence: 0, content, contentHash: randomUUID() }).returning({ id: knowledgeChunks.id });
  return { businessId, documentId: document!.id, chunkId: chunk!.id };
}

describe.skipIf(!testUrl)("each passage's stored words (migration 0145)", () => {
  it("stores a passage's words with its document's title, and keeps them current", async () => {
    await rollbackTest(async (tx) => {
      const { businessId, documentId, chunkId } = await seed(tx, "Parking guide", "Open nine to five");
      expect(await words(tx, chunkId)).toBe("'five':6 'guide':2 'nine':4 'open':3 'parking':1 'to':5");
      // A new text for the passage.
      await tx.update(knowledgeChunks).set({ content: "Closed on Sundays" }).where(eq(knowledgeChunks.id, chunkId));
      expect(await words(tx, chunkId)).toBe("'closed':3 'guide':2 'on':4 'parking':1 'sundays':5");
      // A change that leaves the title alone leaves the words alone.
      await as(tx, null);
      await tx.execute(sql`update public.knowledge_chunks set search_words = to_tsvector('simple', 'unchanged') where id = ${chunkId}`);
      await as(tx, businessId);
      await tx.update(knowledgeDocuments).set({ status: "processing" }).where(eq(knowledgeDocuments.id, documentId));
      await tx.update(knowledgeDocuments).set({ title: "Parking guide" }).where(eq(knowledgeDocuments.id, documentId));
      expect(await words(tx, chunkId)).toBe("'unchanged':1");
      // A new title reaches every passage of the document.
      await tx.update(knowledgeDocuments).set({ title: "Visitor parking" }).where(eq(knowledgeDocuments.id, documentId));
      expect(await words(tx, chunkId)).toBe("'closed':3 'on':4 'parking':2 'sundays':5 'visitor':1");
    });
  });

  it("is what the keyword half matches and ranks on", async () => {
    await rollbackTest(async (tx) => {
      const { businessId, chunkId } = await seed(tx, "Hours", "Open nine to five");
      // Words the passage's text and title don't hold, so only the stored words can find it.
      await as(tx, null);
      await tx.execute(sql`update public.knowledge_chunks set search_words = to_tsvector('simple', 'zebra crossing') where id = ${chunkId}`);
      await as(tx, businessId);
      const found = await searchKnowledgeEvidence({ db: tx as unknown as Database }, { businessId, query: "zebra" });
      expect(found).toMatchObject({ mode: "keyword", outcome: "found" });
      expect(found.matches.map((match) => match.chunkId)).toEqual([chunkId]);
      expect(await searchKnowledgeEvidence({ db: tx as unknown as Database }, { businessId, query: "nine" })).toMatchObject({ outcome: "empty" });
    });
  });
});
