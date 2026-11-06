import { randomUUID } from "node:crypto";

import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  auditLogs,
  billingAccounts,
  businesses,
  calls,
  conversations,
  createDatabaseClient,
  entryLinks,
  inboxItems,
  outboxMessages,
  phoneNumbers,
  providerEvents,
  receptionistProfiles,
  rlsContextStatement,
  users,
  widgetKeys,
  type Database,
  type DatabaseTransaction,
} from "@lobbystack/db";
import { defaultAppointmentChangePolicy, isAlphabeticalReceptionistOrder } from "@lobbystack/shared";

import { endManagedPlanInTransaction, reconcileBillingProviderEvent, setManagedPlanInTransaction } from "./billing";
import { loadReceptionistView, saveReceptionistProfileInTransaction } from "./receptionistProfile";
import {
  archiveReceptionistInTransaction,
  createReceptionistInTransaction,
  enforceReceptionistAllowance,
  listReceptionistChoicesInTransaction,
  listReceptionistsInTransaction,
  makeDefaultReceptionistInTransaction,
  receptionistAllowanceInTransaction,
  reorderReceptionistsInTransaction,
  restoreReceptionistInTransaction,
  setListedReceptionistsInTransaction,
  sortReceptionistsByNameInTransaction,
  setReceptionistStatusInTransaction,
  updateReceptionistInTransaction,
} from "./receptionists";
import { createBusiness, updateBusinessInTransaction } from "./tenancy";

