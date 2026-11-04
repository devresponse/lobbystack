import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  auditLogs,
  billingAccounts,
  businessContextSnapshots,
  businessPublicProfiles,
  businesses,
  createDatabaseClient,
  knowledgeChunks,
  knowledgeDocumentReceptionists,
  knowledgeDocuments,
  knowledgeSnippetReceptionists,
  knowledgeSnippets,
  knowledgeWebsiteRules,
  outboxMessages,
  receptionistProfiles,
  rlsContextStatement,
  storageObjects,
  users,
  websiteIngestionJobs,
  type Database,
  type DatabaseTransaction,
} from "@lobbystack/db";

import { snapshotForReceptionist } from "../snapshot";
import { loadBusinessHoursInput } from "./businessHours";
import { loadBusinessSummaryInput } from "./businessSummary";
import { createKnowledgeDocument, createKnowledgeSnippet, loadLatestBusinessSnapshot, refreshBusinessSnapshot, searchKnowledgeEvidence, traceKnowledgeSearch, updateKnowledgeSnippet } from "./knowledge";
import {
  applyWebsiteRulesInTransaction,
  changeKnowledgeAudienceInTransaction,
  createWebsiteRuleInTransaction,
  deleteWebsiteRuleInTransaction,
  knowledgeAudienceLinksInTransaction,
  listWebsiteRulesInTransaction,
  rankArticlesForReceptionists,
  setKnowledgeArticleAudienceInTransaction,
} from "./knowledgeAudience";
import { archiveReceptionistInTransaction, createReceptionistInTransaction, setReceptionistStatusInTransaction, updateReceptionistInTransaction } from "./receptionists";
import { finalizeUpload, type StorageProvider } from "./storage";
import { createBusiness } from "./tenancy";

