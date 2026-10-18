import { createHash, randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { auditLogs, businessHours, businessMemberships, businessPublicProfiles, businesses, closures, createDatabaseClient, phoneNumbers, receptionistProfiles, services, staff, users, widgetKeys, withBusinessTransaction, type Database, type DatabaseTransaction } from "@lobbystack/db";
import type { PublicProfileSettings } from "@lobbystack/shared";

import { getBusinessPublicProfileSettings, getPublicBusinessProfile, resolvePublicProfileBusiness, savePublicProfileInTransaction, updateBusinessPublicProfile } from "./publicProfiles";

// Explicit opt-in only; never fall back to DATABASE_URL or load an env file.
const testUrl = process.env.LOBBYSTACK_RELIABILITY_TEST_DATABASE_URL;
if (testUrl) {
  const url = new URL(testUrl);
  if (process.env.NODE_ENV === "production" || !["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname) || !/test/i.test(url.pathname)) {
    throw new Error("Public profile integration tests require a dedicated local test database.");
  }
}
const client = testUrl ? createDatabaseClient("lobbystack_migrator", { DATABASE_URL: testUrl }) : undefined;
afterAll(async () => { await client?.pool.end(); });

async function rollbackTest(run: (tx: DatabaseTransaction) => Promise<void>) {
  const rollback = new Error("rollback test fixture");
  try {
    await client!.db.transaction(async (tx) => {
      await run(tx);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
}

const DAY_MS = 86_400_000;

/**
 * The fixture's transaction as a database whose transactions run one at a
 * time. The page checks several opening times at once, each in a transaction
 * on its own connection; here they all share the fixture's connection, which
 * runs one query at a time.
 */
function oneTransactionAtATime(tx: DatabaseTransaction): Database {
  let previous: Promise<unknown> = Promise.resolve();
  const transaction: DatabaseTransaction["transaction"] = (run) => {
    const next = previous.then(() => tx.transaction(run));
    previous = next.catch(() => undefined);
    return next;
  };
  return new Proxy(tx, { get: (target, property) => property === "transaction" ? transaction : Reflect.get(target, property) }) as unknown as Database;
}

async function addUser(tx: DatabaseTransaction): Promise<string> {
  const id = randomUUID();
  await tx.insert(users).values({ id, email: `${id}@example.invalid`, normalizedEmail: `${id}@example.invalid` });
  return id;
}

async function addWidgetKey(tx: DatabaseTransaction, businessId: string, values: { status?: string; keyValue?: string | null; lastUsedAt?: Date } = {}): Promise<{ id: string; keyValue: string | null }> {
  const keyValue = values.keyValue === undefined ? `wk_test_${randomUUID().replaceAll("-", "")}` : values.keyValue;
  const [key] = await tx.insert(widgetKeys).values({
    businessId,
    keyHash: createHash("sha256").update(keyValue ?? randomUUID()).digest("hex"),
    keyValue,
    status: values.status ?? "active",
    ...(values.lastUsedAt ? { lastUsedAt: values.lastUsedAt } : {}),
  }).returning({ id: widgetKeys.id, keyValue: widgetKeys.keyValue });
  return key!;
}

/**
 * A clinic open around the clock in UTC with one service and one staff member,
 * its owner, an admin, a scheduler and someone from outside, and a widget.
 * Fixture rows are written as the migrator; each step below then runs as the
 * role the dashboard or the public page uses.
 */
async function seed(tx: DatabaseTransaction) {
  await tx.execute(sql`reset role`);
  const businessId = randomUUID();
  const slug = `pp-${businessId}`;
  await tx.insert(businesses).values({ id: businessId, slug, name: "Acme Dental", timezone: "UTC", businessType: "test", websiteUrl: "https://acmedental.example", telemetryEnabled: false });
  const [ownerId, adminId, schedulerId, outsiderId] = [await addUser(tx), await addUser(tx), await addUser(tx), await addUser(tx)];
  await tx.insert(businessMemberships).values([
    { businessId, userId: ownerId!, role: "business_owner" },
    { businessId, userId: adminId!, role: "business_admin" },
    { businessId, userId: schedulerId!, role: "scheduler" },
  ]);
  await tx.insert(receptionistProfiles).values({ businessId, greeting: "Hi", tone: "warm", summary: "A family dental clinic.", summarySource: "generated", bookingPolicy: "Book", transferMode: "on_request", transferNumber: "+16045550199", bookingMode: "instant" });
  await tx.insert(staff).values({ businessId, name: "Dr. Lee", timezone: "UTC" });
  const [service] = await tx.insert(services).values({ businessId, name: "Check-up", slug: "check-up", durationMinutes: 30 }).returning({ id: services.id });
  await tx.insert(businessHours).values(Array.from({ length: 7 }, (_, dayOfWeek) => ({ businessId, dayOfWeek, openMinutes: 0, closeMinutes: 1440 })));
  const e164 = `+1604${String(Math.floor(Math.random() * 10_000_000)).padStart(7, "0")}`;
  await tx.insert(phoneNumbers).values({ businessId, e164 });
  const widget = await addWidgetKey(tx, businessId, { lastUsedAt: new Date() });
  const db = tx as unknown as Database;
  const as = async (role: "lobbystack_app" | "lobbystack_worker" | null) => {
    await tx.execute(sql.raw(role ? `set local role ${role}` : "reset role"));
  };
  const settings = (overrides: Partial<PublicProfileSettings> = {}): PublicProfileSettings => ({
    published: true,
    category: "Dental clinic",
    description: "Family dental clinic.",
    address: { line1: "418 Larkspur Street", line2: null, city: "Vancouver", region: "BC", postalCode: "V5T 1A1", countryCode: "CA" },
    publicEmail: "hello@acmedental.example",
    showPhone: true,
    showHours: true,
    showServices: true,
    showMap: true,
    widgetKeyId: widget.id,
    ...overrides,
  });
  return {
    businessId, slug, ownerId: ownerId!, adminId: adminId!, schedulerId: schedulerId!, outsiderId: outsiderId!, serviceId: service!.id, e164, widget, db, as, settings,
    /** Saves the settings as the dashboard does: the app role, in an operator transaction for this business. */
    save: async (userId: string, value: PublicProfileSettings) => {
      await as("lobbystack_app");
      try {
        return await withBusinessTransaction(db, { businessId, userId, actorType: "operator" }, async (inner) => await updateBusinessPublicProfile(inner, { businessId, userId, settings: value }));
      } finally {
        await as(null);
      }
    },
    /** The page's data as /profile/<slug> reads it: the worker role. */
    page: async (input: { previewUserId?: string } = {}) => {
      await as("lobbystack_worker");
      try {
        return await getPublicBusinessProfile({ db: oneTransactionAtATime(tx) }, { slug, ...input });
      } finally {
        await as(null);
      }
    },
    resolve: async () => {
      await as("lobbystack_worker");
      try {
        return await resolvePublicProfileBusiness({ db }, slug);
      } finally {
        await as(null);
      }
    },
  };
}

describe.skipIf(!client)("public profile pages", () => {
  it("stays private until an owner or admin publishes it, and records who did", async () => {
    await rollbackTest(async (tx) => {
      const fixture = await seed(tx);
      expect(await fixture.resolve()).toBeNull();
      expect(await fixture.page()).toBeNull();
      // Members can preview a page that isn't public yet; nobody else can.
      expect(await fixture.page({ previewUserId: fixture.outsiderId })).toBeNull();
      // Before the first save, the preview shows the defaults the settings tab offers.
      expect(await fixture.page({ previewUserId: fixture.schedulerId })).toMatchObject({ slug: fixture.slug, published: false, name: "Acme Dental", description: "A family dental clinic.", widgetKey: fixture.widget.keyValue });

      await expect(fixture.save(fixture.schedulerId, fixture.settings())).rejects.toMatchObject({ status: 403 });
      await expect(fixture.save(fixture.outsiderId, fixture.settings())).rejects.toMatchObject({ status: 403 });
      expect(await fixture.resolve()).toBeNull();

      const saved = await fixture.save(fixture.adminId, fixture.settings());
      expect(saved).toMatchObject({ saved: true, slug: fixture.slug, settings: fixture.settings(), widgetKeys: [{ id: fixture.widget.id }] });
      expect(saved.publishedAt).not.toBeNull();
      expect(await fixture.resolve()).toBe(fixture.businessId);

      const page = await fixture.page();
      expect(page).toMatchObject({
        published: true,
        name: "Acme Dental",
        category: "Dental clinic",
        address: { line1: "418 Larkspur Street", city: "Vancouver" },
        phone: fixture.e164,
        email: "hello@acmedental.example",
        websiteUrl: "https://acmedental.example/",
        services: [{ name: "Check-up", durationMinutes: 30, description: null }],
        bookingMode: "instant",
        personRequests: "any_time",
        widgetKey: fixture.widget.keyValue,
        nextOpening: { serviceName: "Check-up" },
      });
      expect(page!.hours).toHaveLength(7);
      // The clinic never closes, so the next opening is the next half hour.
      const nextOpening = Date.parse(page!.nextOpening!.startsAt);
      expect(nextOpening).toBeGreaterThan(Date.now());
      expect(nextOpening).toBeLessThanOrEqual(Date.now() + 60 * 60_000);
      expect(JSON.stringify(page)).not.toContain("6045550199");

      // Saving again while published keeps the first publish time and logs nothing new.
      expect((await fixture.save(fixture.ownerId, fixture.settings({ category: "Dentist" }))).publishedAt).toBe(saved.publishedAt);
      await fixture.save(fixture.ownerId, fixture.settings({ published: false }));
      expect(await fixture.resolve()).toBeNull();
      expect(await fixture.page()).toBeNull();

      // Rows from one transaction share a timestamp, so sort them by name.
      const events = await tx.select({ eventType: auditLogs.eventType, actorUserId: auditLogs.actorUserId, entityId: auditLogs.entityId })
        .from(auditLogs)
        .where(and(eq(auditLogs.businessId, fixture.businessId), sql`${auditLogs.eventType} like 'public_profile.%'`))
        .orderBy(auditLogs.eventType);
      expect(events).toEqual([
        { eventType: "public_profile.published", actorUserId: fixture.adminId, entityId: fixture.businessId },
        { eventType: "public_profile.unpublished", actorUserId: fixture.ownerId, entityId: fixture.businessId },
      ]);
    });
  });

  it("only shows one of the business's own active widgets", async () => {
    await rollbackTest(async (tx) => {
      const fixture = await seed(tx);
      const otherBusinessId = randomUUID();
      await tx.insert(businesses).values({ id: otherBusinessId, slug: `pp-${otherBusinessId}`, name: "Other", timezone: "UTC", businessType: "test", telemetryEnabled: false });
      const othersWidget = await addWidgetKey(tx, otherBusinessId);
      const disabled = await addWidgetKey(tx, fixture.businessId, { status: "disabled" });
      const withoutSnippet = await addWidgetKey(tx, fixture.businessId, { keyValue: null });
      for (const widgetKeyId of [othersWidget.id, disabled.id, withoutSnippet.id, randomUUID()]) {
        await expect(fixture.save(fixture.ownerId, fixture.settings({ widgetKeyId }))).rejects.toMatchObject({ status: 400, code: "widget_key_unavailable" });
      }
      expect((await fixture.save(fixture.ownerId, fixture.settings({ widgetKeyId: null }))).settings.widgetKeyId).toBeNull();
      expect((await fixture.page())?.widgetKey).toBeNull();

      // A widget paused after the page went up leaves the page without a chat.
      await fixture.save(fixture.ownerId, fixture.settings());
      await tx.update(widgetKeys).set({ status: "disabled" }).where(eq(widgetKeys.id, fixture.widget.id));
      expect((await fixture.page())?.widgetKey).toBeNull();
    });
  });

  it("leaves out what the owner hides, and closures beyond the next 30 days", async () => {
    await rollbackTest(async (tx) => {
      const fixture = await seed(tx);
      const now = Date.now();
      await tx.insert(closures).values([
        { businessId: fixture.businessId, startsAt: new Date(now - 2 * DAY_MS), endsAt: new Date(now - DAY_MS), reason: "Over" },
        { businessId: fixture.businessId, startsAt: new Date(now + 10 * DAY_MS), endsAt: new Date(now + 11 * DAY_MS), reason: "Remembrance Day" },
        { businessId: fixture.businessId, startsAt: new Date(now + 60 * DAY_MS), endsAt: new Date(now + 61 * DAY_MS), reason: "Later" },
      ]);
      await fixture.save(fixture.ownerId, fixture.settings());
      expect((await fixture.page())?.closures?.map((closure) => closure.reason)).toEqual(["Remembrance Day"]);

      await fixture.save(fixture.ownerId, fixture.settings({ showPhone: false, showHours: false, showServices: false, showMap: false }));
      expect(await fixture.page()).toMatchObject({ phone: null, hours: null, closures: null, services: null, showMap: false });
    });
  });

  it("shows no next opening when the receptionist doesn't book or nobody can take the service", async () => {
    await rollbackTest(async (tx) => {
      const fixture = await seed(tx);
      await fixture.save(fixture.ownerId, fixture.settings());
      await tx.update(receptionistProfiles).set({ bookingMode: "request" }).where(eq(receptionistProfiles.businessId, fixture.businessId));
      expect(await fixture.page()).toMatchObject({ bookingMode: "request", nextOpening: null });

      await tx.update(receptionistProfiles).set({ bookingMode: "instant" }).where(eq(receptionistProfiles.businessId, fixture.businessId));
      await tx.update(staff).set({ active: false }).where(eq(staff.businessId, fixture.businessId));
      expect(await fixture.page()).toMatchObject({ bookingMode: "instant", nextOpening: null });
    });
  });

  it("has no page for a business that isn't active, even for its members", async () => {
    await rollbackTest(async (tx) => {
      const fixture = await seed(tx);
      await fixture.save(fixture.ownerId, fixture.settings());
      await tx.update(businesses).set({ status: "suspended" }).where(eq(businesses.id, fixture.businessId));
      expect(await fixture.resolve()).toBeNull();
      expect(await fixture.page()).toBeNull();
      expect(await fixture.page({ previewUserId: fixture.ownerId })).toBeNull();
    });
  });

  it("starts from the receptionist's summary and the most recently used widget", async () => {
    await rollbackTest(async (tx) => {
      const fixture = await seed(tx);
      await addWidgetKey(tx, fixture.businessId, { lastUsedAt: new Date(Date.now() - DAY_MS) });
      await fixture.as("lobbystack_app");
      const view = await withBusinessTransaction(fixture.db, { businessId: fixture.businessId, userId: fixture.schedulerId, actorType: "operator" }, async (inner) => await getBusinessPublicProfileSettings(inner, { businessId: fixture.businessId }));
      await fixture.as(null);
      expect(view).toMatchObject({ saved: false, slug: fixture.slug, businessName: "Acme Dental", publishedAt: null });
      expect(view.settings).toMatchObject({ published: false, description: "A family dental clinic.", widgetKeyId: fixture.widget.id, showPhone: true, showMap: true });
      expect(view.widgetKeys.map((key) => key.id)[0]).toBe(fixture.widget.id);
    });
  });

  it("keeps each business's page settings to itself", async () => {
    await rollbackTest(async (tx) => {
      const fixture = await seed(tx);
      await fixture.save(fixture.ownerId, fixture.settings());
      const other = await seed(tx);
      // Another business's context, as the worker and as one of its own owners.
      for (const context of [{ actorType: "worker" as const }, { actorType: "operator" as const, userId: other.ownerId }]) {
        await fixture.as(context.actorType === "worker" ? "lobbystack_worker" : "lobbystack_app");
        const rows = await withBusinessTransaction(fixture.db, { businessId: other.businessId, ...context }, async (inner) => await inner.select({ businessId: businessPublicProfiles.businessId }).from(businessPublicProfiles).where(eq(businessPublicProfiles.businessId, fixture.businessId)));
        expect(rows).toEqual([]);
        await expect(withBusinessTransaction(fixture.db, { businessId: other.businessId, ...context }, async (inner) => {
          await inner.insert(businessPublicProfiles).values({ businessId: fixture.businessId, published: true }).onConflictDoUpdate({ target: businessPublicProfiles.businessId, set: { published: false } });
        })).rejects.toMatchObject({ cause: { message: expect.stringMatching(/row-level security/) } });
        await fixture.as(null);
      }
      // An owner of the other business can't read this one's settings by naming it either.
      await fixture.as("lobbystack_app");
      const named = await withBusinessTransaction(fixture.db, { businessId: fixture.businessId, userId: other.ownerId, actorType: "operator" }, async (inner) => await inner.select().from(businessPublicProfiles).where(eq(businessPublicProfiles.businessId, fixture.businessId)));
      await fixture.as(null);
      expect(named).toEqual([]);
      expect(await fixture.resolve()).toBe(fixture.businessId);
    });
  });

  it("records one publish when the first two saves land at once, and lets an API save and a dashboard save wait for each other", async () => {
    // Two admins' first saves, each on its own connection, so the rows are committed and removed after.
    const db = client!.db;
    const businessId = randomUUID();
    const adminIds = [randomUUID(), randomUUID()];
    await db.insert(businesses).values({ id: businessId, slug: `pp-race-${businessId}`, name: "Race Dental", timezone: "UTC", businessType: "test", telemetryEnabled: false });
    for (const id of adminIds) await db.insert(users).values({ id, email: `${id}@example.invalid`, normalizedEmail: `${id}@example.invalid` });
    await db.insert(businessMemberships).values(adminIds.map((userId) => ({ businessId, userId, role: "business_admin" })));
    const settings: PublicProfileSettings = { published: true, category: null, description: null, address: { line1: null, line2: null, city: "Vancouver", region: null, postalCode: null, countryCode: null }, publicEmail: null, showPhone: true, showHours: true, showServices: true, showMap: true, widgetKeyId: null };
    const save = (userId: string) => withBusinessTransaction(db, { businessId, userId, actorType: "operator" }, async (inner) => {
      await inner.execute(sql`set local role lobbystack_app`);
      return await updateBusinessPublicProfile(inner, { businessId, userId, settings });
    });
    try {
      // Holding the table back lines both saves up at their first read of it.
      const saves = await db.transaction(async (hold) => {
        await hold.execute(sql`lock table business_public_profiles in access exclusive mode`);
        const pending = adminIds.map((userId) => save(userId));
        const waiting = async () => Number((await db.execute<{ count: string }>(sql`select count(*) as count from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and (query like '%business_public_profiles%' or query like '%public-profile:%')`)).rows[0]?.count ?? 0);
        for (let attempt = 0; attempt < 100 && await waiting() < 2; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
        return pending;
      });
      await Promise.all(saves);
      const published = await db.select({ id: auditLogs.id }).from(auditLogs).where(and(eq(auditLogs.businessId, businessId), eq(auditLogs.eventType, "public_profile.published")));
      expect(published).toHaveLength(1);

      // An API save holds the saved page while it works out the change, and a
      // dashboard save waits for it instead of locking the two in a deadlock.
      let locked: () => void = () => undefined;
      let release: () => void = () => undefined;
      const isLocked = new Promise<void>((resolve) => { locked = resolve; });
      const released = new Promise<void>((resolve) => { release = resolve; });
      const api = withBusinessTransaction(db, { businessId, userId: adminIds[0]!, actorType: "operator" }, async (inner) => {
        await inner.execute(sql`set local role lobbystack_app`);
        const view = await getBusinessPublicProfileSettings(inner, { businessId, lock: true });
        locked();
        await released;
        await savePublicProfileInTransaction(inner, { businessId, settings: { ...view.settings, showMap: false }, audit: { actorUserId: adminIds[0]! } });
      });
      await isLocked;
      const dashboard = save(adminIds[1]!);
      const waiting = async () => Number((await db.execute<{ count: string }>(sql`select count(*) as count from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and (query like '%business_public_profiles%' or query like '%public-profile:%')`)).rows[0]?.count ?? 0);
      for (let attempt = 0; attempt < 100 && await waiting() < 1; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
      release();
      await Promise.all([api, dashboard]);
    } finally {
      await db.delete(businesses).where(eq(businesses.id, businessId));
      for (const id of adminIds) await db.delete(users).where(eq(users.id, id));
    }
  });
});
