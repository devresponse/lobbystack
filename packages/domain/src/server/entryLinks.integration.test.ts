import { createHash, randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  auditLogs,
  billingAccounts,
  businessPublicProfiles,
  businesses,
  createDatabaseClient,
  entryLinkDailyScans,
  phoneNumbers,
  receptionistProfiles,
  rlsContextStatement,
  users,
  widgetKeys,
  type Database,
  type DatabaseTransaction,
} from "@lobbystack/db";
import { MAX_ENTRY_LINKS_PER_BUSINESS } from "@lobbystack/shared";

import { createEntryLinkInTransaction, deleteExpiredEntryLinkScansInTransaction, followEntryLink, getEntryLinkInTransaction, listEntryLinkScansInTransaction, listEntryLinksInTransaction, updateEntryLinkInTransaction } from "./entryLinks";
import { getPublicProfilePage } from "./publicProfiles";
import { archiveReceptionistInTransaction, createReceptionistInTransaction, setReceptionistStatusInTransaction, updateReceptionistInTransaction } from "./receptionists";
import { createBusiness } from "./tenancy";

// Explicit opt-in only; never fall back to DATABASE_URL or load an env file.
const testUrl = process.env.LOBBYSTACK_RELIABILITY_TEST_DATABASE_URL;
if (testUrl) {
  const url = new URL(testUrl);
  if (process.env.NODE_ENV === "production" || !["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname) || !/test/i.test(url.pathname)) {
    throw new Error("QR link integration tests require a dedicated local test database.");
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

async function as(tx: DatabaseTransaction, role: "lobbystack_app" | "lobbystack_worker" | null) {
  await tx.execute(sql`reset role`);
  if (role) await tx.execute(sql.raw(`set local role ${role}`));
}

/** Acts as a user in the dashboard: the app role under the business's row level security. */
async function asOwner(tx: DatabaseTransaction, input: { userId: string; businessId: string }) {
  await as(tx, "lobbystack_app");
  await tx.execute(rlsContextStatement({ userId: input.userId, businessId: input.businessId, actorType: "operator" }));
}

/** Runs a step that should fail in a savepoint, so the transaction goes on after it. */
async function failure(tx: DatabaseTransaction, run: (inner: DatabaseTransaction) => Promise<unknown>): Promise<unknown> {
  return await tx.transaction(async (inner) => { await run(inner); }).then(() => null, (error: unknown) => error);
}

/** Random indexes that spell the codes given, letter by letter, from the code alphabet. */
function spelling(...codes: string[]) {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const indexes = codes.flatMap((code) => Array.from(code, (letter) => alphabet.indexOf(letter)));
  let next = 0;
  return () => indexes[next++ % indexes.length]!;
}

/**
 * A Pro coffee chain: the front desk, its default receptionist, and a
 * receptionist for its Gastown store. Its page is published with a widget.
 */
async function seedChain(tx: DatabaseTransaction, name = "Kitsilano Coffee") {
  const userId = randomUUID();
  await tx.insert(users).values({ id: userId, email: `${userId}@example.invalid`, normalizedEmail: `${userId}@example.invalid`, name: "Riley Owner" });
  await as(tx, "lobbystack_app");
  const context = { db: tx as unknown as Database };
  const { businessId } = await createBusiness(context, { userId, name, timezone: "America/Vancouver", businessType: "restaurant", deploymentMode: "cloud" });
  await as(tx, null);
  await tx.insert(billingAccounts).values({ businessId, billingKey: `business:${businessId}`, plan: "pro", subscriptionState: "active", source: "polar" });
  const [main] = await tx.select().from(receptionistProfiles).where(and(eq(receptionistProfiles.businessId, businessId), eq(receptionistProfiles.isDefault, true)));
  const [business] = await tx.select({ slug: businesses.slug }).from(businesses).where(eq(businesses.id, businessId));
  await asOwner(tx, { userId, businessId });
  const store = await createReceptionistInTransaction(tx, { businessId, actorUserId: userId, receptionist: { name: "Gastown store", description: "Orders at Gastown", handle: "gastown" } });
  await as(tx, null);
  const keyValue = `wk_test_${randomUUID().replaceAll("-", "")}`;
  const [widget] = await tx.insert(widgetKeys).values({ businessId, keyHash: createHash("sha256").update(keyValue).digest("hex"), keyValue, status: "active" }).returning({ id: widgetKeys.id });
  await tx.insert(businessPublicProfiles).values({ businessId, published: true, publishedAt: new Date(), widgetKeyId: widget!.id });
  return { context, userId, businessId, slug: business!.slug, mainId: main!.id, storeId: store.id, widgetKeyId: widget!.id, keyValue };
}

type Chain = Awaited<ReturnType<typeof seedChain>>;

/** Runs a dashboard step as the chain's owner, then hands the connection back to the migrator. */
async function owner<T>(tx: DatabaseTransaction, chain: Chain, run: () => Promise<T>): Promise<T> {
  await asOwner(tx, { userId: chain.userId, businessId: chain.businessId });
  try {
    return await run();
  } finally {
    await as(tx, null);
  }
}

/** Follows a scan as the public /q/<code> route does: the worker role, with no business context. */
async function scan(tx: DatabaseTransaction, code: string, input: { count?: boolean; now?: Date } = {}) {
  await as(tx, "lobbystack_worker");
  try {
    return await followEntryLink({ db: tx as unknown as Database }, { code, ...input });
  } finally {
    await as(tx, null);
  }
}

/** Reads a page as /profile/<slug>[/<handle>] does: the worker role. */
async function page(tx: DatabaseTransaction, input: { slug: string; handle?: string; previewUserId?: string }) {
  await as(tx, "lobbystack_worker");
  try {
    return await getPublicProfilePage({ db: tx as unknown as Database }, input);
  } finally {
    await as(tx, null);
  }
}

describe.skipIf(!testUrl)("QR links, against PostgreSQL under RLS", () => {
  it("adds a link with a new code for a receptionist, records who did, and lists it with no scans yet", async () => {
    await rollbackTest(async (tx) => {
      const chain = await seedChain(tx);
      const link = await owner(tx, chain, () => createEntryLinkInTransaction(tx, { businessId: chain.businessId, actorUserId: chain.userId, link: { receptionistId: chain.storeId, label: "Front window" } }));
      expect(link).toMatchObject({ label: "Front window", status: "active", receptionistId: chain.storeId, opensReceptionistId: chain.storeId, scansLast30Days: 0, scansKept: 0, lastScannedOn: null });
      expect(link.code).toMatch(/^[abcdefghjkmnpqrstuvwxyz23456789]{6}$/);
      const [audit] = await tx.select().from(auditLogs).where(and(eq(auditLogs.businessId, chain.businessId), eq(auditLogs.eventType, "entry_link.created")));
      expect(audit).toMatchObject({ actorUserId: chain.userId, entityType: "entry_link", entityId: link.id, payload: { code: link.code, receptionistId: chain.storeId, label: "Front window" } });
      const listed = await owner(tx, chain, () => listEntryLinksInTransaction(tx, { businessId: chain.businessId }));
      expect(listed).toMatchObject({ total: 1, page: 1, pageSize: 10, links: [{ id: link.id, code: link.code }] });
    });
  });

  it("tries another code when one is taken anywhere on the deployment, and gives up after a few", async () => {
    await rollbackTest(async (tx) => {
      const chain = await seedChain(tx);
      const other = await seedChain(tx, "Other Roasters");
      await owner(tx, other, () => createEntryLinkInTransaction(tx, { businessId: other.businessId, actorUserId: other.userId, link: { receptionistId: other.mainId, label: "" }, randomIndex: spelling("aaaaaa") }));
      const link = await owner(tx, chain, () => createEntryLinkInTransaction(tx, { businessId: chain.businessId, actorUserId: chain.userId, link: { receptionistId: chain.mainId, label: "" }, randomIndex: spelling("aaaaaa", "bbbbbb") }));
      expect(link.code).toBe("bbbbbb");
      const error = await owner(tx, chain, () => failure(tx, (inner) => createEntryLinkInTransaction(inner, { businessId: chain.businessId, actorUserId: chain.userId, link: { receptionistId: chain.mainId, label: "" }, randomIndex: spelling("aaaaaa") })));
      expect(error).toMatchObject({ status: 503, code: "entry_link_code_unavailable" });
    });
  });

  it("only opens the business's own receptionists that aren't archived", async () => {
    await rollbackTest(async (tx) => {
      const chain = await seedChain(tx);
      const other = await seedChain(tx, "Other Roasters");
      const add = (receptionistId: string) => owner(tx, chain, () => failure(tx, (inner) => createEntryLinkInTransaction(inner, { businessId: chain.businessId, actorUserId: chain.userId, link: { receptionistId, label: "" } })));
      expect(await add(other.storeId)).toMatchObject({ status: 404, code: "receptionist_not_found" });
      expect(await add(randomUUID())).toMatchObject({ status: 404, code: "receptionist_not_found" });
      await owner(tx, chain, () => archiveReceptionistInTransaction(tx, { businessId: chain.businessId, actorUserId: chain.userId, receptionistId: chain.storeId }));
      expect(await add(chain.storeId)).toMatchObject({ status: 404, code: "receptionist_not_found" });
    });
  });

  it("keeps at most the links a business may have", async () => {
    await rollbackTest(async (tx) => {
      const chain = await seedChain(tx);
      await tx.execute(sql`insert into public.entry_links (business_id, receptionist_id, code) select ${chain.businessId}::uuid, ${chain.mainId}::uuid, 'zz' || lpad(n::text, 8, '0') from generate_series(1, ${MAX_ENTRY_LINKS_PER_BUSINESS}) as n`);
      const error = await owner(tx, chain, () => failure(tx, (inner) => createEntryLinkInTransaction(inner, { businessId: chain.businessId, actorUserId: chain.userId, link: { receptionistId: chain.mainId, label: "" } })));
      expect(error).toMatchObject({ status: 409, code: "entry_link_limit" });
    });
  });

  it("changes a link's receptionist, label and status with an audit entry each time, and keeps its code", async () => {
    await rollbackTest(async (tx) => {
      const chain = await seedChain(tx);
      const link = await owner(tx, chain, () => createEntryLinkInTransaction(tx, { businessId: chain.businessId, actorUserId: chain.userId, link: { receptionistId: chain.mainId, label: "Counter" } }));
      const moved = await owner(tx, chain, () => updateEntryLinkInTransaction(tx, { businessId: chain.businessId, actorUserId: chain.userId, linkId: link.id, patch: { receptionistId: chain.storeId, label: "Counter, Gastown" } }));
      expect(moved).toMatchObject({ code: link.code, receptionistId: chain.storeId, opensReceptionistId: chain.storeId, label: "Counter, Gastown" });
      const paused = await owner(tx, chain, () => updateEntryLinkInTransaction(tx, { businessId: chain.businessId, actorUserId: chain.userId, linkId: link.id, patch: { status: "paused" } }));
      // A paused link opens the business page, so a printed sign still reaches someone.
      expect(paused).toMatchObject({ status: "paused", receptionistId: chain.storeId, opensReceptionistId: chain.mainId });
      // Saving what it already has changes nothing and records nothing.
      await owner(tx, chain, () => updateEntryLinkInTransaction(tx, { businessId: chain.businessId, actorUserId: chain.userId, linkId: link.id, patch: { status: "paused" } }));
      const audits = await tx.select({ payload: auditLogs.payload }).from(auditLogs).where(and(eq(auditLogs.businessId, chain.businessId), eq(auditLogs.eventType, "entry_link.updated"))).orderBy(auditLogs.createdAt);
      expect(audits.map((row) => row.payload)).toEqual([
        { receptionistId: { from: chain.mainId, to: chain.storeId }, label: { from: "Counter", to: "Counter, Gastown" } },
        { status: { from: "active", to: "paused" } },
      ]);
      expect(await owner(tx, chain, () => failure(tx, (inner) => updateEntryLinkInTransaction(inner, { businessId: chain.businessId, actorUserId: chain.userId, linkId: randomUUID(), patch: { label: "x" } })))).toMatchObject({ status: 404, code: "entry_link_not_found" });
    });
  });

  it("keeps each business's links to itself", async () => {
    await rollbackTest(async (tx) => {
      const chain = await seedChain(tx);
      const other = await seedChain(tx, "Other Roasters");
      const link = await owner(tx, chain, () => createEntryLinkInTransaction(tx, { businessId: chain.businessId, actorUserId: chain.userId, link: { receptionistId: chain.mainId, label: "Counter" } }));
      // The other business's owner, in their own business, can't see or change it by naming it.
      expect(await owner(tx, other, () => listEntryLinksInTransaction(tx, { businessId: chain.businessId }))).toMatchObject({ total: 0, links: [] });
      expect(await owner(tx, other, () => failure(tx, (inner) => updateEntryLinkInTransaction(inner, { businessId: other.businessId, actorUserId: other.userId, linkId: link.id, patch: { label: "Mine" } })))).toMatchObject({ status: 404 });
    });
  });

  it("follows a scan to the receptionist's page and counts it per day, with nothing about the visitor", async () => {
    await rollbackTest(async (tx) => {
      const chain = await seedChain(tx);
      const link = await owner(tx, chain, () => createEntryLinkInTransaction(tx, { businessId: chain.businessId, actorUserId: chain.userId, link: { receptionistId: chain.storeId, label: "Front window" } }));
      const monday = new Date("2026-11-02T18:00:00Z");
      const tuesday = new Date("2026-11-03T09:00:00Z");
      expect(await scan(tx, link.code.toUpperCase(), { now: monday })).toEqual({ businessId: chain.businessId, entryLinkId: link.id, receptionistId: chain.storeId, path: `/profile/${chain.slug}/gastown` });
      await scan(tx, ` ${link.code} `, { now: monday });
      await scan(tx, link.code, { now: tuesday });
      // A request that only looks, such as a link preview, isn't a scan.
      await scan(tx, link.code, { now: tuesday, count: false });
      const days = await tx.select({ day: entryLinkDailyScans.day, scans: entryLinkDailyScans.scans }).from(entryLinkDailyScans).where(eq(entryLinkDailyScans.entryLinkId, link.id)).orderBy(entryLinkDailyScans.day);
      expect(days).toEqual([{ day: "2026-11-02", scans: 2 }, { day: "2026-11-03", scans: 1 }]);
      const columns = await tx.execute<{ column_name: string }>(sql`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'entry_link_daily_scans' order by column_name`);
      expect(columns.rows.map((row) => row.column_name)).toEqual(["business_id", "day", "entry_link_id", "scans"]);
      const listed = await owner(tx, chain, () => listEntryLinksInTransaction(tx, { businessId: chain.businessId, now: tuesday }));
      expect(listed.links[0]).toMatchObject({ scansLast30Days: 3, scansKept: 3, lastScannedOn: "2026-11-03" });
      // A count for each of the chart's 30 days, today last.
      expect(listed.links[0]!.recentScans).toEqual({ from: "2026-10-05", counts: [...Array.from({ length: 28 }, () => 0), 2, 1] });
      expect((await owner(tx, chain, () => getEntryLinkInTransaction(tx, { businessId: chain.businessId, linkId: link.id, now: new Date("2026-11-04T01:00:00Z") })))?.recentScans).toEqual({ from: "2026-10-06", counts: [...Array.from({ length: 27 }, () => 0), 2, 1, 0] });
      expect(await owner(tx, chain, () => listEntryLinkScansInTransaction(tx, { businessId: chain.businessId, linkId: link.id, now: tuesday }))).toEqual([{ day: "2026-11-02", scans: 2 }, { day: "2026-11-03", scans: 1 }]);
      // Days before the chart's start, and scans more than 30 days old, stay out of those numbers.
      await tx.insert(entryLinkDailyScans).values({ businessId: chain.businessId, entryLinkId: link.id, day: "2026-08-01", scans: 7 });
      const later = (await owner(tx, chain, () => listEntryLinksInTransaction(tx, { businessId: chain.businessId, now: tuesday }))).links[0]!;
      expect(later).toMatchObject({ scansLast30Days: 3, scansKept: 10 });
      expect(later.recentScans.counts.reduce((sum, count) => sum + count, 0)).toBe(3);
      expect(await owner(tx, chain, () => listEntryLinkScansInTransaction(tx, { businessId: chain.businessId, linkId: link.id, days: 30, now: tuesday }))).toHaveLength(2);
    });
  });

  it("sends a scan to the business page when the link or its receptionist is paused or archived, or the link opens the default", async () => {
    await rollbackTest(async (tx) => {
      const chain = await seedChain(tx);
      const businessPage = `/profile/${chain.slug}`;
      const store = await owner(tx, chain, () => createEntryLinkInTransaction(tx, { businessId: chain.businessId, actorUserId: chain.userId, link: { receptionistId: chain.storeId, label: "" } }));
      const desk = await owner(tx, chain, () => createEntryLinkInTransaction(tx, { businessId: chain.businessId, actorUserId: chain.userId, link: { receptionistId: chain.mainId, label: "" } }));
      // The default receptionist's page is the business page, whatever its own handle.
      await owner(tx, chain, () => updateReceptionistInTransaction(tx, { businessId: chain.businessId, actorUserId: chain.userId, receptionistId: chain.mainId, patch: { handle: "front-desk" } }));
      expect((await scan(tx, desk.code))?.path).toBe(businessPage);
      await owner(tx, chain, () => updateEntryLinkInTransaction(tx, { businessId: chain.businessId, actorUserId: chain.userId, linkId: store.id, patch: { status: "paused" } }));
      expect(await scan(tx, store.code)).toMatchObject({ receptionistId: chain.mainId, path: businessPage });
      await owner(tx, chain, () => updateEntryLinkInTransaction(tx, { businessId: chain.businessId, actorUserId: chain.userId, linkId: store.id, patch: { status: "active" } }));
      await owner(tx, chain, () => setReceptionistStatusInTransaction(tx, { businessId: chain.businessId, actorUserId: chain.userId, receptionistId: chain.storeId, status: "paused" }));
      expect((await scan(tx, store.code))?.path).toBe(businessPage);
      await owner(tx, chain, () => archiveReceptionistInTransaction(tx, { businessId: chain.businessId, actorUserId: chain.userId, receptionistId: chain.storeId }));
      expect((await scan(tx, store.code))?.path).toBe(businessPage);
      // Every scan counted, wherever it went.
      const [counted] = await tx.select({ scans: sql<number>`sum(${entryLinkDailyScans.scans})::int` }).from(entryLinkDailyScans).where(eq(entryLinkDailyScans.businessId, chain.businessId));
      expect(counted?.scans).toBe(4);
    });
  });

  it("finds nothing for an unknown or malformed code, or a business that isn't active", async () => {
    await rollbackTest(async (tx) => {
      const chain = await seedChain(tx);
      const link = await owner(tx, chain, () => createEntryLinkInTransaction(tx, { businessId: chain.businessId, actorUserId: chain.userId, link: { receptionistId: chain.storeId, label: "" } }));
      expect(await scan(tx, "zzzzzz")).toBeNull();
      expect(await scan(tx, "no")).toBeNull();
      expect(await scan(tx, "../profile")).toBeNull();
      await tx.update(businesses).set({ status: "suspended" }).where(eq(businesses.id, chain.businessId));
      expect(await scan(tx, link.code)).toBeNull();
      expect(await tx.select().from(entryLinkDailyScans).where(eq(entryLinkDailyScans.entryLinkId, link.id))).toEqual([]);
    });
  });

  it("opens nothing and counts nothing while the business page isn't published, since the page would answer 404", async () => {
    await rollbackTest(async (tx) => {
      const chain = await seedChain(tx);
      const link = await owner(tx, chain, () => createEntryLinkInTransaction(tx, { businessId: chain.businessId, actorUserId: chain.userId, link: { receptionistId: chain.storeId, label: "Front window" } }));
      const desk = await owner(tx, chain, () => createEntryLinkInTransaction(tx, { businessId: chain.businessId, actorUserId: chain.userId, link: { receptionistId: chain.mainId, label: "Counter" } }));
      const counted = async () => (await tx.select({ scans: entryLinkDailyScans.scans }).from(entryLinkDailyScans).where(eq(entryLinkDailyScans.businessId, chain.businessId))).map((row) => row.scans);
      await tx.update(businessPublicProfiles).set({ published: false }).where(eq(businessPublicProfiles.businessId, chain.businessId));
      expect(await page(tx, { slug: chain.slug, handle: "gastown" })).toBeNull();
      expect(await scan(tx, link.code)).toBeNull();
      expect(await scan(tx, desk.code)).toBeNull();
      expect(await scan(tx, link.code, { count: false })).toBeNull();
      // A business that never set up its page has none to open either.
      await tx.delete(businessPublicProfiles).where(eq(businessPublicProfiles.businessId, chain.businessId));
      expect(await scan(tx, link.code)).toBeNull();
      expect(await counted()).toEqual([]);
      // Once the page is published, the same sign opens it and counts.
      await tx.insert(businessPublicProfiles).values({ businessId: chain.businessId, published: true, publishedAt: new Date(), widgetKeyId: chain.widgetKeyId });
      expect((await scan(tx, link.code))?.path).toBe(`/profile/${chain.slug}/gastown`);
      expect(await counted()).toEqual([1]);
    });
  });

  it("filters the list by receptionist, status and a search of the label and code, a page at a time", async () => {
    await rollbackTest(async (tx) => {
      const chain = await seedChain(tx);
      const add = (receptionistId: string, label: string) => owner(tx, chain, () => createEntryLinkInTransaction(tx, { businessId: chain.businessId, actorUserId: chain.userId, link: { receptionistId, label } }));
      const window = await add(chain.storeId, "Front window");
      await add(chain.storeId, "Patio 100%");
      const counter = await add(chain.mainId, "Counter");
      await owner(tx, chain, () => updateEntryLinkInTransaction(tx, { businessId: chain.businessId, actorUserId: chain.userId, linkId: counter.id, patch: { status: "paused" } }));
      const list = (input: Partial<Parameters<typeof listEntryLinksInTransaction>[1]>) => owner(tx, chain, () => listEntryLinksInTransaction(tx, { businessId: chain.businessId, ...input }));
      expect((await list({ receptionistId: chain.storeId })).total).toBe(2);
      expect((await list({ status: "paused" })).links.map((link) => link.id)).toEqual([counter.id]);
      expect((await list({ search: "WINDOW" })).links.map((link) => link.id)).toEqual([window.id]);
      expect((await list({ search: window.code })).links.map((link) => link.id)).toEqual([window.id]);
      // A wildcard in the search is taken as it is.
      expect((await list({ search: "100%" })).total).toBe(1);
      const second = await list({ pageSize: 2, page: 2 });
      expect(second).toMatchObject({ total: 3, page: 2, pageSize: 2 });
      expect(second.links).toHaveLength(1);
    });
  });

  it("deletes scan days older than 13 months for the privacy sweep, and keeps the rest", async () => {
    await rollbackTest(async (tx) => {
      const chain = await seedChain(tx);
      const link = await owner(tx, chain, () => createEntryLinkInTransaction(tx, { businessId: chain.businessId, actorUserId: chain.userId, link: { receptionistId: chain.mainId, label: "" } }));
      await tx.insert(entryLinkDailyScans).values(["2025-10-02", "2025-10-03", "2026-11-03"].map((day) => ({ businessId: chain.businessId, entryLinkId: link.id, day, scans: 1 })));
      await as(tx, "lobbystack_worker");
      await tx.execute(rlsContextStatement({ businessId: chain.businessId, actorType: "worker" }));
      expect(await deleteExpiredEntryLinkScansInTransaction(tx, { businessId: chain.businessId, now: new Date("2026-11-03T12:00:00Z") })).toBe(1);
      await as(tx, null);
      const days = await tx.select({ day: entryLinkDailyScans.day }).from(entryLinkDailyScans).where(eq(entryLinkDailyScans.entryLinkId, link.id)).orderBy(entryLinkDailyScans.day);
      expect(days.map((row) => row.day)).toEqual(["2025-10-03", "2026-11-03"]);
    });
  });
});

describe.skipIf(!testUrl)("receptionist pages, against PostgreSQL under RLS", () => {
  it("names the default receptionist on the business page, and offers the listed, active ones", async () => {
    await rollbackTest(async (tx) => {
      const chain = await seedChain(tx);
      const billing = await owner(tx, chain, () => createReceptionistInTransaction(tx, { businessId: chain.businessId, actorUserId: chain.userId, receptionist: { name: "Billing", handle: "billing", listed: false } }));
      const found = await page(tx, { slug: chain.slug });
      expect(found).toMatchObject({ kind: "page", access: { businessId: chain.businessId, widgetKeyId: chain.widgetKeyId, receptionistId: chain.mainId, listed: true } });
      if (found?.kind !== "page") throw new Error("no page");
      expect(found.profile.receptionist).toMatchObject({ handle: null, isDefault: true });
      expect(found.profile.receptionists.map((entry) => entry.handle)).toEqual([null, "gastown"]);
      expect(found.profile.receptionists.map((entry) => entry.handle)).not.toContain(billing.handle);
    });
  });

  it("shows a receptionist's page with its own name, booking, transfer and number, under the business page's switch and widget", async () => {
    await rollbackTest(async (tx) => {
      const chain = await seedChain(tx);
      await tx.update(receptionistProfiles).set({ bookingMode: "request", transferMode: "always", transferNumber: "+16045550188" }).where(eq(receptionistProfiles.id, chain.storeId));
      await tx.update(receptionistProfiles).set({ bookingMode: "instant", transferMode: "never", transferNumber: null }).where(eq(receptionistProfiles.id, chain.mainId));
      await tx.insert(phoneNumbers).values([
        { businessId: chain.businessId, e164: "+16045550111", receptionistId: chain.mainId, createdAt: new Date(Date.now() - 1000) },
        { businessId: chain.businessId, e164: "+16045550122", receptionistId: chain.storeId, createdAt: new Date(Date.now() - 2000) },
      ]);
      const store = await page(tx, { slug: chain.slug, handle: "GASTOWN" });
      if (store?.kind !== "page") throw new Error("no page");
      expect(store.profile).toMatchObject({ name: "Kitsilano Coffee", phone: "+16045550122", bookingMode: "request", personRequests: "any_time", widgetKey: chain.keyValue, receptionist: { name: "Gastown store", description: "Orders at Gastown", handle: "gastown", isDefault: false } });
      expect(store.access).toEqual({ businessId: chain.businessId, widgetKeyId: chain.widgetKeyId, receptionistId: chain.storeId, listed: true });
      const desk = await page(tx, { slug: chain.slug });
      if (desk?.kind !== "page") throw new Error("no page");
      expect(desk.profile).toMatchObject({ phone: "+16045550111", bookingMode: "instant", personRequests: "never" });
    });
  });

  it("opens an unlisted receptionist's page from its address, and says it isn't listed", async () => {
    await rollbackTest(async (tx) => {
      const chain = await seedChain(tx);
      await owner(tx, chain, () => createReceptionistInTransaction(tx, { businessId: chain.businessId, actorUserId: chain.userId, receptionist: { name: "Billing", handle: "billing", listed: false } }));
      const found = await page(tx, { slug: chain.slug, handle: "billing" });
      expect(found).toMatchObject({ kind: "page", access: { listed: false }, profile: { receptionist: { name: "Billing" } } });
    });
  });

  it("sends visitors of a paused, archived or default receptionist's address to the business page, and finds no other handle", async () => {
    await rollbackTest(async (tx) => {
      const chain = await seedChain(tx);
      await owner(tx, chain, () => updateReceptionistInTransaction(tx, { businessId: chain.businessId, actorUserId: chain.userId, receptionistId: chain.mainId, patch: { handle: "front-desk" } }));
      expect(await page(tx, { slug: chain.slug, handle: "front-desk" })).toEqual({ kind: "businessPage", slug: chain.slug });
      await owner(tx, chain, () => setReceptionistStatusInTransaction(tx, { businessId: chain.businessId, actorUserId: chain.userId, receptionistId: chain.storeId, status: "paused" }));
      expect(await page(tx, { slug: chain.slug, handle: "gastown" })).toEqual({ kind: "businessPage", slug: chain.slug });
      await owner(tx, chain, () => archiveReceptionistInTransaction(tx, { businessId: chain.businessId, actorUserId: chain.userId, receptionistId: chain.storeId }));
      expect(await page(tx, { slug: chain.slug, handle: "gastown" })).toEqual({ kind: "businessPage", slug: chain.slug });
      // A new receptionist may take an archived one's address; the live one wins.
      const again = await owner(tx, chain, () => createReceptionistInTransaction(tx, { businessId: chain.businessId, actorUserId: chain.userId, receptionist: { name: "Gastown, reopened", handle: "gastown" } }));
      expect(await page(tx, { slug: chain.slug, handle: "gastown" })).toMatchObject({ kind: "page", access: { receptionistId: again.id } });
      expect(await page(tx, { slug: chain.slug, handle: "nobody" })).toBeNull();
      expect(await page(tx, { slug: chain.slug, handle: "Not a handle!" })).toBeNull();
    });
  });

  it("keeps a receptionist's page private while the business page is, except as a member's preview", async () => {
    await rollbackTest(async (tx) => {
      const chain = await seedChain(tx);
      await tx.update(businessPublicProfiles).set({ published: false }).where(eq(businessPublicProfiles.businessId, chain.businessId));
      expect(await page(tx, { slug: chain.slug, handle: "gastown" })).toBeNull();
      const preview = await page(tx, { slug: chain.slug, handle: "gastown", previewUserId: chain.userId });
      expect(preview).toMatchObject({ kind: "page", profile: { published: false, receptionist: { handle: "gastown" } } });
      const strangerId = randomUUID();
      await tx.insert(users).values({ id: strangerId, email: `${strangerId}@example.invalid`, normalizedEmail: `${strangerId}@example.invalid` });
      // Someone signed in who isn't on the business's team gets no preview.
      expect(await page(tx, { slug: chain.slug, handle: "gastown", previewUserId: strangerId })).toBeNull();
    });
  });

  it("names no widget for the token when the page shows no chat", async () => {
    await rollbackTest(async (tx) => {
      const chain = await seedChain(tx);
      await tx.update(widgetKeys).set({ status: "revoked" }).where(eq(widgetKeys.id, chain.widgetKeyId));
      expect(await page(tx, { slug: chain.slug, handle: "gastown" })).toMatchObject({ kind: "page", profile: { widgetKey: null }, access: { widgetKeyId: null } });
    });
  });
});