// Explicit opt-in only; never fall back to DATABASE_URL or load an env file.
const testUrl = process.env.LOBBYSTACK_RELIABILITY_TEST_DATABASE_URL;
if (testUrl) {
  const url = new URL(testUrl);
  if (process.env.NODE_ENV === "production" || !["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname) || !/test/i.test(url.pathname)) {
    throw new Error("Receptionist integration tests require a dedicated local test database.");
  }
}
const client = testUrl ? createDatabaseClient("lobbystack_migrator", { DATABASE_URL: testUrl }) : undefined;
afterAll(async () => { await client?.pool.end(); });

// A cap of 4 keeps the cap's own refusal within reach of a test.
const env = { MAX_RECEPTIONISTS_PER_BUSINESS: "4" };

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

/** The transaction, counting the updates and inserts a step sends. */
function counting(tx: DatabaseTransaction) {
  const calls = { update: 0, insert: 0 };
  const counted = new Proxy(tx, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (property === "update" || property === "insert") calls[property] += 1;
        return (value as (...inner: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { tx: counted, calls };
}

/** Runs a step that should fail in a savepoint, so the transaction goes on after it. */
async function failure(tx: DatabaseTransaction, run: (inner: DatabaseTransaction) => Promise<unknown>): Promise<unknown> {
  return await tx.transaction(async (inner) => { await run(inner); }).then(() => null, (error: unknown) => error);
}

async function seedBusiness(tx: DatabaseTransaction, input: { name?: string; locale?: string } = {}) {
  const userId = randomUUID();
  await tx.insert(users).values({ id: userId, email: `${userId}@example.invalid`, normalizedEmail: `${userId}@example.invalid`, name: "Riley Owner" });
  await as(tx, "lobbystack_app");
  const context = { db: tx as unknown as Database };
  const { businessId } = await createBusiness(context, { userId, name: input.name ?? "Kitsilano Coffee", timezone: "America/Vancouver", businessType: "restaurant", deploymentMode: "cloud" });
  await as(tx, null);
  if (input.locale) await tx.update(businesses).set({ defaultLocale: input.locale }).where(eq(businesses.id, businessId));
  return { context, userId, businessId };
}

/** Puts the business on a live plan, as Polar's webhook leaves the account. */
async function putOnPlan(tx: DatabaseTransaction, businessId: string, plan: "starter" | "pro") {
  await as(tx, null);
  await tx.insert(billingAccounts).values({ businessId, billingKey: `business:${businessId}`, plan, subscriptionState: "active", source: "polar" })
    .onConflictDoUpdate({ target: billingAccounts.businessId, set: { plan, subscriptionState: "active" } });
}

async function defaultRow(tx: DatabaseTransaction, businessId: string) {
  const [row] = await tx.select().from(receptionistProfiles).where(and(eq(receptionistProfiles.businessId, businessId), eq(receptionistProfiles.isDefault, true)));
  return row!;
}

describe.skipIf(!testUrl)("receptionists against PostgreSQL under RLS", () => {
  it("gives a new business one default receptionist named in its language, with the shared settings on the business", async () => {
    await rollbackTest(async (tx) => {
      const { businessId, userId } = await seedBusiness(tx);
      await as(tx, null);
      const rows = await tx.select().from(receptionistProfiles).where(eq(receptionistProfiles.businessId, businessId));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ name: "Front desk", isDefault: true, status: "active", archivedAt: null, handle: null, knowledgeScope: "all", listed: true });
      const [business] = await tx.select().from(businesses).where(eq(businesses.id, businessId));
      expect(business).toMatchObject({ summary: "Kitsilano Coffee", summarySource: "placeholder", recordingNotice: true, appointmentChangePolicy: defaultAppointmentChangePolicy });

      // An untouched default name follows the business's language, and the audit log says who changed it.
      const renames = async () => await tx.select({ actorUserId: auditLogs.actorUserId, entityId: auditLogs.entityId, payload: auditLogs.payload }).from(auditLogs)
        .where(and(eq(auditLogs.businessId, businessId), eq(auditLogs.eventType, "receptionist.updated")));
      await asOwner(tx, { userId, businessId });
      await updateBusinessInTransaction(tx, { businessId, defaultLocale: "fr", audit: { actorUserId: userId } });
      await as(tx, null);
      const frontDesk = await defaultRow(tx, businessId);
      expect(frontDesk.name).toBe("Accueil");
      expect(await renames()).toEqual([{ actorUserId: userId, entityId: frontDesk.id, payload: { fields: ["name"], from: "Front desk", to: "Accueil", reason: "business_language" } }]);

      // A name someone chose stays: their own words, or another language's "Front desk".
      await tx.update(receptionistProfiles).set({ name: "Main counter" }).where(eq(receptionistProfiles.businessId, businessId));
      await asOwner(tx, { userId, businessId });
      await updateBusinessInTransaction(tx, { businessId, defaultLocale: "es" });
      await as(tx, null);
      expect((await defaultRow(tx, businessId)).name).toBe("Main counter");
      await tx.update(receptionistProfiles).set({ name: "Accueil" }).where(eq(receptionistProfiles.businessId, businessId));
      await asOwner(tx, { userId, businessId });
      await updateBusinessInTransaction(tx, { businessId, defaultLocale: "de" });
      await as(tx, null);
      expect((await defaultRow(tx, businessId)).name).toBe("Accueil");
      expect(await renames()).toHaveLength(1);
    });
  });

  it("saves shared settings on the business alone, and each receptionist's own settings on its row", async () => {
    await rollbackTest(async (tx) => {
      const { businessId, userId } = await seedBusiness(tx);
      await putOnPlan(tx, businessId, "pro");
      await asOwner(tx, { userId, businessId });
      const store = await createReceptionistInTransaction(tx, { businessId, actorUserId: userId, receptionist: { name: "Gastown store", description: "Orders and hours at Gastown" } });
      expect(store).toMatchObject({ isDefault: false, handle: "gastown-store", knowledgeScope: "audience", status: "active" });

      // The default receptionist's own greeting and the business's summary.
      const saved = await saveReceptionistProfileInTransaction(tx, { businessId, patch: { greeting: "Hi, Kitsilano Coffee.", summary: "Coffee and pastries.", recordingNotice: false } });
      expect(saved).toMatchObject({ isDefault: true, greeting: "Hi, Kitsilano Coffee.", summary: "Coffee and pastries.", summarySource: "operator", recordingNotice: false });
      // The store's own greeting, which leaves the default's alone; the store reads the shared summary.
      const storeSaved = await saveReceptionistProfileInTransaction(tx, { businessId, receptionistId: store.id, patch: { greeting: "Gastown store, hello!", transferMode: "never" } });
      expect(storeSaved).toMatchObject({ id: store.id, greeting: "Gastown store, hello!", transferMode: "never", summary: "Coffee and pastries.", recordingNotice: false });

      await as(tx, null);
      const [business] = await tx.select().from(businesses).where(eq(businesses.id, businessId));
      expect(business).toMatchObject({ summary: "Coffee and pastries.", summarySource: "operator", recordingNotice: false });
      const main = await defaultRow(tx, businessId);
      expect(main).toMatchObject({ greeting: "Hi, Kitsilano Coffee.", transferMode: "on_request" });
      // A receptionist's row has no copy of them (migration 0143).
      expect(main).not.toHaveProperty("summary");
      expect(main).not.toHaveProperty("recordingNotice");

      // A shared setting saved while editing the store still reaches the business, which every receptionist reads.
      await asOwner(tx, { userId, businessId });
      await saveReceptionistProfileInTransaction(tx, { businessId, receptionistId: store.id, patch: { appointmentChangePolicy: { ...defaultAppointmentChangePolicy, allowCancel: false } } });
      await as(tx, null);
      expect((await tx.select().from(businesses).where(eq(businesses.id, businessId)))[0]?.appointmentChangePolicy).toMatchObject({ allowCancel: false });
      await asOwner(tx, { userId, businessId });
      expect((await loadReceptionistView(tx, { businessId }))?.appointmentChangePolicy).toMatchObject({ allowCancel: false });
      await as(tx, null);
      expect((await tx.select().from(receptionistProfiles).where(eq(receptionistProfiles.id, store.id)))[0]?.greeting).toBe("Gastown store, hello!");

      // Regenerating hands the summary back to AI and queues the rewrite.
      await asOwner(tx, { userId, businessId });
      await saveReceptionistProfileInTransaction(tx, { businessId, patch: {}, regenerateSummary: true });
      await as(tx, null);
      expect((await tx.select({ source: businesses.summarySource }).from(businesses).where(eq(businesses.id, businessId)))[0]?.source).toBe("generated");
      const topics = (await tx.select({ topic: outboxMessages.topic }).from(outboxMessages).where(eq(outboxMessages.businessId, businessId))).map((row) => row.topic);
      expect(topics).toContain("business.generateSummary");
      expect(topics).toContain("snapshot.refresh");

      // An archived receptionist can't be edited.
      await asOwner(tx, { userId, businessId });
      await archiveReceptionistInTransaction(tx, { businessId, actorUserId: userId, receptionistId: store.id });
      expect(await failure(tx, (inner) => saveReceptionistProfileInTransaction(inner, { businessId, receptionistId: store.id, patch: { tone: "warm" } }))).toMatchObject({ status: 404 });
    });
  });

  it("saves on the default receptionist the business was made with, and saves nothing for a business it can't see", async () => {
    await rollbackTest(async (tx) => {
      const { businessId, userId } = await seedBusiness(tx);
      await as(tx, null);
      const made = await defaultRow(tx, businessId);
      await asOwner(tx, { userId, businessId });
      const saved = await saveReceptionistProfileInTransaction(tx, { businessId, patch: { tone: "warm" } });
      // The same row, sign-up's settings and the new tone, beside the business's shared settings.
      expect(saved).toMatchObject({ id: made.id, isDefault: true, name: "Front desk", tone: "warm", greeting: "Thanks for calling Kitsilano Coffee.", transferMode: "on_request", bookingMode: "instant", summary: "Kitsilano Coffee", summarySource: "placeholder", recordingNotice: true, appointmentChangePolicy: defaultAppointmentChangePolicy });
      await as(tx, null);
      expect(await tx.select({ id: receptionistProfiles.id }).from(receptionistProfiles).where(eq(receptionistProfiles.businessId, businessId))).toEqual([{ id: made.id }]);
      const refreshes = await tx.select({ aggregateId: outboxMessages.aggregateId }).from(outboxMessages).where(and(eq(outboxMessages.businessId, businessId), eq(outboxMessages.topic, "snapshot.refresh"), eq(outboxMessages.aggregateType, "receptionist_profile")));
      expect(refreshes.map((row) => row.aggregateId)).toEqual([made.id]);

      // Under another business's context the business is out of sight: nothing is saved or queued.
      const other = await seedBusiness(tx, { name: "Other Shop" });
      await asOwner(tx, other);
      expect(await saveReceptionistProfileInTransaction(tx, { businessId, patch: { tone: "curt" } })).toBeNull();
      expect(await saveReceptionistProfileInTransaction(tx, { businessId, patch: { summary: "Taken over." } })).toBeNull();
      await as(tx, null);
      expect((await defaultRow(tx, businessId)).tone).toBe("warm");
      expect((await tx.select({ summary: businesses.summary }).from(businesses).where(eq(businesses.id, businessId)))[0]?.summary).toBe("Kitsilano Coffee");
      expect(await tx.select().from(outboxMessages).where(and(eq(outboxMessages.businessId, businessId), eq(outboxMessages.topic, "snapshot.refresh"), eq(outboxMessages.aggregateType, "receptionist_profile")))).toHaveLength(1);
    });
  });

  it("holds Free and Starter to one receptionist and Pro to five, counting active ones only", async () => {
    await rollbackTest(async (tx) => {
      const { businessId, userId } = await seedBusiness(tx);
      await asOwner(tx, { userId, businessId });
      // Pro includes more, so Free and Starter upgrade, unless the deployment keeps one receptionist a business.
      expect(await receptionistAllowanceInTransaction(tx, { businessId, env })).toMatchObject({ plan: "free_cloud", limit: 1, active: 1, current: 1, canAdd: false, upgrade: "plan" });
      expect(await failure(tx, (inner) => createReceptionistInTransaction(inner, { businessId, actorUserId: userId, receptionist: { name: "Second" }, env }))).toMatchObject({ status: 409, code: "receptionist_limit", message: "Your plan includes one receptionist. Upgrade to add more." });
      expect(await receptionistAllowanceInTransaction(tx, { businessId, env: { MAX_RECEPTIONISTS_PER_BUSINESS: "1" } })).toMatchObject({ plan: "free_cloud", limit: 1, cap: 1, upgrade: null });

      await putOnPlan(tx, businessId, "starter");
      await asOwner(tx, { userId, businessId });
      expect(await receptionistAllowanceInTransaction(tx, { businessId, env })).toMatchObject({ limit: 1, upgrade: "plan" });

      // Pro's next step is Enterprise, through sales; at the deployment's cap there's none.
      await putOnPlan(tx, businessId, "pro");
      await asOwner(tx, { userId, businessId });
      const proEnv = { MAX_RECEPTIONISTS_PER_BUSINESS: "50" };
      expect(await receptionistAllowanceInTransaction(tx, { businessId, env: proEnv })).toMatchObject({ plan: "pro", limit: 5, canAdd: true, upgrade: "sales" });
      expect(await receptionistAllowanceInTransaction(tx, { businessId, env })).toMatchObject({ plan: "pro", limit: 4, cap: 4, upgrade: null });
      const added: Array<Awaited<ReturnType<typeof createReceptionistInTransaction>>> = [];
      for (const name of ["Kitsilano", "Gastown", "Yaletown", "Main Street"]) added.push(await createReceptionistInTransaction(tx, { businessId, actorUserId: userId, receptionist: { name }, env: proEnv }));
      expect(await failure(tx, (inner) => createReceptionistInTransaction(inner, { businessId, actorUserId: userId, receptionist: { name: "Sixth" }, env: proEnv }))).toMatchObject({ status: 409, code: "receptionist_limit", message: "Your plan includes 5 active receptionists. Pause one or contact sales about Enterprise to add another." });
      // A paused receptionist frees its place, and resuming it needs one.
      await setReceptionistStatusInTransaction(tx, { businessId, actorUserId: userId, receptionistId: added[0]!.id, status: "paused", env: proEnv });
      const sixth = await createReceptionistInTransaction(tx, { businessId, actorUserId: userId, receptionist: { name: "Sixth" }, env: proEnv });
      expect(await failure(tx, (inner) => setReceptionistStatusInTransaction(inner, { businessId, actorUserId: userId, receptionistId: added[0]!.id, status: "active", env: proEnv }))).toMatchObject({ status: 409, code: "receptionist_limit" });
      expect(sixth.status).toBe("active");

      // The deployment's cap bounds receptionists that aren't archived, paused ones included.
      expect(await failure(tx, (inner) => createReceptionistInTransaction(inner, { businessId, actorUserId: userId, receptionist: { name: "Seventh" }, env }))).toMatchObject({ status: 409, code: "receptionist_cap" });

      // Self-hosting has nothing to buy: its limit is the deployment's cap.
      await as(tx, null);
      await tx.update(businesses).set({ deploymentMode: "self_hosted_standard" }).where(eq(businesses.id, businessId));
      await asOwner(tx, { userId, businessId });
      expect(await receptionistAllowanceInTransaction(tx, { businessId, env: proEnv })).toMatchObject({ plan: "self_host", limit: 50, cap: 50, upgrade: null });
    });
  });

  it("gives each new receptionist a free page address, copies settings, and refuses a taken address", async () => {
    await rollbackTest(async (tx) => {
      const { businessId, userId } = await seedBusiness(tx);
      await putOnPlan(tx, businessId, "pro");
      await asOwner(tx, { userId, businessId });
      await saveReceptionistProfileInTransaction(tx, { businessId, patch: { greeting: "Welcome to Kitsilano Coffee.", bookingMode: "request" } });
      const first = await createReceptionistInTransaction(tx, { businessId, actorUserId: userId, receptionist: { name: "Café Gastown" } });
      const second = await createReceptionistInTransaction(tx, { businessId, actorUserId: userId, receptionist: { name: "Cafe Gastown", locale: "fr", listed: false, knowledgeScope: "all" } });
      expect(first).toMatchObject({ handle: "cafe-gastown", greeting: "Welcome to Kitsilano Coffee.", bookingMode: "request", sortOrder: 1 });
      expect(second).toMatchObject({ handle: "cafe-gastown-2", locale: "fr", listed: false, knowledgeScope: "all", sortOrder: 2 });
      await saveReceptionistProfileInTransaction(tx, { businessId, receptionistId: first.id, patch: { greeting: "Gastown here." } });
      const copy = await createReceptionistInTransaction(tx, { businessId, actorUserId: userId, receptionist: { name: "Gastown evenings", handle: "evenings", copyFromId: first.id } });
      expect(copy).toMatchObject({ handle: "evenings", greeting: "Gastown here." });
      expect(await failure(tx, (inner) => createReceptionistInTransaction(inner, { businessId, actorUserId: userId, receptionist: { name: "Clash", handle: "evenings" } }))).toMatchObject({ status: 409, code: "handle_taken" });
      expect(await failure(tx, (inner) => updateReceptionistInTransaction(inner, { businessId, actorUserId: userId, receptionistId: second.id, patch: { handle: "cafe-gastown" } }))).toMatchObject({ status: 409, code: "handle_taken" });
      expect(await failure(tx, (inner) => createReceptionistInTransaction(inner, { businessId, actorUserId: userId, receptionist: { name: "Ghost", copyFromId: randomUUID() } }))).toMatchObject({ status: 404 });

      const renamed = await updateReceptionistInTransaction(tx, { businessId, actorUserId: userId, receptionistId: second.id, patch: { name: "Gastown (French)", handle: "gastown-fr", description: "En français", listed: true } });
      expect(renamed).toMatchObject({ name: "Gastown (French)", handle: "gastown-fr", description: "En français", listed: true });
      const main = await loadReceptionistView(tx, { businessId });
      expect(await failure(tx, (inner) => updateReceptionistInTransaction(inner, { businessId, actorUserId: userId, receptionistId: main!.id, patch: { listed: false } }))).toMatchObject({ status: 409, code: "default_receptionist" });

      await as(tx, null);
      // Rows a transaction writes all take its start time as created_at, so the entries come in no set order.
      const events = await tx.select({ eventType: auditLogs.eventType, entityId: auditLogs.entityId, payload: auditLogs.payload }).from(auditLogs).where(and(eq(auditLogs.businessId, businessId), eq(auditLogs.entityType, "receptionist")));
      expect(events.map((event) => event.eventType).sort()).toEqual(["receptionist.created", "receptionist.created", "receptionist.created", "receptionist.updated"]);
      expect(events.find((event) => event.eventType === "receptionist.updated")?.payload).toEqual({ fields: ["description", "handle", "listed", "name"] });
    });
  });

  it("pauses, archives and restores receptionists, never the default, and lists them in order", async () => {
    await rollbackTest(async (tx) => {
      const { businessId, userId } = await seedBusiness(tx);
      await putOnPlan(tx, businessId, "pro");
      await asOwner(tx, { userId, businessId });
      const main = (await loadReceptionistView(tx, { businessId }))!;
      const a = await createReceptionistInTransaction(tx, { businessId, actorUserId: userId, receptionist: { name: "Bakery counter", description: "Cakes and custom orders" } });
      const b = await createReceptionistInTransaction(tx, { businessId, actorUserId: userId, receptionist: { name: "Catering" } });
      const c = await createReceptionistInTransaction(tx, { businessId, actorUserId: userId, receptionist: { name: "Après-ski bar" } });

      expect(await failure(tx, (inner) => setReceptionistStatusInTransaction(inner, { businessId, actorUserId: userId, receptionistId: main.id, status: "paused" }))).toMatchObject({ status: 409, code: "default_receptionist" });
      expect(await failure(tx, (inner) => archiveReceptionistInTransaction(inner, { businessId, actorUserId: userId, receptionistId: main.id }))).toMatchObject({ status: 409, code: "default_receptionist" });

      await setReceptionistStatusInTransaction(tx, { businessId, actorUserId: userId, receptionistId: b.id, status: "paused" });
      await archiveReceptionistInTransaction(tx, { businessId, actorUserId: userId, receptionistId: c.id });
      expect((await listReceptionistChoicesInTransaction(tx, { businessId })).map((choice) => [choice.name, choice.status])).toEqual([["Front desk", "active"], ["Bakery counter", "active"], ["Catering", "paused"]]);

      // The order: every receptionist that isn't archived, once each; the default stays first in lists.
      await reorderReceptionistsInTransaction(tx, { businessId, receptionistIds: [b.id, a.id, main.id] });
      expect((await listReceptionistChoicesInTransaction(tx, { businessId })).map((choice) => choice.name)).toEqual(["Front desk", "Catering", "Bakery counter"]);
      expect(await failure(tx, (inner) => reorderReceptionistsInTransaction(inner, { businessId, receptionistIds: [a.id, main.id] }))).toMatchObject({ status: 400, code: "invalid_order" });
      expect(await failure(tx, (inner) => reorderReceptionistsInTransaction(inner, { businessId, receptionistIds: [a.id, b.id, c.id] }))).toMatchObject({ status: 400, code: "invalid_order" });
      expect(isAlphabeticalReceptionistOrder(await listReceptionistChoicesInTransaction(tx, { businessId }), "en")).toBe(false);

      // The page: search, status and the archived view, with counts whatever the filters.
      const page = await listReceptionistsInTransaction(tx, { businessId, search: "custom" });
      expect(page.receptionists.map((row) => row.name)).toEqual(["Bakery counter"]);
      expect(page.counts).toEqual({ active: 2, paused: 1, archived: 1 });
      expect((await listReceptionistsInTransaction(tx, { businessId, status: "paused" })).receptionists.map((row) => row.name)).toEqual(["Catering"]);
      expect((await listReceptionistsInTransaction(tx, { businessId, view: "archived" })).receptionists.map((row) => row.name)).toEqual(["Après-ski bar"]);
      expect((await listReceptionistsInTransaction(tx, { businessId, search: "100%_" })).total).toBe(0);
      const paged = await listReceptionistsInTransaction(tx, { businessId, pageSize: 2, page: 2 });
      expect(paged).toMatchObject({ total: 3, page: 2, pageSize: 2 });
      expect(paged.receptionists.map((row) => row.name)).toEqual(["Bakery counter"]);

      // Another receptionist takes the archived one's address; it comes back with a numbered one.
      await updateReceptionistInTransaction(tx, { businessId, actorUserId: userId, receptionistId: a.id, patch: { handle: "apres-ski-bar" } });
      const restored = await restoreReceptionistInTransaction(tx, { businessId, actorUserId: userId, receptionistId: c.id });
      expect(restored).toMatchObject({ archivedAt: null, status: "active", handle: "apres-ski-bar-2", sortOrder: 4 });
      expect(await failure(tx, (inner) => restoreReceptionistInTransaction(inner, { businessId, actorUserId: userId, receptionistId: c.id }))).toMatchObject({ status: 404 });
    });
  });

  it("keeps receptionists by name while they go by name, and in the owner's order once one is moved", async () => {
    await rollbackTest(async (tx) => {
      const { businessId, userId } = await seedBusiness(tx, { locale: "fr" });
      await putOnPlan(tx, businessId, "pro");
      await asOwner(tx, { userId, businessId });
      const main = (await loadReceptionistView(tx, { businessId }))!;
      const add = async (name: string) => await createReceptionistInTransaction(tx, { businessId, actorUserId: userId, receptionist: { name } });
      const names = async () => (await listReceptionistChoicesInTransaction(tx, { businessId })).map((choice) => choice.name);
      const alphabetical = async () => isAlphabeticalReceptionistOrder(await listReceptionistChoicesInTransaction(tx, { businessId }), "fr");

      // A business's new receptionists take their place by name, as people read it in its language: accents aside, numbers by value.
      const store10 = await add("Store 10");
      const store2 = await add("Store 2");
      const eclair = await add("Éclair bakery");
      expect(await names()).toEqual(["Front desk", "Éclair bakery", "Store 2", "Store 10"]);
      expect(await alphabetical()).toBe(true);

      // A rename moves it; so does a restore.
      await updateReceptionistInTransaction(tx, { businessId, actorUserId: userId, receptionistId: eclair.id, patch: { name: "Zoo gift shop" } });
      expect(await names()).toEqual(["Front desk", "Store 2", "Store 10", "Zoo gift shop"]);
      await archiveReceptionistInTransaction(tx, { businessId, actorUserId: userId, receptionistId: store2.id });
      await restoreReceptionistInTransaction(tx, { businessId, actorUserId: userId, receptionistId: store2.id });
      expect(await names()).toEqual(["Front desk", "Store 2", "Store 10", "Zoo gift shop"]);

      // Once the owner moves one, the order is theirs: new ones go last, and a rename moves nothing.
      await reorderReceptionistsInTransaction(tx, { businessId, receptionistIds: [main.id, eclair.id, store10.id, store2.id] });
      expect(await names()).toEqual(["Front desk", "Zoo gift shop", "Store 10", "Store 2"]);
      expect(await alphabetical()).toBe(false);
      await add("Art cart");
      await updateReceptionistInTransaction(tx, { businessId, actorUserId: userId, receptionistId: store10.id, patch: { name: "Annex" } });
      expect(await names()).toEqual(["Front desk", "Zoo gift shop", "Annex", "Store 2", "Art cart"]);

      // Sort A–Z puts them back by name, and then sorting again touches no receptionist.
      await sortReceptionistsByNameInTransaction(tx, { businessId });
      expect(await names()).toEqual(["Front desk", "Annex", "Art cart", "Store 2", "Zoo gift shop"]);
      expect(await alphabetical()).toBe(true);
      const stamps = async () => (await tx.select({ id: receptionistProfiles.id, updatedAt: receptionistProfiles.updatedAt }).from(receptionistProfiles).where(eq(receptionistProfiles.businessId, businessId)).orderBy(asc(receptionistProfiles.id))).map((row) => `${row.id}:${row.updatedAt.toISOString()}`);
      const before = await stamps();
      await sortReceptionistsByNameInTransaction(tx, { businessId });
      expect(await stamps()).toEqual(before);
    });
  });

  it("lists exactly the receptionists chosen on the business page, the default always", async () => {
    await rollbackTest(async (tx) => {
      const { businessId, userId } = await seedBusiness(tx);
      await putOnPlan(tx, businessId, "pro");
      await asOwner(tx, { userId, businessId });
      const main = (await loadReceptionistView(tx, { businessId }))!;
      const sales = await createReceptionistInTransaction(tx, { businessId, actorUserId: userId, receptionist: { name: "Sales" } });
      const support = await createReceptionistInTransaction(tx, { businessId, actorUserId: userId, receptionist: { name: "Support", listed: false } });
      const repairs = await createReceptionistInTransaction(tx, { businessId, actorUserId: userId, receptionist: { name: "Repairs" } });
      const listed = async () => (await listReceptionistChoicesInTransaction(tx, { businessId })).filter((choice) => choice.listed).map((choice) => choice.name);
      expect(await listed()).toEqual(["Front desk", "Repairs", "Sales"]);

      await setListedReceptionistsInTransaction(tx, { businessId, actorUserId: userId, receptionistIds: [support.id, sales.id] });
      expect(await listed()).toEqual(["Front desk", "Sales", "Support"]);
      const events = await tx.select({ entityId: auditLogs.entityId, payload: auditLogs.payload }).from(auditLogs)
        .where(and(eq(auditLogs.businessId, businessId), eq(auditLogs.eventType, "receptionist.updated")));
      expect(events.map((event) => [event.entityId, event.payload])).toEqual(expect.arrayContaining([[support.id, { fields: ["listed"], listed: true }], [repairs.id, { fields: ["listed"], listed: false }]]));
      expect(events).toHaveLength(2);

      // None besides the default: the page then offers no choice. Naming the default changes nothing.
      await setListedReceptionistsInTransaction(tx, { businessId, actorUserId: userId, receptionistIds: [main.id] });
      expect(await listed()).toEqual(["Front desk"]);

      // An archived or unknown receptionist can't be listed, and nothing changes.
      await archiveReceptionistInTransaction(tx, { businessId, actorUserId: userId, receptionistId: repairs.id });
      expect(await failure(tx, (inner) => setListedReceptionistsInTransaction(inner, { businessId, actorUserId: userId, receptionistIds: [sales.id, repairs.id] }))).toMatchObject({ status: 404, code: "receptionist_not_found" });
      expect(await failure(tx, (inner) => setListedReceptionistsInTransaction(inner, { businessId, actorUserId: userId, receptionistIds: [randomUUID()] }))).toMatchObject({ status: 404, code: "receptionist_not_found" });
      expect(await listed()).toEqual(["Front desk"]);
    });
  });

  it("saves a new order and the listed receptionists in one statement each, however many change", async () => {
    await rollbackTest(async (tx) => {
      const { businessId, userId } = await seedBusiness(tx);
      await putOnPlan(tx, businessId, "pro");
      await asOwner(tx, { userId, businessId });
      const main = (await loadReceptionistView(tx, { businessId }))!;
      const add = async (name: string, inner = tx) => await createReceptionistInTransaction(inner, { businessId, actorUserId: userId, receptionist: { name } });
      const names = async () => (await listReceptionistChoicesInTransaction(tx, { businessId })).map((choice) => choice.name);
      const annex = await add("Annex");
      const cafe = await add("Cafe");
      const deli = await add("Deli");

      // Added by name, Bakery moves Cafe and Deli down: one update for the places.
      const adding = counting(tx);
      const bakery = await add("Bakery", adding.tx);
      expect(await names()).toEqual(["Front desk", "Annex", "Bakery", "Cafe", "Deli"]);
      expect(adding.calls.update).toBe(1);

      // All four move: one update; the same order again writes nothing.
      const reordering = counting(tx);
      await reorderReceptionistsInTransaction(reordering.tx, { businessId, receptionistIds: [main.id, deli.id, cafe.id, bakery.id, annex.id] });
      expect(await names()).toEqual(["Front desk", "Deli", "Cafe", "Bakery", "Annex"]);
      expect(reordering.calls.update).toBe(1);
      const again = counting(tx);
      await reorderReceptionistsInTransaction(again.tx, { businessId, receptionistIds: [main.id, deli.id, cafe.id, bakery.id, annex.id] });
      expect(again.calls.update).toBe(0);

      // Three off the page, then two back on and one more off: an update each way, and one insert for the audit rows (and one for the refresh).
      const listed = async () => (await listReceptionistChoicesInTransaction(tx, { businessId })).filter((choice) => choice.listed).map((choice) => choice.name);
      const unlisting = counting(tx);
      await setListedReceptionistsInTransaction(unlisting.tx, { businessId, actorUserId: userId, receptionistIds: [deli.id] });
      expect(await listed()).toEqual(["Front desk", "Deli"]);
      expect(unlisting.calls).toEqual({ update: 1, insert: 2 });
      const relisting = counting(tx);
      await setListedReceptionistsInTransaction(relisting.tx, { businessId, actorUserId: userId, receptionistIds: [cafe.id, annex.id] });
      expect(await listed()).toEqual(["Front desk", "Cafe", "Annex"]);
      expect(relisting.calls).toEqual({ update: 2, insert: 2 });
      await as(tx, null);
      const events = await tx.select({ entityId: auditLogs.entityId, payload: auditLogs.payload }).from(auditLogs)
        .where(and(eq(auditLogs.businessId, businessId), eq(auditLogs.eventType, "receptionist.updated")));
      expect(events.map((event) => [event.entityId, event.payload])).toEqual(expect.arrayContaining([
        [cafe.id, { fields: ["listed"], listed: false }], [cafe.id, { fields: ["listed"], listed: true }],
        [annex.id, { fields: ["listed"], listed: true }], [deli.id, { fields: ["listed"], listed: false }],
      ]));
      expect(events).toHaveLength(6);
    });
  });

  it("restores a receptionist paused when the plan has no room for it", async () => {
    await rollbackTest(async (tx) => {
      const { businessId, userId } = await seedBusiness(tx);
      await putOnPlan(tx, businessId, "pro");
      await asOwner(tx, { userId, businessId });
      const extra = await createReceptionistInTransaction(tx, { businessId, actorUserId: userId, receptionist: { name: "Patio" } });
      await archiveReceptionistInTransaction(tx, { businessId, actorUserId: userId, receptionistId: extra.id });
      await putOnPlan(tx, businessId, "starter");
      await asOwner(tx, { userId, businessId });
      expect(await restoreReceptionistInTransaction(tx, { businessId, actorUserId: userId, receptionistId: extra.id })).toMatchObject({ status: "paused", archivedAt: null });
    });
  });

  it("makes another receptionist the default, which reads the shared settings from the business", async () => {
    await rollbackTest(async (tx) => {
      const { businessId, userId } = await seedBusiness(tx);
      await putOnPlan(tx, businessId, "pro");
      await asOwner(tx, { userId, businessId });
      await saveReceptionistProfileInTransaction(tx, { businessId, patch: { summary: "Coffee since 1999." } });
      const before = (await loadReceptionistView(tx, { businessId }))!;
      const store = await createReceptionistInTransaction(tx, { businessId, actorUserId: userId, receptionist: { name: "Flagship", listed: false, locale: "fr" } });
      expect(store).toMatchObject({ locale: "fr", knowledgeScope: "audience" });
      await setReceptionistStatusInTransaction(tx, { businessId, actorUserId: userId, receptionistId: store.id, status: "paused" });
      expect(await failure(tx, (inner) => makeDefaultReceptionistInTransaction(inner, { businessId, actorUserId: userId, receptionistId: store.id }))).toMatchObject({ status: 409, code: "receptionist_paused" });
      await setReceptionistStatusInTransaction(tx, { businessId, actorUserId: userId, receptionistId: store.id, status: "active" });
      // The old default was limited by its owner, which stays its own choice.
      await updateReceptionistInTransaction(tx, { businessId, actorUserId: userId, receptionistId: before.id, patch: { knowledgeScope: "audience" } });

      const made = await makeDefaultReceptionistInTransaction(tx, { businessId, actorUserId: userId, receptionistId: store.id });
      // It speaks the business's language from now on, as AI settings shows the
      // default, and answers from every article, since whatever falls back to
      // the default relies on it.
      expect(made).toMatchObject({ id: store.id, isDefault: true, listed: true, summary: "Coffee since 1999.", locale: null, knowledgeScope: "all" });
      await as(tx, null);
      const previous = (await tx.select().from(receptionistProfiles).where(eq(receptionistProfiles.id, before.id)))[0];
      expect(previous).toMatchObject({ isDefault: false, handle: "front-desk", knowledgeScope: "audience" });
      expect((await defaultRow(tx, businessId))).toMatchObject({ id: store.id, locale: null });
      // Nothing moved with it: a shared setting saved now reaches the new default and the old one alike.
      await asOwner(tx, { userId, businessId });
      await saveReceptionistProfileInTransaction(tx, { businessId, patch: { recordingNotice: false } });
      expect(await loadReceptionistView(tx, { businessId })).toMatchObject({ id: store.id, summary: "Coffee since 1999.", recordingNotice: false });
      expect(await loadReceptionistView(tx, { businessId, receptionistId: before.id })).toMatchObject({ id: before.id, isDefault: false, summary: "Coffee since 1999.", recordingNotice: false });
      await as(tx, null);
      const [event] = await tx.select({ payload: auditLogs.payload }).from(auditLogs).where(and(eq(auditLogs.businessId, businessId), eq(auditLogs.eventType, "receptionist.default_changed")));
      expect(event?.payload).toEqual({ from: before.id, to: store.id });
      // Making the default the default changes nothing.
      await asOwner(tx, { userId, businessId });
      expect(await makeDefaultReceptionistInTransaction(tx, { businessId, actorUserId: userId, receptionistId: store.id })).toMatchObject({ id: store.id, isDefault: true });
    });
  });

  it("pauses the newest receptionists past a lower plan's number, the default never", async () => {
    await rollbackTest(async (tx) => {
      const { context, businessId, userId } = await seedBusiness(tx);
      await asOwner(tx, { userId, businessId });
      await as(tx, null);
      await tx.execute(rlsContextStatement({ businessId, actorType: "system" }));
      expect(await setManagedPlanInTransaction(tx, { businessId })).toBe("set");
      await asOwner(tx, { userId, businessId });
      const first = await createReceptionistInTransaction(tx, { businessId, actorUserId: userId, receptionist: { name: "Older" }, env });
      const second = await createReceptionistInTransaction(tx, { businessId, actorUserId: userId, receptionist: { name: "Newer" }, env });
      await tx.update(receptionistProfiles).set({ createdAt: new Date(Date.now() - 60_000) }).where(eq(receptionistProfiles.id, first.id));

      await as(tx, null);
      await tx.execute(rlsContextStatement({ businessId, actorType: "system" }));
      expect(await endManagedPlanInTransaction(tx, { businessId })).toBe(true);
      // Ending the plan queues the check; the worker runs it.
      expect((await tx.select({ topic: outboxMessages.topic }).from(outboxMessages).where(eq(outboxMessages.businessId, businessId))).map((row) => row.topic)).toContain("receptionists.enforceAllowance");
      await as(tx, "lobbystack_worker");
      const paused = await enforceReceptionistAllowance(context, { businessId, env });
      expect(paused.sort()).toEqual([first.id, second.id].sort());
      await as(tx, null);
      const rows = await tx.select({ name: receptionistProfiles.name, status: receptionistProfiles.status }).from(receptionistProfiles).where(eq(receptionistProfiles.businessId, businessId)).orderBy(asc(receptionistProfiles.sortOrder));
      // The receptionists went by name, so each new one took its place by name.
      expect(rows).toEqual([{ name: "Front desk", status: "active" }, { name: "Newer", status: "paused" }, { name: "Older", status: "paused" }]);
      const reasons = await tx.select({ payload: auditLogs.payload }).from(auditLogs).where(and(eq(auditLogs.businessId, businessId), eq(auditLogs.eventType, "receptionist.paused")));
      expect(reasons.map((row) => row.payload)).toEqual([{ reason: "plan_limit", plan: "free_cloud", limit: 1 }, { reason: "plan_limit", plan: "free_cloud", limit: 1 }]);
      // Running it again finds nothing to pause.
      await as(tx, "lobbystack_worker");
      expect(await enforceReceptionistAllowance(context, { businessId, env })).toEqual([]);
    });
  });

  it("queues the plan check when Polar moves the business from Pro to Starter, and the worker pauses every extra", async () => {
    await rollbackTest(async (tx) => {
      const { context, businessId, userId } = await seedBusiness(tx);
      const proEnv = { MAX_RECEPTIONISTS_PER_BUSINESS: "50" };
      /** Stores a Polar event for the business and applies it as the webhook's job does. */
      const polarEvent = async (eventType: string, payload: Record<string, unknown>) => {
        await as(tx, null);
        const [stored] = await tx.insert(providerEvents).values({
          provider: "polar",
          providerEventId: `evt-${randomUUID()}`,
          eventType,
          businessId,
          payload: { billingKey: `business:${businessId}`, billingInterval: "monthly", subscriptionId: "sub_receptionists", currentPeriodStart: "2026-11-01T00:00:00.000Z", currentPeriodEnd: "2026-12-01T00:00:00.000Z", ...payload },
        }).returning({ id: providerEvents.id });
        await as(tx, "lobbystack_worker");
        return await reconcileBillingProviderEvent(context, { businessId, providerEventId: stored!.id });
      };
      const queuedChecks = async () => {
        await as(tx, null);
        return await tx.select({ payload: outboxMessages.payload }).from(outboxMessages).where(and(eq(outboxMessages.businessId, businessId), eq(outboxMessages.topic, "receptionists.enforceAllowance")));
      };

      expect(await polarEvent("subscription.active", { plan: "pro", status: "active" })).toBe("processed");
      await asOwner(tx, { userId, businessId });
      for (const name of ["Kitsilano", "Gastown", "Yaletown", "Main Street"]) await createReceptionistInTransaction(tx, { businessId, actorUserId: userId, receptionist: { name }, env: proEnv });
      const before = (await queuedChecks()).length;

      expect(await polarEvent("subscription.updated", { plan: "starter", status: "active" })).toBe("processed");
      const queued = await queuedChecks();
      expect(queued).toHaveLength(before + 1);
      expect(queued.at(-1)?.payload).toEqual({ businessId, reason: "billing_reconcile" });

      await as(tx, "lobbystack_worker");
      expect(await enforceReceptionistAllowance(context, { businessId, env: proEnv })).toHaveLength(4);
      await asOwner(tx, { userId, businessId });
      expect(await receptionistAllowanceInTransaction(tx, { businessId, env: proEnv })).toMatchObject({ plan: "starter", limit: 1, active: 1, current: 5, canAdd: false });
      await as(tx, null);
      expect((await defaultRow(tx, businessId)).status).toBe("active");
      const reasons = await tx.select({ payload: auditLogs.payload }).from(auditLogs).where(and(eq(auditLogs.businessId, businessId), eq(auditLogs.eventType, "receptionist.paused")));
      expect(reasons.map((row) => row.payload)).toEqual(Array.from({ length: 4 }, () => ({ reason: "plan_limit", plan: "starter", limit: 1 })));
    });
  });

  it("pauses the newest receptionists first when the new limit leaves room for some", async () => {
    await rollbackTest(async (tx) => {
      const { context, businessId, userId } = await seedBusiness(tx);
      await putOnPlan(tx, businessId, "pro");
      await asOwner(tx, { userId, businessId });
      const ids: string[] = [];
      for (const name of ["Oldest", "Older", "Newer", "Newest"]) ids.push((await createReceptionistInTransaction(tx, { businessId, actorUserId: userId, receptionist: { name }, env: { MAX_RECEPTIONISTS_PER_BUSINESS: "50" } })).id);
      // Rows one transaction writes share its start time, so each gets a minute of its own, oldest first.
      await as(tx, null);
      const start = Date.now() - 60 * 60_000;
      for (const [index, id] of ids.entries()) await tx.update(receptionistProfiles).set({ createdAt: new Date(start + index * 60_000) }).where(eq(receptionistProfiles.id, id));

      // A deployment cap of 3 holds Pro to 3 active, the default included: two of the four must pause.
      await as(tx, "lobbystack_worker");
      expect((await enforceReceptionistAllowance(context, { businessId, env: { MAX_RECEPTIONISTS_PER_BUSINESS: "3" } })).sort()).toEqual([ids[2]!, ids[3]!].sort());
      await as(tx, null);
      const rows = await tx.select({ name: receptionistProfiles.name, status: receptionistProfiles.status }).from(receptionistProfiles).where(eq(receptionistProfiles.businessId, businessId));
      expect(Object.fromEntries(rows.map((row) => [row.name, row.status]))).toEqual({ "Front desk": "active", Oldest: "active", Older: "active", Newer: "paused", Newest: "paused" });
    });
  });

  it("refuses to restore a receptionist when the business already keeps the deployment's cap", async () => {
    await rollbackTest(async (tx) => {
      const { businessId, userId } = await seedBusiness(tx);
      await putOnPlan(tx, businessId, "pro");
      await asOwner(tx, { userId, businessId });
      // The default and three more fill the cap of 4; archiving one frees a place, and a new one takes it.
      const added: string[] = [];
      for (const name of ["Kitsilano", "Gastown", "Yaletown"]) added.push((await createReceptionistInTransaction(tx, { businessId, actorUserId: userId, receptionist: { name }, env })).id);
      await archiveReceptionistInTransaction(tx, { businessId, actorUserId: userId, receptionistId: added[0]! });
      await createReceptionistInTransaction(tx, { businessId, actorUserId: userId, receptionist: { name: "Main Street" }, env });
      expect(await failure(tx, (inner) => restoreReceptionistInTransaction(inner, { businessId, actorUserId: userId, receptionistId: added[0]!, env }))).toMatchObject({ status: 409, code: "receptionist_cap", message: "A business can keep up to 4 receptionists. Archive one to add another." });
      await as(tx, null);
      expect((await tx.select({ archivedAt: receptionistProfiles.archivedAt }).from(receptionistProfiles).where(eq(receptionistProfiles.id, added[0]!)))[0]?.archivedAt).not.toBeNull();
    });
  });

  it("lets only one of two adds racing for the plan's last place through", async () => {
    // Committed rows, so two transactions really race; deleted at the end.
    const userId = randomUUID();
    const proEnv = { MAX_RECEPTIONISTS_PER_BUSINESS: "50" };
    const businessId = await client!.db.transaction(async (tx) => {
      await tx.insert(users).values({ id: userId, email: `${userId}@example.invalid`, normalizedEmail: `${userId}@example.invalid`, name: "Riley Owner" });
      await as(tx, "lobbystack_app");
      const created = await createBusiness({ db: tx as unknown as Database }, { userId, name: "Kitsilano Coffee", timezone: "America/Vancouver", businessType: "restaurant", deploymentMode: "cloud" });
      await putOnPlan(tx, created.businessId, "pro");
      // The default and three more leave one of Pro's five places.
      await asOwner(tx, { userId, businessId: created.businessId });
      for (const name of ["Kitsilano", "Gastown", "Yaletown"]) await createReceptionistInTransaction(tx, { businessId: created.businessId, actorUserId: userId, receptionist: { name }, env: proEnv });
      return created.businessId;
    });
    const blocker = await client!.pool.connect();
    let pending: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      // Hold the business's receptionists lock so both adds queue behind it, then release them together.
      await blocker.query("begin");
      await blocker.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`receptionists:${businessId}`]);
      pending = Promise.allSettled(["Main Street", "Commercial Drive"].map((name) => client!.db.transaction(async (tx) => {
        await asOwner(tx, { userId, businessId });
        return await createReceptionistInTransaction(tx, { businessId, actorUserId: userId, receptionist: { name }, env: proEnv });
      })));
      await vi.waitFor(async () => {
        // Count only this blocker's waiters: other test files run their own lock races in parallel.
        const result = await blocker.query("select count(*)::int as waiting from pg_locks where not granted and pg_backend_pid() = any(pg_blocking_pids(pid))");
        expect(result.rows[0].waiting).toBe(2);
      }, { timeout: 3000 });
      await blocker.query("rollback");
      const results = await pending;
      expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
      const refused = results.find((result) => result.status === "rejected");
      expect(refused?.status === "rejected" ? refused.reason : null).toMatchObject({ status: 409, code: "receptionist_limit", message: "Your plan includes 5 active receptionists. Pause one or contact sales about Enterprise to add another." });
      const active = await client!.db.select({ id: receptionistProfiles.id }).from(receptionistProfiles).where(and(eq(receptionistProfiles.businessId, businessId), eq(receptionistProfiles.status, "active"), isNull(receptionistProfiles.archivedAt)));
      expect(active).toHaveLength(5);
    } finally {
      await blocker.query("rollback");
      blocker.release();
      await pending;
      await client!.db.delete(outboxMessages).where(eq(outboxMessages.businessId, businessId));
      await client!.db.delete(businesses).where(eq(businesses.id, businessId));
      await client!.db.delete(users).where(eq(users.id, userId));
    }
  });

  it("names the default receptionist on rows whose writer names none, and counts entry points per receptionist", async () => {
    await rollbackTest(async (tx) => {
      const { businessId, userId } = await seedBusiness(tx);
      await putOnPlan(tx, businessId, "pro");
      await asOwner(tx, { userId, businessId });
      const main = (await loadReceptionistView(tx, { businessId }))!;
      const store = await createReceptionistInTransaction(tx, { businessId, actorUserId: userId, receptionist: { name: "Second store" } });

      // Writers that name no receptionist get the default one.
      await as(tx, "lobbystack_worker");
      await tx.execute(rlsContextStatement({ businessId, actorType: "worker" }));
      const [call] = await tx.insert(calls).values({ businessId, providerCallId: `call-${randomUUID()}`, transport: "sip", startedAt: new Date() }).returning({ receptionistId: calls.receptionistId });
      const [conversation] = await tx.insert(conversations).values({ businessId, channel: "web_chat" }).returning({ receptionistId: conversations.receptionistId });
      const [item] = await tx.insert(inboxItems).values({ businessId, kind: "callback", title: "Call back", body: "Asked for a call back." }).returning({ receptionistId: inboxItems.receptionistId });
      expect([call?.receptionistId, conversation?.receptionistId, item?.receptionistId]).toEqual([main.id, main.id, main.id]);
      // A writer that names one keeps it.
      const [named] = await tx.insert(conversations).values({ businessId, channel: "web_chat", receptionistId: store.id }).returning({ receptionistId: conversations.receptionistId });
      expect(named?.receptionistId).toBe(store.id);

      await as(tx, null);
      const [number] = await tx.insert(phoneNumbers).values({ businessId, e164: `+1555${Math.floor(Math.random() * 1e7).toString().padStart(7, "0")}` }).returning({ receptionistId: phoneNumbers.receptionistId });
      expect(number?.receptionistId).toBe(main.id);
      // A number that names no receptionist answers as the default one, and counts for it.
      await tx.insert(phoneNumbers).values({ businessId, e164: `+1556${Math.floor(Math.random() * 1e7).toString().padStart(7, "0")}`, status: "active" });
      await tx.execute(sql`update phone_numbers set receptionist_id = null where business_id = ${businessId}::uuid and e164 like '+1556%'`);
      await tx.insert(widgetKeys).values({ businessId, keyHash: `hash-${randomUUID()}`, receptionistId: store.id });
      await tx.insert(entryLinks).values({ businessId, receptionistId: store.id, code: randomUUID().replace(/-/g, "").slice(0, 8) });

      // A row can only name a receptionist of its own business.
      const other = await seedBusiness(tx, { name: "Other Shop" });
      const otherMain = await defaultRow(tx, other.businessId);
      const crossed = await failure(tx, (inner) => inner.insert(conversations).values({ businessId, channel: "web_chat", receptionistId: otherMain.id }));
      expect(crossed).toMatchObject({ cause: expect.objectContaining({ code: "23503" }) });

      await asOwner(tx, { userId, businessId });
      const page = await listReceptionistsInTransaction(tx, { businessId });
      expect(page.receptionists.map((row) => [row.name, row.phoneNumbers, row.widgetKeys, row.entryLinks])).toEqual([["Front desk", 2, 0, 0], ["Second store", 0, 1, 1]]);
    });
  });

  it("keeps each business's receptionists to its own team", async () => {
    await rollbackTest(async (tx) => {
      const first = await seedBusiness(tx, { name: "First Bakery" });
      const second = await seedBusiness(tx, { name: "Second Bakery" });
      const secondMain = await defaultRow(tx, second.businessId);
      await asOwner(tx, first);
      expect(await listReceptionistChoicesInTransaction(tx, { businessId: second.businessId })).toEqual([]);
      expect(await loadReceptionistView(tx, { businessId: first.businessId, receptionistId: secondMain.id })).toBeNull();
      expect(await failure(tx, (inner) => updateReceptionistInTransaction(inner, { businessId: first.businessId, actorUserId: first.userId, receptionistId: secondMain.id, patch: { name: "Taken over" } }))).toMatchObject({ status: 404 });
      // Under the second business's context the first owner, who isn't on its team, reads nothing.
      await as(tx, "lobbystack_app");
      await tx.execute(rlsContextStatement({ userId: first.userId, businessId: second.businessId, actorType: "operator" }));
      expect(await tx.select().from(receptionistProfiles).where(eq(receptionistProfiles.businessId, second.businessId))).toEqual([]);
    });
  });

  it("deletes a business with several receptionists and everything that names them", async () => {
    await rollbackTest(async (tx) => {
      const { businessId, userId } = await seedBusiness(tx);
      await putOnPlan(tx, businessId, "pro");
      await asOwner(tx, { userId, businessId });
      const a = await createReceptionistInTransaction(tx, { businessId, actorUserId: userId, receptionist: { name: "A" } });
      const b = await createReceptionistInTransaction(tx, { businessId, actorUserId: userId, receptionist: { name: "B" } });
      await archiveReceptionistInTransaction(tx, { businessId, actorUserId: userId, receptionistId: b.id });
      await as(tx, null);
      await tx.insert(calls).values({ businessId, providerCallId: `call-${randomUUID()}`, transport: "sip", startedAt: new Date(), receptionistId: a.id });
      await tx.insert(conversations).values({ businessId, channel: "web_chat", receptionistId: b.id });
      await tx.insert(widgetKeys).values({ businessId, keyHash: `hash-${randomUUID()}`, receptionistId: a.id });
      await tx.insert(entryLinks).values({ businessId, receptionistId: b.id, code: randomUUID().replace(/-/g, "").slice(0, 8) });
      // A receptionist that something names can't be deleted on its own: receptionists are archived.
      expect(await failure(tx, (inner) => inner.delete(receptionistProfiles).where(eq(receptionistProfiles.id, a.id)))).toMatchObject({ cause: expect.objectContaining({ code: "23503" }) });
      await tx.delete(businesses).where(eq(businesses.id, businessId));
      expect(await tx.select().from(receptionistProfiles).where(eq(receptionistProfiles.businessId, businessId))).toEqual([]);
      expect(await tx.select().from(entryLinks).where(eq(entryLinks.businessId, businessId))).toEqual([]);
    });
  });
});