// Explicit opt-in only; never fall back to DATABASE_URL or load an env file.
const testUrl = process.env.LOBBYSTACK_RELIABILITY_TEST_DATABASE_URL;
if (testUrl) {
  const url = new URL(testUrl);
  if (process.env.NODE_ENV === "production" || !["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname) || !/test/i.test(url.pathname)) {
    throw new Error("Knowledge audience integration tests require a dedicated local test database.");
  }
}
const client = testUrl ? createDatabaseClient("lobbystack_migrator", { DATABASE_URL: testUrl }) : undefined;
afterAll(async () => { await client?.pool.end(); });
afterEach(() => { vi.unstubAllEnvs(); });

const env = { MAX_RECEPTIONISTS_PER_BUSINESS: "50" };

async function rollbackTest(run: (tx: DatabaseTransaction) => Promise<void>) {
  const rollback = new Error("rollback test fixture");
  await expect(client!.db.transaction(async (tx) => {
    await run(tx);
    throw rollback;
  })).rejects.toBe(rollback);
}

async function as(tx: DatabaseTransaction, role: "lobbystack_app" | "lobbystack_worker" | null) {
  await tx.execute(sql`reset role`);
  if (role) await tx.execute(sql.raw(`set local role ${role}`));
}

/** Acts as the business's owner in the dashboard: the app role under the business's row level security. */
async function asOwner(tx: DatabaseTransaction, input: { userId: string; businessId: string }) {
  await as(tx, "lobbystack_app");
  await tx.execute(rlsContextStatement({ userId: input.userId, businessId: input.businessId, actorType: "operator" }));
}

/** Runs a step that should fail in a savepoint, so the transaction goes on after it. */
async function failure(tx: DatabaseTransaction, run: (inner: DatabaseTransaction) => Promise<unknown>): Promise<unknown> {
  return await tx.transaction(async (inner) => { await run(inner); }).then(() => null, (error: unknown) => error);
}

async function seedBusiness(tx: DatabaseTransaction, name = "Kitsilano Coffee") {
  const userId = randomUUID();
  await tx.insert(users).values({ id: userId, email: `${userId}@example.invalid`, normalizedEmail: `${userId}@example.invalid`, name: "Riley Owner" });
  await as(tx, "lobbystack_app");
  const context = { db: tx as unknown as Database };
  const { businessId } = await createBusiness(context, { userId, name, timezone: "America/Vancouver", businessType: "restaurant", deploymentMode: "cloud" });
  await as(tx, null);
  await tx.insert(billingAccounts).values({ businessId, billingKey: `business:${businessId}`, plan: "pro", subscriptionState: "active", source: "polar" })
    .onConflictDoUpdate({ target: billingAccounts.businessId, set: { plan: "pro", subscriptionState: "active" } });
  const [front] = await tx.select().from(receptionistProfiles).where(and(eq(receptionistProfiles.businessId, businessId), eq(receptionistProfiles.isDefault, true)));
  return { context, userId, businessId, front: front! };
}

/** A coffee shop with a front desk that sees every article and two stores that see their own. */
async function seedStores(tx: DatabaseTransaction) {
  const seeded = await seedBusiness(tx);
  const { businessId, userId } = seeded;
  await asOwner(tx, { userId, businessId });
  const gastown = await createReceptionistInTransaction(tx, { businessId, actorUserId: userId, receptionist: { name: "Gastown store", description: "Orders and pickup at Gastown" }, env });
  const kitsilano = await createReceptionistInTransaction(tx, { businessId, actorUserId: userId, receptionist: { name: "Kitsilano store", description: "Orders at Kitsilano" }, env });
  await as(tx, null);
  return { ...seeded, gastown, kitsilano };
}

async function addDocument(tx: DatabaseTransaction, businessId: string, values: { title: string; sourceType?: "upload" | "website"; sourceUrl?: string; status?: string; updatedAt?: Date; content?: string }) {
  await as(tx, null);
  const [document] = await tx.insert(knowledgeDocuments).values({
    businessId,
    title: values.title,
    sourceType: values.sourceType ?? "upload",
    sourceUrl: values.sourceUrl ?? null,
    status: values.status ?? "indexed",
    ...(values.updatedAt ? { updatedAt: values.updatedAt } : {}),
  }).returning({ id: knowledgeDocuments.id });
  if (values.content) {
    await tx.insert(knowledgeChunks).values({ businessId, documentId: document!.id, sequence: 0, content: values.content, contentHash: randomUUID(), embeddingStatus: "completed" });
  }
  return document!.id;
}

async function addSnippet(tx: DatabaseTransaction, businessId: string, values: { title: string; content?: string; priority?: number }) {
  await as(tx, null);
  const [snippet] = await tx.insert(knowledgeSnippets).values({ businessId, title: values.title, content: values.content ?? values.title, priority: values.priority ?? 0 }).returning({ id: knowledgeSnippets.id });
  return snippet!.id;
}

/** A website added to Knowledge: its source document, as crawled, and the crawl's job. */
async function addWebsite(tx: DatabaseTransaction, businessId: string, siteUrl = "https://kitsilanocoffee.ca/") {
  const rootDocumentId = await addDocument(tx, businessId, { title: "Kitsilano Coffee", sourceType: "website", sourceUrl: siteUrl });
  await tx.insert(websiteIngestionJobs).values({ businessId, rootDocumentId, websiteUrl: siteUrl, provider: "firecrawl", status: "completed" });
  return rootDocumentId;
}

async function audienceOf(tx: DatabaseTransaction, kind: "document" | "snippet", id: string) {
  await as(tx, null);
  if (kind === "document") {
    const [row] = await tx.select({ audience: knowledgeDocuments.audience }).from(knowledgeDocuments).where(eq(knowledgeDocuments.id, id));
    const links = await tx.select({ receptionistId: knowledgeDocumentReceptionists.receptionistId }).from(knowledgeDocumentReceptionists).where(eq(knowledgeDocumentReceptionists.documentId, id));
    return { audience: row!.audience, receptionistIds: links.map((link) => link.receptionistId).sort() };
  }
  const [row] = await tx.select({ audience: knowledgeSnippets.audience }).from(knowledgeSnippets).where(eq(knowledgeSnippets.id, id));
  const links = await tx.select({ receptionistId: knowledgeSnippetReceptionists.receptionistId }).from(knowledgeSnippetReceptionists).where(eq(knowledgeSnippetReceptionists.snippetId, id));
  return { audience: row!.audience, receptionistIds: links.map((link) => link.receptionistId).sort() };
}

const sorted = (...ids: string[]) => ids.slice().sort();

describe.skipIf(!testUrl)("knowledge audiences against PostgreSQL under RLS", () => {
  it("sets who one article is for, and refuses receptionists and articles it can't choose", async () => {
    await rollbackTest(async (tx) => {
      const { businessId, userId, gastown, kitsilano } = await seedStores(tx);
      const menu = await addDocument(tx, businessId, { title: "Gastown menu" });
      const parking = await addSnippet(tx, businessId, { title: "Gastown parking" });
      const before = (await tx.select().from(outboxMessages).where(and(eq(outboxMessages.businessId, businessId), eq(outboxMessages.topic, "snapshot.refresh")))).length;

      await asOwner(tx, { userId, businessId });
      expect(await setKnowledgeArticleAudienceInTransaction(tx, { businessId, actorUserId: userId, kind: "document", articleId: menu, choice: { audience: "chosen", receptionistIds: [gastown.id] } }))
        .toEqual({ audience: "chosen", receptionistIds: [gastown.id] });
      expect(await audienceOf(tx, "document", menu)).toEqual({ audience: "chosen", receptionistIds: [gastown.id] });

      // A new choice replaces the old one.
      await asOwner(tx, { userId, businessId });
      await setKnowledgeArticleAudienceInTransaction(tx, { businessId, actorUserId: userId, kind: "document", articleId: menu, choice: { audience: "chosen", receptionistIds: [kitsilano.id, gastown.id] } });
      expect(await audienceOf(tx, "document", menu)).toEqual({ audience: "chosen", receptionistIds: sorted(kitsilano.id, gastown.id) });
      await asOwner(tx, { userId, businessId });
      await setKnowledgeArticleAudienceInTransaction(tx, { businessId, actorUserId: userId, kind: "document", articleId: menu, choice: { audience: "everyone" } });
      expect(await audienceOf(tx, "document", menu)).toEqual({ audience: "everyone", receptionistIds: [] });

      await asOwner(tx, { userId, businessId });
      await setKnowledgeArticleAudienceInTransaction(tx, { businessId, actorUserId: userId, kind: "snippet", articleId: parking, choice: { audience: "chosen", receptionistIds: [gastown.id] } });
      expect(await audienceOf(tx, "snippet", parking)).toEqual({ audience: "chosen", receptionistIds: [gastown.id] });

      // Each change is audited and refreshes the snapshot, the summary and the hours.
      await as(tx, null);
      // Rows a transaction writes all take its start time as created_at, so the entries come in no set order.
      const audits = await tx.select().from(auditLogs).where(and(eq(auditLogs.businessId, businessId), eq(auditLogs.eventType, "knowledge.audience_changed")));
      expect(audits.map((audit) => `${audit.entityType} ${audit.entityId}`).sort()).toEqual([`knowledge_document ${menu}`, `knowledge_document ${menu}`, `knowledge_document ${menu}`, `knowledge_snippet ${parking}`]);
      expect(audits.map((audit) => audit.payload)).toContainEqual({ audience: "chosen", receptionistIds: [kitsilano.id, gastown.id] });
      const refreshes = await tx.select().from(outboxMessages).where(and(eq(outboxMessages.businessId, businessId), eq(outboxMessages.topic, "snapshot.refresh")));
      expect(refreshes.length - before).toBe(4);
      expect((await tx.select().from(outboxMessages).where(and(eq(outboxMessages.businessId, businessId), eq(outboxMessages.topic, "business.extractHours")))).length).toBeGreaterThan(0);

      // An archived receptionist, one the business doesn't have, and an article it doesn't have.
      const other = await seedStores(tx);
      await asOwner(tx, { userId, businessId });
      await archiveReceptionistInTransaction(tx, { businessId, actorUserId: userId, receptionistId: kitsilano.id });
      const choose = (articleId: string, receptionistIds: string[]) => failure(tx, (inner) => setKnowledgeArticleAudienceInTransaction(inner, { businessId, actorUserId: userId, kind: "document", articleId, choice: { audience: "chosen", receptionistIds } }));
      expect(await choose(menu, [kitsilano.id])).toMatchObject({ status: 409, code: "receptionist_archived" });
      expect(await choose(menu, [other.gastown.id])).toMatchObject({ status: 404, code: "receptionist_not_found" });
      expect(await choose(menu, [randomUUID()])).toMatchObject({ status: 404, code: "receptionist_not_found" });
      expect(await choose(randomUUID(), [gastown.id])).toMatchObject({ status: 404, code: "knowledge_not_found" });
      const theirs = await addDocument(tx, other.businessId, { title: "Their menu" });
      await asOwner(tx, { userId, businessId });
      expect(await choose(theirs, [gastown.id])).toMatchObject({ status: 404, code: "knowledge_not_found" });
      expect(await audienceOf(tx, "document", theirs)).toEqual({ audience: "everyone", receptionistIds: [] });
    });
  });

  it("saves who a new text entry, file or website's pages are for in the same save, or saves nothing", async () => {
    await rollbackTest(async (tx) => {
      const { context, businessId, userId, gastown, kitsilano } = await seedStores(tx);
      const owner = { userId, businessId };
      const snippetTitled = async (title: string) => {
        await as(tx, null);
        return (await tx.select({ id: knowledgeSnippets.id }).from(knowledgeSnippets).where(and(eq(knowledgeSnippets.businessId, businessId), eq(knowledgeSnippets.title, title))))[0]?.id;
      };

      // A text entry for one store, then for everyone, then for both stores.
      await asOwner(tx, owner);
      const parking = await createKnowledgeSnippet(context, { ...owner, title: "Gastown parking", content: "Park on Water Street.", audience: { audience: "chosen", receptionistIds: [gastown.id] } });
      expect(await audienceOf(tx, "snippet", parking)).toEqual({ audience: "chosen", receptionistIds: [gastown.id] });
      await asOwner(tx, owner);
      const hours = await createKnowledgeSnippet(context, { ...owner, title: "Holiday hours", content: "Closed on December 25.", audience: { audience: "everyone" } });
      expect(await audienceOf(tx, "snippet", hours)).toEqual({ audience: "everyone", receptionistIds: [] });
      await asOwner(tx, owner);
      await updateKnowledgeSnippet(context, { ...owner, snippetId: parking, content: "Park on Water Street or Cordova.", audience: { audience: "chosen", receptionistIds: [gastown.id, kitsilano.id] } });
      expect(await audienceOf(tx, "snippet", parking)).toEqual({ audience: "chosen", receptionistIds: sorted(gastown.id, kitsilano.id) });
      await asOwner(tx, owner);
      await updateKnowledgeSnippet(context, { ...owner, snippetId: parking, title: "Parking" });
      expect(await audienceOf(tx, "snippet", parking)).toEqual({ audience: "chosen", receptionistIds: sorted(gastown.id, kitsilano.id) });

      // A receptionist that can't be chosen keeps the entry from being saved at all, never saved for everyone.
      await asOwner(tx, owner);
      await archiveReceptionistInTransaction(tx, { businessId, actorUserId: userId, receptionistId: kitsilano.id });
      await asOwner(tx, owner);
      expect(await failure(tx, (inner) => createKnowledgeSnippet({ db: inner as unknown as Database }, { ...owner, title: "Kitsilano patio", content: "The patio opens in May.", audience: { audience: "chosen", receptionistIds: [kitsilano.id] } })))
        .toMatchObject({ status: 409, code: "receptionist_archived" });
      expect(await snippetTitled("Kitsilano patio")).toBeUndefined();
      await asOwner(tx, owner);
      expect(await failure(tx, (inner) => updateKnowledgeSnippet({ db: inner as unknown as Database }, { ...owner, snippetId: hours, content: "Closed all week.", audience: { audience: "chosen", receptionistIds: [randomUUID()] } })))
        .toMatchObject({ status: 404, code: "receptionist_not_found" });
      await as(tx, null);
      expect((await tx.select({ content: knowledgeSnippets.content }).from(knowledgeSnippets).where(eq(knowledgeSnippets.id, hours)))[0]!.content).toBe("Closed on December 25.");

      // A file for one store is chosen as it is added, before it is read.
      const storage = (checksum: string): StorageProvider => ({
        createUpload: async () => ({ url: "https://storage.invalid/upload" }),
        headObject: async () => ({ length: 3, contentType: "text/plain", checksum }),
      } as unknown as StorageProvider);
      const pendingUpload = async (purpose: "knowledge" | "attachment", checksum: string) => {
        await as(tx, null);
        const objectId = randomUUID();
        await tx.insert(storageObjects).values({ id: objectId, businessId, objectKey: `businesses/${businessId}/${objectId}`, purpose, fileName: "menu.txt", contentType: "text/plain", contentLength: 3, checksum, status: "pending" });
        return objectId;
      };
      const finalize = (db: DatabaseTransaction, objectId: string, checksum: string, audience: Parameters<typeof finalizeUpload>[1]["audience"]) =>
        finalizeUpload({ db: db as unknown as Database } as Parameters<typeof finalizeUpload>[0], { ...owner, objectId, length: 3, contentType: "text/plain", checksum, title: "Gastown menu", audience }, storage(checksum));
      const menuUpload = await pendingUpload("knowledge", "c3VtLW1lbnU=");
      await asOwner(tx, owner);
      await finalize(tx, menuUpload, "c3VtLW1lbnU=", { audience: "chosen", receptionistIds: [gastown.id] });
      await as(tx, null);
      const [menu] = await tx.select({ id: knowledgeDocuments.id, status: knowledgeDocuments.status }).from(knowledgeDocuments).where(eq(knowledgeDocuments.storageObjectId, menuUpload));
      expect(menu!.status).toBe("pending");
      expect(await audienceOf(tx, "document", menu!.id)).toEqual({ audience: "chosen", receptionistIds: [gastown.id] });

      // An archived receptionist leaves the upload waiting, with no document; an attachment takes no audience.
      const patioUpload = await pendingUpload("knowledge", "c3VtLXBhdGlv");
      await asOwner(tx, owner);
      expect(await failure(tx, (inner) => finalize(inner, patioUpload, "c3VtLXBhdGlv", { audience: "chosen", receptionistIds: [kitsilano.id] }))).toMatchObject({ status: 409, code: "receptionist_archived" });
      await as(tx, null);
      expect((await tx.select({ status: storageObjects.status }).from(storageObjects).where(eq(storageObjects.id, patioUpload)))[0]!.status).toBe("pending");
      expect(await tx.select().from(knowledgeDocuments).where(eq(knowledgeDocuments.storageObjectId, patioUpload))).toEqual([]);
      const attachment = await pendingUpload("attachment", "c3VtLWZpbGU=");
      await asOwner(tx, owner);
      expect(await failure(tx, (inner) => finalize(inner, attachment, "c3VtLWZpbGU=", { audience: "chosen", receptionistIds: [gastown.id] }))).toMatchObject({ status: 400, code: "invalid_audience" });

      // A website and its page rules are added together, so the first crawled page follows them.
      await asOwner(tx, owner);
      const site = await createKnowledgeDocument(context, { ...owner, title: "https://kitsilanocoffee.ca", sourceType: "website", sourceUrl: "https://kitsilanocoffee.ca", websiteRules: [{ pathPrefix: "/stores/gastown/", receptionistId: gastown.id }] });
      await asOwner(tx, owner);
      expect((await listWebsiteRulesInTransaction(tx, { businessId })).map((rule) => [rule.rootDocumentId, rule.pathPrefix, rule.receptionistId])).toEqual([[site, "/stores/gastown/", gastown.id]]);
      await as(tx, null);
      expect(await tx.select({ id: outboxMessages.id }).from(outboxMessages).where(and(eq(outboxMessages.businessId, businessId), eq(outboxMessages.topic, "knowledge.crawlWebsite"), eq(outboxMessages.aggregateId, site)))).toHaveLength(1);

      // Adding the same site again keeps the rules it has and adds the new ones.
      await asOwner(tx, owner);
      expect(await createKnowledgeDocument(context, { ...owner, title: "https://kitsilanocoffee.ca", sourceType: "website", sourceUrl: "https://kitsilanocoffee.ca/", websiteRules: [{ pathPrefix: "/stores/gastown/", receptionistId: gastown.id }, { pathPrefix: "/deals/", receptionistId: gastown.id }] })).toBe(site);
      await asOwner(tx, owner);
      expect((await listWebsiteRulesInTransaction(tx, { businessId })).map((rule) => rule.pathPrefix)).toEqual(["/deals/", "/stores/gastown/"]);

      // A rule for an archived receptionist stops the whole import; rules belong to websites.
      await asOwner(tx, owner);
      expect(await failure(tx, (inner) => createKnowledgeDocument({ db: inner as unknown as Database }, { ...owner, title: "https://kitsilanocoffee.com", sourceType: "website", sourceUrl: "https://kitsilanocoffee.com", websiteRules: [{ pathPrefix: "/", receptionistId: kitsilano.id }] })))
        .toMatchObject({ status: 409, code: "receptionist_archived" });
      await as(tx, null);
      expect(await tx.select().from(knowledgeDocuments).where(and(eq(knowledgeDocuments.businessId, businessId), eq(knowledgeDocuments.sourceUrl, "https://kitsilanocoffee.com/")))).toEqual([]);
      await asOwner(tx, owner);
      await expect(createKnowledgeDocument(context, { ...owner, title: "Menu", sourceType: "upload", storageObjectId: randomUUID(), websiteRules: [{ pathPrefix: "/", receptionistId: gastown.id }] })).rejects.toMatchObject({ status: 400, code: "invalid_website_rule" });
    });
  });

  it("adds, removes and replaces receptionists on many articles at once, or opens them to everyone", async () => {
    await rollbackTest(async (tx) => {
      const { businessId, userId, front, gastown, kitsilano } = await seedStores(tx);
      const menu = await addDocument(tx, businessId, { title: "Menu" });
      const gastownPage = await addDocument(tx, businessId, { title: "Gastown store" });
      const hours = await addSnippet(tx, businessId, { title: "Hours" });
      await asOwner(tx, { userId, businessId });
      await setKnowledgeArticleAudienceInTransaction(tx, { businessId, actorUserId: userId, kind: "document", articleId: gastownPage, choice: { audience: "chosen", receptionistIds: [gastown.id] } });
      const change = async (values: Parameters<typeof changeKnowledgeAudienceInTransaction>[1]["change"]) => {
        await asOwner(tx, { userId, businessId });
        return await changeKnowledgeAudienceInTransaction(tx, { businessId, actorUserId: userId, change: values });
      };

      // Adding leaves articles for everyone as they are: everyone includes the new receptionist already.
      expect(await change({ documentIds: [menu, gastownPage], snippetIds: [hours], audience: "chosen", mode: "add", receptionistIds: [kitsilano.id] })).toEqual({ documents: 2, snippets: 1 });
      expect(await audienceOf(tx, "document", menu)).toEqual({ audience: "everyone", receptionistIds: [] });
      expect(await audienceOf(tx, "document", gastownPage)).toEqual({ audience: "chosen", receptionistIds: sorted(gastown.id, kitsilano.id) });
      expect(await audienceOf(tx, "snippet", hours)).toEqual({ audience: "everyone", receptionistIds: [] });

      // Removing from an article for everyone leaves it to every other receptionist.
      await change({ documentIds: [menu, gastownPage], snippetIds: [hours], audience: "chosen", mode: "remove", receptionistIds: [gastown.id] });
      expect(await audienceOf(tx, "document", menu)).toEqual({ audience: "chosen", receptionistIds: sorted(front.id, kitsilano.id) });
      expect(await audienceOf(tx, "document", gastownPage)).toEqual({ audience: "chosen", receptionistIds: [kitsilano.id] });
      expect(await audienceOf(tx, "snippet", hours)).toEqual({ audience: "chosen", receptionistIds: sorted(front.id, kitsilano.id) });

      await change({ documentIds: [menu, gastownPage], snippetIds: [hours], audience: "chosen", mode: "replace", receptionistIds: [gastown.id] });
      for (const [kind, id] of [["document", menu], ["document", gastownPage], ["snippet", hours]] as const) {
        expect(await audienceOf(tx, kind, id)).toEqual({ audience: "chosen", receptionistIds: [gastown.id] });
      }

      expect(await change({ documentIds: [gastownPage, randomUUID()], snippetIds: [], audience: "everyone" })).toEqual({ documents: 1, snippets: 0 });
      expect(await audienceOf(tx, "document", gastownPage)).toEqual({ audience: "everyone", receptionistIds: [] });

      // One audit entry per change, naming the articles it covered.
      await as(tx, null);
      // In no set order: rows a transaction writes all take its start time as created_at.
      const audits = await tx.select().from(auditLogs).where(and(eq(auditLogs.businessId, businessId), eq(auditLogs.eventType, "knowledge.audience_changed"), eq(auditLogs.entityType, "knowledge")));
      expect(audits).toHaveLength(4);
      expect(audits.map((audit) => audit.payload)).toEqual(expect.arrayContaining([
        { audience: "chosen", mode: "add", receptionistIds: [kitsilano.id], documentIds: sorted(menu, gastownPage), snippetIds: [hours] },
        { audience: "chosen", mode: "remove", receptionistIds: [gastown.id], documentIds: sorted(menu, gastownPage), snippetIds: [hours] },
        { audience: "chosen", mode: "replace", receptionistIds: [gastown.id], documentIds: sorted(menu, gastownPage), snippetIds: [hours] },
        { audience: "everyone", documentIds: [gastownPage], snippetIds: [] },
      ]));

      // An archived receptionist can be removed, never added.
      await asOwner(tx, { userId, businessId });
      await archiveReceptionistInTransaction(tx, { businessId, actorUserId: userId, receptionistId: gastown.id });
      await asOwner(tx, { userId, businessId });
      expect(await failure(tx, (inner) => changeKnowledgeAudienceInTransaction(inner, { businessId, actorUserId: userId, change: { documentIds: [menu], snippetIds: [], audience: "chosen", mode: "add", receptionistIds: [gastown.id] } })))
        .toMatchObject({ status: 409, code: "receptionist_archived" });
      await change({ documentIds: [menu], snippetIds: [hours], audience: "chosen", mode: "remove", receptionistIds: [gastown.id] });
      expect(await audienceOf(tx, "document", menu)).toEqual({ audience: "chosen", receptionistIds: [] });

      // The Knowledge page lists every link, archived receptionists' too.
      await asOwner(tx, { userId, businessId });
      await changeKnowledgeAudienceInTransaction(tx, { businessId, actorUserId: userId, change: { documentIds: [gastownPage], snippetIds: [], audience: "chosen", mode: "replace", receptionistIds: [kitsilano.id] } });
      await asOwner(tx, { userId, businessId });
      const links = await knowledgeAudienceLinksInTransaction(tx, { businessId });
      expect(links.documents[gastownPage]).toEqual([{ receptionistId: kitsilano.id, websiteRuleId: null }]);
      expect(links.documents[menu]).toBeUndefined();
    });
  });

  it("gives a crawled site's pages under a path to a receptionist, on every crawl, until the rule goes", async () => {
    await rollbackTest(async (tx) => {
      const { businessId, userId, gastown, kitsilano } = await seedStores(tx);
      const site = await addWebsite(tx, businessId);
      const page = (path: string, siteUrl = "https://kitsilanocoffee.ca") => addDocument(tx, businessId, { title: path, sourceType: "website", sourceUrl: `${siteUrl}${path}` });
      const store = await page("/stores/gastown");
      const storeMenu = await page("/stores/gastown/menu");
      const lookalike = await page("/stores/gastownish");
      const about = await page("/about");
      const elsewhere = await page("/stores/gastown", "https://other.example");
      // The same site over www. and HTTP, a page saved with its last slash, and a lookalike path there.
      const storeHours = await page("/stores/gastown/hours", "https://www.kitsilanocoffee.ca");
      const storeParking = await page("/stores/gastown/parking", "http://kitsilanocoffee.ca");
      const storeDeals = await page("/stores/gastown/deals/", "http://www.kitsilanocoffee.ca");
      const otherPath = await page("/stores/gastownish/hours", "https://www.kitsilanocoffee.ca");
      const upload = await addDocument(tx, businessId, { title: "Menu PDF" });

      await asOwner(tx, { userId, businessId });
      const rule = await createWebsiteRuleInTransaction(tx, { businessId, actorUserId: userId, rule: { rootDocumentId: site, pathPrefix: "/stores/gastown/", receptionistId: gastown.id } });
      expect(rule).toMatchObject({ rootDocumentId: site, siteUrl: "https://kitsilanocoffee.ca/", pathPrefix: "/stores/gastown/", receptionistId: gastown.id, pages: 5 });
      for (const id of [store, storeMenu, storeHours, storeParking, storeDeals]) expect(await audienceOf(tx, "document", id)).toEqual({ audience: "chosen", receptionistIds: [gastown.id] });
      for (const id of [lookalike, about, elsewhere, otherPath, site]) expect(await audienceOf(tx, "document", id)).toEqual({ audience: "everyone", receptionistIds: [] });
      await asOwner(tx, { userId, businessId });
      expect((await knowledgeAudienceLinksInTransaction(tx, { businessId })).documents[store]).toEqual([{ receptionistId: gastown.id, websiteRuleId: rule.id }]);
      await asOwner(tx, { userId, businessId });
      expect(await listWebsiteRulesInTransaction(tx, { businessId })).toEqual([expect.objectContaining({ id: rule.id, pages: 5, siteUrl: "https://kitsilanocoffee.ca/" })]);

      // The same rule twice, a file instead of a site, and an archived receptionist.
      await asOwner(tx, { userId, businessId });
      const create = (values: { rootDocumentId: string; pathPrefix: string; receptionistId: string }) => failure(tx, (inner) => createWebsiteRuleInTransaction(inner, { businessId, actorUserId: userId, rule: values }));
      expect(await create({ rootDocumentId: site, pathPrefix: "/stores/gastown/", receptionistId: gastown.id })).toMatchObject({ status: 409, code: "website_rule_exists" });
      expect(await create({ rootDocumentId: upload, pathPrefix: "/stores/", receptionistId: gastown.id })).toMatchObject({ status: 400, code: "invalid_website_rule" });
      expect(await create({ rootDocumentId: randomUUID(), pathPrefix: "/stores/", receptionistId: gastown.id })).toMatchObject({ status: 404, code: "knowledge_not_found" });

      // A page crawled later falls under the rule as it is indexed.
      const deals = await page("/stores/gastown/deals");
      await as(tx, "lobbystack_worker");
      await tx.execute(rlsContextStatement({ businessId, actorType: "worker" }));
      expect(await applyWebsiteRulesInTransaction(tx, { businessId, rootDocumentId: site, documentIds: [deals, about] })).toBe(1);
      expect(await audienceOf(tx, "document", deals)).toEqual({ audience: "chosen", receptionistIds: [gastown.id] });

      // Someone also chooses Kitsilano for the store page, and Gastown for the menu page by hand.
      await asOwner(tx, { userId, businessId });
      await changeKnowledgeAudienceInTransaction(tx, { businessId, actorUserId: userId, change: { documentIds: [store], snippetIds: [], audience: "chosen", mode: "add", receptionistIds: [kitsilano.id] } });
      await asOwner(tx, { userId, businessId });
      await changeKnowledgeAudienceInTransaction(tx, { businessId, actorUserId: userId, change: { documentIds: [storeMenu], snippetIds: [], audience: "chosen", mode: "add", receptionistIds: [gastown.id] } });

      // Deleting the rule takes its links; a page chosen for nobody goes back to everyone.
      await asOwner(tx, { userId, businessId });
      expect(await deleteWebsiteRuleInTransaction(tx, { businessId, actorUserId: userId, ruleId: rule.id })).toBe(true);
      expect(await audienceOf(tx, "document", store)).toEqual({ audience: "chosen", receptionistIds: [kitsilano.id] });
      expect(await audienceOf(tx, "document", storeMenu)).toEqual({ audience: "chosen", receptionistIds: [gastown.id] });
      expect(await audienceOf(tx, "document", deals)).toEqual({ audience: "everyone", receptionistIds: [] });
      await asOwner(tx, { userId, businessId });
      expect(await deleteWebsiteRuleInTransaction(tx, { businessId, actorUserId: userId, ruleId: rule.id })).toBe(false);
      await as(tx, null);
      expect((await tx.select().from(auditLogs).where(and(eq(auditLogs.businessId, businessId), eq(auditLogs.entityId, rule.id)))).map((audit) => audit.eventType).sort())
        .toEqual(["website_rule.created", "website_rule.deleted"]);

      // A rule for a receptionist archived since waits until it is restored.
      await asOwner(tx, { userId, businessId });
      const kitsilanoRule = await createWebsiteRuleInTransaction(tx, { businessId, actorUserId: userId, rule: { rootDocumentId: site, pathPrefix: "/about/", receptionistId: kitsilano.id } });
      expect(kitsilanoRule.pages).toBe(1);
      await asOwner(tx, { userId, businessId });
      await archiveReceptionistInTransaction(tx, { businessId, actorUserId: userId, receptionistId: kitsilano.id });
      const team = await page("/about/team");
      await as(tx, "lobbystack_worker");
      await tx.execute(rlsContextStatement({ businessId, actorType: "worker" }));
      expect(await applyWebsiteRulesInTransaction(tx, { businessId, rootDocumentId: site, documentIds: [team] })).toBe(0);
      await asOwner(tx, { userId, businessId });
      expect(await create({ rootDocumentId: site, pathPrefix: "/team/", receptionistId: kitsilano.id })).toMatchObject({ status: 409, code: "receptionist_archived" });
      await as(tx, null);
      expect(await tx.select().from(knowledgeWebsiteRules).where(eq(knowledgeWebsiteRules.businessId, businessId))).toHaveLength(1);
    });
  });

  it("keeps the pages another rule gives the same receptionist when one rule goes", async () => {
    await rollbackTest(async (tx) => {
      const { businessId, userId, gastown } = await seedStores(tx);
      const site = await addWebsite(tx, businessId);
      // The same site's stores section, added as a website of its own.
      const storesSite = await addWebsite(tx, businessId, "https://kitsilanocoffee.ca/stores/");
      const page = (path: string) => addDocument(tx, businessId, { title: path, sourceType: "website", sourceUrl: `https://kitsilanocoffee.ca${path}` });
      const store = await page("/stores/gastown");
      const menu = await page("/stores/gastown/menu");
      const other = await page("/stores/kitsilano");
      const rule = async (rootDocumentId: string, pathPrefix: string) => {
        await asOwner(tx, { userId, businessId });
        return await createWebsiteRuleInTransaction(tx, { businessId, actorUserId: userId, rule: { rootDocumentId, pathPrefix, receptionistId: gastown.id } });
      };
      const links = async (documentId: string) => {
        await asOwner(tx, { userId, businessId });
        return (await knowledgeAudienceLinksInTransaction(tx, { businessId })).documents[documentId] ?? [];
      };
      const remove = async (ruleId: string) => {
        await asOwner(tx, { userId, businessId });
        expect(await deleteWebsiteRuleInTransaction(tx, { businessId, actorUserId: userId, ruleId })).toBe(true);
      };
      // Three rules give the Gastown pages to Gastown. The widest came first, so the links name it.
      const wide = await rule(site, "/stores/");
      const narrow = await rule(site, "/stores/gastown/");
      const menuRule = await rule(storesSite, "/stores/gastown/menu/");
      expect(await links(store)).toEqual([{ receptionistId: gastown.id, websiteRuleId: wide.id }]);
      expect(await links(menu)).toEqual([{ receptionistId: gastown.id, websiteRuleId: wide.id }]);

      // Without the widest rule, the pages the other two cover stay Gastown's, linked by those rules.
      await remove(wide.id);
      expect(await audienceOf(tx, "document", store)).toEqual({ audience: "chosen", receptionistIds: [gastown.id] });
      expect(await audienceOf(tx, "document", menu)).toEqual({ audience: "chosen", receptionistIds: [gastown.id] });
      expect(await audienceOf(tx, "document", other)).toEqual({ audience: "everyone", receptionistIds: [] });
      expect(await links(store)).toEqual([{ receptionistId: gastown.id, websiteRuleId: narrow.id }]);
      // Both remaining rules cover the menu; the one made first links it (here, made in the same transaction, either).
      const [menuLink] = await links(menu);
      expect(menuLink?.receptionistId).toBe(gastown.id);
      expect([narrow.id, menuRule.id]).toContain(menuLink?.websiteRuleId);

      // Without the narrow one, the menu stays Gastown's through the stores site's rule.
      await remove(narrow.id);
      expect(await audienceOf(tx, "document", store)).toEqual({ audience: "everyone", receptionistIds: [] });
      expect(await links(menu)).toEqual([{ receptionistId: gastown.id, websiteRuleId: menuRule.id }]);
      await remove(menuRule.id);
      expect(await audienceOf(tx, "document", menu)).toEqual({ audience: "everyone", receptionistIds: [] });
    });
  });

  it("ranks each receptionist's articles, stopping at the limit, links to archived receptionists left to the default", async () => {
    await rollbackTest(async (tx) => {
      const { businessId, userId, front, gastown, kitsilano } = await seedStores(tx);
      const hours = await addSnippet(tx, businessId, { title: "Hours", priority: 5 });
      const gastownParking = await addSnippet(tx, businessId, { title: "Gastown parking", priority: 3 });
      const kitsilanoPatio = await addSnippet(tx, businessId, { title: "Kitsilano patio", priority: 4 });
      const wifi = await addSnippet(tx, businessId, { title: "Wifi", priority: 1 });
      await asOwner(tx, { userId, businessId });
      await changeKnowledgeAudienceInTransaction(tx, { businessId, actorUserId: userId, change: { documentIds: [], snippetIds: [gastownParking], audience: "chosen", mode: "replace", receptionistIds: [gastown.id] } });
      await asOwner(tx, { userId, businessId });
      await changeKnowledgeAudienceInTransaction(tx, { businessId, actorUserId: userId, change: { documentIds: [], snippetIds: [kitsilanoPatio], audience: "chosen", mode: "replace", receptionistIds: [kitsilano.id] } });

      const rank = async (limit: number, receptionists = [front, gastown, kitsilano]) => {
        await as(tx, "lobbystack_worker");
        await tx.execute(rlsContextStatement({ businessId, actorType: "worker" }));
        return await rankArticlesForReceptionists(tx, { businessId, kind: "snippets", limit, receptionists: receptionists.map((row) => ({ id: row.id, isDefault: row.isDefault, status: row.status, knowledgeScope: row.knowledgeScope })) });
      };
      const ranked = await rank(3);
      expect(ranked.get(front.id)).toEqual([hours, kitsilanoPatio, gastownParking]);
      expect(ranked.get(gastown.id)).toEqual([hours, gastownParking, wifi]);
      expect(ranked.get(kitsilano.id)).toEqual([hours, kitsilanoPatio, wifi]);
      expect((await rank(1)).get(gastown.id)).toEqual([hours]);

      // A paused receptionist doesn't answer; the default always does.
      expect((await rank(3, [front, { ...kitsilano, status: "paused" }])).has(kitsilano.id)).toBe(false);
      expect((await rank(3, [{ ...front, status: "paused" }])).get(front.id)).toEqual([hours, kitsilanoPatio, gastownParking]);

      // A default limited to its audience gets the entries chosen only for archived receptionists.
      await asOwner(tx, { userId, businessId });
      await archiveReceptionistInTransaction(tx, { businessId, actorUserId: userId, receptionistId: kitsilano.id });
      expect((await rank(4, [{ ...front, knowledgeScope: "audience" }, gastown])).get(front.id)).toEqual([hours, kitsilanoPatio, wifi]);
      expect((await rank(4, [{ ...front, knowledgeScope: "audience" }, gastown])).get(gastown.id)).toEqual([hours, gastownParking, wifi]);
    });
  });

  it("builds one snapshot holding every receptionist's view, the shared settings on the business", async () => {
    await rollbackTest(async (tx) => {
      vi.stubEnv("APP_BASE_URL", "https://demo.example/");
      const { context, businessId, userId, front, gastown, kitsilano } = await seedStores(tx);
      await asOwner(tx, { userId, businessId });
      const catering = await createReceptionistInTransaction(tx, { businessId, actorUserId: userId, receptionist: { name: "Catering", description: "Events and large orders", listed: false }, env });
      await asOwner(tx, { userId, businessId });
      await setReceptionistStatusInTransaction(tx, { businessId, actorUserId: userId, receptionistId: kitsilano.id, status: "paused", env });
      await as(tx, null);
      await tx.update(receptionistProfiles).set({ greeting: "Bonjour, Gastown!", bookingMode: "request", locale: "fr", chatInstructions: "Answer as the Gastown store." }).where(eq(receptionistProfiles.id, gastown.id));
      await tx.update(businesses).set({ summary: "Coffee and pastries in Vancouver.", summarySource: "generated", recordingNotice: false }).where(eq(businesses.id, businessId));
      await tx.insert(businessPublicProfiles).values({ businessId, published: true });
      const [{ slug }] = await tx.select({ slug: businesses.slug }).from(businesses).where(eq(businesses.id, businessId)) as [{ slug: string }];

      const hours = await addSnippet(tx, businessId, { title: "Hours", priority: 5 });
      const gastownParking = await addSnippet(tx, businessId, { title: "Gastown parking", priority: 3 });
      const menu = await addDocument(tx, businessId, { title: "Menu", updatedAt: new Date("2026-11-01T12:00:00Z") });
      const gastownPage = await addDocument(tx, businessId, { title: "Gastown store", updatedAt: new Date("2026-11-02T12:00:00Z") });
      const kitsilanoPage = await addDocument(tx, businessId, { title: "Kitsilano store", updatedAt: new Date("2026-11-03T12:00:00Z") });
      await addDocument(tx, businessId, { title: "Still reading", status: "processing" });
      await asOwner(tx, { userId, businessId });
      await changeKnowledgeAudienceInTransaction(tx, { businessId, actorUserId: userId, change: { documentIds: [gastownPage], snippetIds: [gastownParking], audience: "chosen", mode: "replace", receptionistIds: [gastown.id] } });
      await asOwner(tx, { userId, businessId });
      await changeKnowledgeAudienceInTransaction(tx, { businessId, actorUserId: userId, change: { documentIds: [kitsilanoPage], snippetIds: [], audience: "chosen", mode: "replace", receptionistIds: [kitsilano.id] } });

      await as(tx, "lobbystack_worker");
      await refreshBusinessSnapshot(context, { businessId });
      const snapshot = (await loadLatestBusinessSnapshot(context, { businessId }))!;
      const businessPage = `https://demo.example/profile/${slug}`;

      // The stored fields are the default receptionist's view, with the business's shared settings.
      expect(snapshot).toMatchObject({ summary: "Coffee and pastries in Vancouver.", recordingNotice: false, publicPageUrl: businessPage, defaultLocale: "en" });
      expect(snapshot.knowledgeSnippets?.map((entry) => entry.id)).toEqual([hours, gastownParking]);
      expect(snapshot.knowledgeDigest.split("\n").map((line) => JSON.parse(line).title)).toEqual(["Kitsilano store", "Gastown store", "Menu"]);
      // In the list's order: the default, then by name while the owner hasn't moved any.
      expect(snapshot.receptionists?.map((entry) => [entry.name, entry.status, entry.listed, entry.pageUrl ?? null])).toEqual([
        [front.name, "active", true, businessPage],
        ["Catering", "active", false, `${businessPage}/catering`],
        ["Gastown store", "active", true, `${businessPage}/gastown-store`],
        ["Kitsilano store", "paused", true, `${businessPage}/kitsilano-store`],
      ]);
      expect(snapshot.receptionists?.find((entry) => entry.id === gastown.id)).toMatchObject({ snippetIds: [hours, gastownParking], greeting: "Bonjour, Gastown!", bookingMode: "request", locale: "fr", chatInstructions: "Answer as the Gastown store." });
      expect(snapshot.receptionists?.find((entry) => entry.id === catering.id)?.snippetIds).toEqual([hours]);
      // Several views, so the documents keep their audiences for the cut.
      expect(snapshot.knowledgeDocuments?.map((entry) => entry.title)).toEqual(["Kitsilano store", "Gastown store", "Menu"]);

      const gastownView = snapshotForReceptionist(snapshot, gastown.id);
      expect(gastownView).toMatchObject({ greeting: "Bonjour, Gastown!", defaultLocale: "fr", summary: "Coffee and pastries in Vancouver.", recordingNotice: false });
      expect(gastownView.knowledgeSnippets?.map((entry) => entry.id)).toEqual([hours, gastownParking]);
      expect(gastownView.knowledgeDigest.split("\n").map((line) => JSON.parse(line).title)).toEqual(["Gastown store", "Menu"]);
      expect(gastownView.otherReceptionists).toEqual([{ name: front.name, description: front.description, pageUrl: businessPage }]);
      expect(snapshotForReceptionist(snapshot, catering.id).knowledgeDigest.split("\n").map((line) => JSON.parse(line).title)).toEqual(["Menu"]);
      // A paused receptionist's number answers as the default.
      expect(snapshotForReceptionist(snapshot, kitsilano.id)).toEqual(snapshotForReceptionist(snapshot, null));

      // No address for the deployment, or an unpublished page, leaves the addresses out.
      const refreshedWithout = async () => {
        // Refreshes in one test transaction share a generated_at, so the older snapshot goes first.
        await as(tx, null);
        await tx.delete(businessContextSnapshots).where(eq(businessContextSnapshots.businessId, businessId));
        await as(tx, "lobbystack_worker");
        await refreshBusinessSnapshot(context, { businessId });
        const refreshed = (await loadLatestBusinessSnapshot(context, { businessId }))!;
        expect(refreshed).not.toHaveProperty("publicPageUrl");
        expect(refreshed.receptionists?.every((entry) => entry.pageUrl === undefined)).toBe(true);
      };
      vi.stubEnv("APP_BASE_URL", "");
      await refreshedWithout();
      vi.stubEnv("APP_BASE_URL", "https://demo.example");
      await as(tx, null);
      await tx.update(businessPublicProfiles).set({ published: false }).where(eq(businessPublicProfiles.businessId, businessId));
      await refreshedWithout();
    });
  });

  it("builds no snapshot for a business without its default receptionist, which the database never leaves", async () => {
    await rollbackTest(async (tx) => {
      const { context, businessId, front } = await seedBusiness(tx);
      await as(tx, "lobbystack_worker");
      await refreshBusinessSnapshot(context, { businessId });
      const built = (await loadLatestBusinessSnapshot(context, { businessId }))!;
      expect(built.receptionists?.map((receptionist) => [receptionist.id, receptionist.isDefault])).toEqual([[front.id, true]]);
      expect(built).toMatchObject({ greeting: front.greeting, bookingPolicy: front.bookingPolicy });

      // Only a delete outside the code can take the default receptionist away. The refresh then fails rather than make one up, and calls keep the last snapshot.
      await as(tx, null);
      await tx.delete(receptionistProfiles).where(eq(receptionistProfiles.businessId, businessId));
      await as(tx, "lobbystack_worker");
      await expect(refreshBusinessSnapshot(context, { businessId })).rejects.toThrow("The business has no default receptionist.");
      expect((await loadLatestBusinessSnapshot(context, { businessId }))?.version).toBe(built.version);
    });
  });

  it("searches only the documents the receptionist answering may use", async () => {
    await rollbackTest(async (tx) => {
      const { context, businessId, userId, front, gastown, kitsilano } = await seedStores(tx);
      await asOwner(tx, { userId, businessId });
      const closed = await createReceptionistInTransaction(tx, { businessId, actorUserId: userId, receptionist: { name: "Old store" }, env });
      const menu = await addDocument(tx, businessId, { title: "Menu", content: "Street parking near every store." });
      const gastownPage = await addDocument(tx, businessId, { title: "Gastown store", content: "Gastown parking is behind the store." });
      const kitsilanoPage = await addDocument(tx, businessId, { title: "Kitsilano store", content: "Kitsilano parking is on 4th Avenue." });
      const oldPage = await addDocument(tx, businessId, { title: "Old store", content: "Old store parking is gone." });
      for (const [documentId, receptionistId] of [[gastownPage, gastown.id], [kitsilanoPage, kitsilano.id], [oldPage, closed.id]] as const) {
        await asOwner(tx, { userId, businessId });
        await changeKnowledgeAudienceInTransaction(tx, { businessId, actorUserId: userId, change: { documentIds: [documentId], snippetIds: [], audience: "chosen", mode: "replace", receptionistIds: [receptionistId] } });
      }
      await asOwner(tx, { userId, businessId });
      await archiveReceptionistInTransaction(tx, { businessId, actorUserId: userId, receptionistId: closed.id });

      const titles = async (receptionistId?: string | null) => {
        await as(tx, "lobbystack_worker");
        const result = await searchKnowledgeEvidence(context, { businessId, query: "parking", receptionistId });
        expect(result).toMatchObject({ mode: "keyword", outcome: "found" });
        const found = result.matches.map((match) => match.title).sort();
        // The API's trace counts what the same receptionist may use: here one chunk per article, each about parking.
        const { trace } = await traceKnowledgeSearch(context, { businessId, query: "parking", receptionistId });
        expect(trace.index).toEqual({ sources: found.length, chunks: found.length, embeddedChunks: 0 });
        return found;
      };
      const everything = ["Gastown store", "Kitsilano store", "Menu", "Old store"];
      expect(await titles(gastown.id)).toEqual(["Gastown store", "Menu"]);
      expect(await titles(kitsilano.id)).toEqual(["Kitsilano store", "Menu"]);
      // The default sees every article; a paused, archived, unknown or missing receptionist answers as the default.
      expect(await titles(front.id)).toEqual(everything);
      expect(await titles(undefined)).toEqual(everything);
      expect(await titles(closed.id)).toEqual(everything);
      expect(await titles("not-an-id")).toEqual(everything);
      await asOwner(tx, { userId, businessId });
      await setReceptionistStatusInTransaction(tx, { businessId, actorUserId: userId, receptionistId: gastown.id, status: "paused", env });
      expect(await titles(gastown.id)).toEqual(everything);

      // A default limited to its audience also answers from documents chosen only for archived receptionists.
      await asOwner(tx, { userId, businessId });
      await updateReceptionistInTransaction(tx, { businessId, actorUserId: userId, receptionistId: front.id, patch: { knowledgeScope: "audience" } });
      expect(await titles(front.id)).toEqual(["Menu", "Old store"]);
      expect(await titles(kitsilano.id)).toEqual(["Kitsilano store", "Menu"]);
      // A receptionist that sees every article sees them all.
      await asOwner(tx, { userId, businessId });
      await updateReceptionistInTransaction(tx, { businessId, actorUserId: userId, receptionistId: kitsilano.id, patch: { knowledgeScope: "all" } });
      expect(await titles(kitsilano.id)).toEqual(everything);
      void menu;
    });
  });

  it("writes the summary and the opening hours from articles for everyone only", async () => {
    await rollbackTest(async (tx) => {
      const { context, businessId, userId, gastown } = await seedStores(tx);
      await addSnippet(tx, businessId, { title: "Opening hours", content: "Open Monday to Sunday, 7am to 7pm.", priority: 2 });
      const storeHours = await addSnippet(tx, businessId, { title: "Gastown hours", content: "Gastown is open Monday to Friday, 9am to 5pm.", priority: 1 });
      const storePage = await addDocument(tx, businessId, { title: "Gastown store", content: "Gastown hours: Monday to Friday 9:00 to 17:00." });
      await asOwner(tx, { userId, businessId });
      await changeKnowledgeAudienceInTransaction(tx, { businessId, actorUserId: userId, change: { documentIds: [storePage], snippetIds: [storeHours], audience: "chosen", mode: "replace", receptionistIds: [gastown.id] } });
      await as(tx, "lobbystack_worker");
      const hoursInput = await loadBusinessHoursInput(context, { businessId });
      expect(hoursInput?.sources.map((source) => source.title)).toEqual(["Opening hours"]);
      const summaryInput = await loadBusinessSummaryInput(context, { businessId });
      expect(summaryInput?.sources.map((source) => source.title)).toEqual(["Opening hours"]);
    });
  });
});
