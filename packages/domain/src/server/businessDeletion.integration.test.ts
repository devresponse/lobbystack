import { randomUUID } from "node:crypto";

import { and, eq, isNull, sql } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { auditLogs, billingAccounts, billingCheckoutRequests, businessMemberships, businesses, calls, contacts, conversations, createDatabaseClient, feedbackSubmissions, oauthAccessTokens, oauthClients, oauthConsents, oauthRefreshTokens, onboardingNumberClaimEvents, outboxMessages, phoneNumbers, productEvents, providerEvents, rlsContextStatement, services, storageObjects, users, type Database, type DatabaseTransaction } from "@lobbystack/db";

import { deleteBusiness, isBusinessDeleted, recordDeletedBusinessPlanEnded } from "./businessDeletion";
import { listUserBusinesses } from "./tenancy";

// Explicit opt-in only; never fall back to DATABASE_URL or load an env file.
const testUrl = process.env.LOBBYSTACK_RELIABILITY_TEST_DATABASE_URL;
if (testUrl) {
  const url = new URL(testUrl);
  if (process.env.NODE_ENV === "production" || !["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname) || !/test/i.test(url.pathname)) {
    throw new Error("Business deletion integration tests require a dedicated local test database.");
  }
}
const client = testUrl ? createDatabaseClient("lobbystack_migrator", { DATABASE_URL: testUrl }) : undefined;
afterAll(async () => { await client?.pool.end(); });
afterEach(() => { vi.unstubAllEnvs(); });

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

const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60_000);
const randomE164 = () => `+1555${Math.floor(1_000_000 + Math.random() * 8_999_999)}`;

/**
 * An owner whose first business, Main, is their root, and a later one named
 * Studio with an admin, a scheduler and a viewer, full of the rows a delete
 * has to reach. Everything is inserted as the migrator; `as` runs code as the
 * dashboard's database role, so row-level security and migration 0129's guard apply.
 */
async function seed(tx: DatabaseTransaction) {
  const db = tx as unknown as Database;
  const person = async () => {
    const id = randomUUID();
    await tx.insert(users).values({ id, email: `${id}@example.invalid`, normalizedEmail: `${id}@example.invalid` });
    return id;
  };
  const business = async (name: string, createdAt: Date) => {
    const id = randomUUID();
    await tx.insert(businesses).values({ id, slug: id, name, timezone: "UTC", businessType: "test", telemetryEnabled: false, createdAt });
    return id;
  };
  const join = async (businessId: string, userId: string, role: string, createdAt = new Date()) => {
    await tx.insert(businessMemberships).values({ businessId, userId, role, createdAt });
  };
  const ownerId = await person();
  const adminId = await person();
  const schedulerId = await person();
  const viewerId = await person();
  const rootId = await business("Main", daysAgo(30));
  const studioId = await business("Studio", daysAgo(2));
  await join(rootId, ownerId, "business_owner", daysAgo(30));
  await join(studioId, ownerId, "business_owner", daysAgo(2));
  await join(studioId, adminId, "business_admin");
  await join(studioId, schedulerId, "scheduler");
  await join(studioId, viewerId, "viewer");
  await tx.insert(services).values([{ businessId: rootId, name: "Consult", slug: "consult", durationMinutes: 30 }, { businessId: studioId, name: "Colour", slug: "colour", durationMinutes: 30 }]);
  await tx.update(users).set({ activeBusinessId: studioId }).where(eq(users.id, ownerId));
  await tx.update(users).set({ activeBusinessId: studioId }).where(eq(users.id, adminId));

  const as = async <T>(userId: string, run: () => Promise<T>, role: "lobbystack_app" | "lobbystack_worker" = "lobbystack_app"): Promise<T> => {
    await tx.execute(sql.raw(`set local role ${role}`));
    try {
      return await run();
    } finally {
      await tx.execute(sql`reset role`);
    }
  };
  const remove = (userId: string, businessId: string, confirmName: string) => as(userId, () => deleteBusiness({ db }, { userId, businessId, confirmName }));
  const exists = async (businessId: string) => (await tx.select({ id: businesses.id }).from(businesses).where(eq(businesses.id, businessId))).length === 1;
  return { db, person, business, join, ownerId, adminId, schedulerId, viewerId, rootId, studioId, as, remove, exists };
}

/** A business's rows that a delete must leave alone, counted. */
async function rootRows(tx: DatabaseTransaction, businessId: string) {
  return {
    memberships: (await tx.select({ id: businessMemberships.id }).from(businessMemberships).where(eq(businessMemberships.businessId, businessId))).length,
    services: (await tx.select({ id: services.id }).from(services).where(eq(services.businessId, businessId))).length,
  };
}

describe.skipIf(!client)("an account's root business can't be deleted", () => {
  it("refuses the owner's first business, typed and confirmed, and leaves all of it", async () => {
    await rollbackTest(async (tx) => {
      const { ownerId, rootId, remove, exists } = await seed(tx);
      const before = await rootRows(tx, rootId);
      await expect(remove(ownerId, rootId, "Main")).rejects.toMatchObject({ status: 403, code: "root_business", message: "This is the first business on your account, so it can't be deleted." });
      expect(await exists(rootId)).toBe(true);
      expect(await rootRows(tx, rootId)).toEqual(before);
    });
  });

  it("refuses an account's only business", async () => {
    await rollbackTest(async (tx) => {
      const { person, business, join, remove, exists } = await seed(tx);
      const soleOwner = await person();
      const only = await business("Only", daysAgo(10));
      await join(only, soleOwner, "business_owner", daysAgo(10));
      await expect(remove(soleOwner, only, "Only")).rejects.toMatchObject({ status: 403, code: "only_business" });
      expect(await exists(only)).toBe(true);
    });
  });

  it("refuses a business that's another owner's root, even for an owner with an older business", async () => {
    await rollbackTest(async (tx) => {
      const { person, join, ownerId, studioId, remove, exists } = await seed(tx);
      // Studio is the only business its second owner has, so it's their root.
      const coOwner = await person();
      await join(studioId, coOwner, "business_owner");
      await expect(remove(ownerId, studioId, "Studio")).rejects.toMatchObject({ status: 403, code: "root_business", message: "This is the first business on another owner's account, so it can't be deleted." });
      expect(await exists(studioId)).toBe(true);
    });
  });

  it("moves the root to the next oldest business once the owner no longer owns the first", async () => {
    await rollbackTest(async (tx) => {
      const { business, join, ownerId, rootId, studioId, remove, exists } = await seed(tx);
      const later = await business("Later", daysAgo(1));
      await join(later, ownerId, "business_owner", daysAgo(1));
      // As when Main is handed over to someone else: Studio is now the business the owner has owned longest.
      await tx.update(businessMemberships).set({ status: "removed" }).where(and(eq(businessMemberships.businessId, rootId), eq(businessMemberships.userId, ownerId)));
      await expect(remove(ownerId, studioId, "Studio")).rejects.toMatchObject({ status: 403, code: "root_business" });
      expect(await exists(studioId)).toBe(true);
      await remove(ownerId, later, "Later");
      expect(await exists(later)).toBe(false);
    });
  });

  it("marks root businesses in the workspace list, the caller's own apart from another owner's", async () => {
    await rollbackTest(async (tx) => {
      const { db, person, business, join, ownerId, rootId, studioId, as } = await seed(tx);
      const coOwner = await person();
      const coOwnerFirst = await business("Shared", daysAgo(5));
      await join(coOwnerFirst, coOwner, "business_owner", daysAgo(5));
      await join(coOwnerFirst, ownerId, "business_owner", daysAgo(1));
      const listed = await as(ownerId, () => listUserBusinesses(db, ownerId));
      const flags = Object.fromEntries(listed.map((entry) => [entry.businessId, [entry.isRoot, entry.isAccountRoot]]));
      expect(flags).toEqual({ [rootId]: [true, true], [studioId]: [false, false], [coOwnerFirst]: [true, false] });
    });
  });

  it("is refused by the database when the dashboard's role deletes a root business directly", async () => {
    await rollbackTest(async (tx) => {
      const { ownerId, rootId, as, exists } = await seed(tx);
      // As if the domain's checks were skipped: the owner, bound to their root business, deletes its row.
      const refused = await as(ownerId, async () => {
        await tx.execute(rlsContextStatement({ userId: ownerId, businessId: rootId, actorType: "operator" }));
        return await tx.transaction(async (inner) => { await inner.delete(businesses).where(eq(businesses.id, rootId)); }).catch((error: unknown) => error);
      });
      expect(refused).toMatchObject({ cause: expect.objectContaining({ code: "23001", constraint: "businesses_root_business" }) });
      expect(await exists(rootId)).toBe(true);
    });
  });

  it("is refused by the database when anyone but an owner deletes a business through the dashboard's role", async () => {
    await rollbackTest(async (tx) => {
      const { adminId, ownerId, studioId, as, exists } = await seed(tx);
      const attempt = (userId: string, actorType: "operator" | "system") => as(userId, async () => {
        await tx.execute(rlsContextStatement({ userId, businessId: studioId, actorType }));
        return await tx.transaction(async (inner) => { await inner.delete(businesses).where(eq(businesses.id, studioId)); }).catch((error: unknown) => error);
      });
      expect(await attempt(adminId, "operator")).toMatchObject({ cause: expect.objectContaining({ code: "42501", constraint: "businesses_owner_delete" }) });
      expect(await attempt(ownerId, "system")).toMatchObject({ cause: expect.objectContaining({ code: "42501", constraint: "businesses_owner_delete" }) });
      expect(await exists(studioId)).toBe(true);
    });
  });

  it("binds only the dashboard's role: the migrator's fixture cleanups and repairs still delete any business", async () => {
    await rollbackTest(async (tx) => {
      const { rootId, exists } = await seed(tx);
      await tx.delete(businesses).where(eq(businesses.id, rootId));
      expect(await exists(rootId)).toBe(false);
    });
  });
});

describe.skipIf(!client)("who may delete a business", () => {
  it("is only an active owner: admins, schedulers, viewers and outsiders are refused", async () => {
    await rollbackTest(async (tx) => {
      const { person, adminId, schedulerId, viewerId, studioId, remove, exists } = await seed(tx);
      const outsider = await person();
      for (const userId of [adminId, schedulerId, viewerId, outsider]) {
        await expect(remove(userId, studioId, "Studio")).rejects.toMatchObject({ status: 403, code: "forbidden" });
      }
      expect(await exists(studioId)).toBe(true);
    });
  });

  it("needs the business's name typed as it's shown, give or take spaces around it", async () => {
    await rollbackTest(async (tx) => {
      const { ownerId, studioId, remove, exists } = await seed(tx);
      for (const typed of ["Studios", "studio", ""]) {
        await expect(remove(ownerId, studioId, typed)).rejects.toMatchObject({ status: 400, code: "confirmation_mismatch" });
      }
      expect(await exists(studioId)).toBe(true);
      await remove(ownerId, studioId, "  Studio ");
      expect(await exists(studioId)).toBe(false);
    });
  });
});

describe.skipIf(!client)("a business with something under way", () => {
  it("waits while a phone number is being bought for it", async () => {
    await rollbackTest(async (tx) => {
      const { ownerId, studioId, remove, exists } = await seed(tx);
      await tx.insert(onboardingNumberClaimEvents).values({ businessId: studioId, userId: ownerId, requestedE164: randomE164(), selectionContext: {}, claimTokenHash: "hash", idempotencyKey: randomUUID(), status: "reserved" });
      await expect(remove(ownerId, studioId, "Studio")).rejects.toMatchObject({ status: 409, code: "number_in_progress" });
      expect(await exists(studioId)).toBe(true);
    });
  });

  it("waits for a live call to end, but not for one left open hours ago", async () => {
    await rollbackTest(async (tx) => {
      const { ownerId, studioId, remove, exists } = await seed(tx);
      const call = async (startedAt: Date) => {
        const conversationId = randomUUID();
        await tx.insert(conversations).values({ id: conversationId, businessId: studioId, channel: "voice" });
        const [row] = await tx.insert(calls).values({ businessId: studioId, conversationId, provider: "openai_live", providerCallId: `rtc_${randomUUID()}`, transport: "voice", status: "started", startedAt }).returning({ id: calls.id });
        return row!.id;
      };
      await call(new Date(Date.now() - 3 * 60 * 60_000));
      const live = await call(new Date(Date.now() - 60_000));
      await expect(remove(ownerId, studioId, "Studio")).rejects.toMatchObject({ status: 409, code: "call_in_progress" });
      await tx.update(calls).set({ status: "completed", endedAt: new Date() }).where(eq(calls.id, live));
      await remove(ownerId, studioId, "Studio");
      expect(await exists(studioId)).toBe(false);
    });
  });

  it("waits while a plan checkout from the last hour could still be paid", async () => {
    await rollbackTest(async (tx) => {
      const { ownerId, studioId, remove, exists } = await seed(tx);
      const [checkout] = await tx.insert(billingCheckoutRequests).values({ businessId: studioId, requestedByUserId: ownerId, target: "pro", billingInterval: "monthly", status: "ready", checkoutId: "checkout_1", checkoutUrl: "https://polar.example/checkout/1" }).returning({ id: billingCheckoutRequests.id });
      await expect(remove(ownerId, studioId, "Studio")).rejects.toMatchObject({ status: 409, code: "checkout_open" });
      await tx.update(billingCheckoutRequests).set({ updatedAt: new Date(Date.now() - 2 * 60 * 60_000) }).where(eq(billingCheckoutRequests.id, checkout!.id));
      await remove(ownerId, studioId, "Studio");
      expect(await exists(studioId)).toBe(false);
    });
  });

  it("leaves a plan the operator bills outside Polar to the operator", async () => {
    await rollbackTest(async (tx) => {
      const { ownerId, studioId, remove, exists } = await seed(tx);
      await tx.insert(billingAccounts).values({ businessId: studioId, billingKey: `business:${studioId}`, source: "managed", plan: "enterprise", subscriptionState: "active" });
      await expect(remove(ownerId, studioId, "Studio")).rejects.toMatchObject({ status: 409, code: "managed_plan" });
      expect(await exists(studioId)).toBe(true);
    });
  });
});

describe.skipIf(!client)("a business that pays for a plan", () => {
  it("asks the worker to end the plan first, and deletes once it has", async () => {
    await rollbackTest(async (tx) => {
      const { db, ownerId, studioId, as, remove, exists } = await seed(tx);
      await tx.insert(billingAccounts).values({ businessId: studioId, billingKey: `business:${studioId}`, plan: "pro", subscriptionId: "sub_1", subscriptionState: "active" });
      await expect(remove(ownerId, studioId, "Studio")).rejects.toMatchObject({ status: 409, code: "plan_ending" });
      // Asked twice in the same window, it queues the worker once.
      await expect(remove(ownerId, studioId, "Studio")).rejects.toMatchObject({ code: "plan_ending" });
      const revokes = await tx.select({ businessId: outboxMessages.businessId, payload: outboxMessages.payload }).from(outboxMessages).where(eq(outboxMessages.topic, "billing.revokeSubscription"));
      expect(revokes.filter((job) => job.businessId === studioId)).toEqual([{ businessId: studioId, payload: { subscriptionId: "sub_1" } }]);
      expect(await exists(studioId)).toBe(true);

      // The worker ends it with Polar and says so.
      expect(await as(ownerId, () => recordDeletedBusinessPlanEnded({ db }, { businessId: studioId, subscriptionId: "sub_1" }), "lobbystack_worker")).toBe(true);
      await remove(ownerId, studioId, "Studio");
      expect(await exists(studioId)).toBe(false);
    });
  });

  it("says the plan couldn't be canceled once the worker has had 10 minutes, and asks it again", async () => {
    await rollbackTest(async (tx) => {
      const { ownerId, studioId, remove } = await seed(tx);
      await tx.insert(billingAccounts).values({ businessId: studioId, billingKey: `business:${studioId}`, plan: "starter", subscriptionId: "sub_2", subscriptionState: "past_due" });
      await expect(remove(ownerId, studioId, "Studio")).rejects.toMatchObject({ code: "plan_ending" });
      await tx.update(outboxMessages).set({ createdAt: new Date(Date.now() - 11 * 60_000), dedupeKey: `billing-revoke:sub_2:earlier` }).where(and(eq(outboxMessages.businessId, studioId), eq(outboxMessages.topic, "billing.revokeSubscription")));
      await expect(remove(ownerId, studioId, "Studio")).rejects.toMatchObject({ status: 409, code: "plan_not_ended" });
      expect((await tx.select({ id: outboxMessages.id }).from(outboxMessages).where(and(eq(outboxMessages.businessId, studioId), eq(outboxMessages.topic, "billing.revokeSubscription")))).length).toBe(2);
    });
  });

  it("goes ahead at once when the plan has already ended", async () => {
    await rollbackTest(async (tx) => {
      const { ownerId, studioId, remove, exists } = await seed(tx);
      await tx.insert(billingAccounts).values({ businessId: studioId, billingKey: `business:${studioId}`, plan: "pro", subscriptionId: "sub_3", subscriptionState: "canceled" });
      await remove(ownerId, studioId, "Studio");
      expect(await exists(studioId)).toBe(false);
    });
  });
});

describe.skipIf(!client)("deleting a business", () => {
  it("erases it and everything that names it, queues its numbers and files for the worker, and moves its people elsewhere", async () => {
    await rollbackTest(async (tx) => {
      const { db, ownerId, adminId, rootId, studioId, as, remove, exists } = await seed(tx);
      const sharedSender = randomE164();
      vi.stubEnv("TWILIO_ALERT_SMS_FROM", sharedSender);
      const contactId = randomUUID();
      await tx.insert(contacts).values({ id: contactId, businessId: studioId, name: "Marie Tremblay", phone: "+14155550100" });
      const conversationId = randomUUID();
      await tx.insert(conversations).values({ id: conversationId, businessId: studioId, contactId, channel: "voice" });
      await tx.insert(calls).values({ businessId: studioId, conversationId, contactId, provider: "openai_live", providerCallId: `rtc_${randomUUID()}`, transport: "voice", status: "completed", startedAt: daysAgo(1), endedAt: daysAgo(1) });
      await tx.insert(auditLogs).values({ businessId: studioId, actorUserId: ownerId, eventType: "business.updated", entityType: "business", entityId: studioId });
      const ownNumber = `PN${randomUUID().replaceAll("-", "")}`;
      const releasingNumber = `PN${randomUUID().replaceAll("-", "")}`;
      await tx.insert(phoneNumbers).values([
        { businessId: studioId, e164: randomE164(), providerPhoneId: ownNumber },
        { businessId: studioId, e164: randomE164(), providerPhoneId: releasingNumber, status: "reclaiming" },
        { businessId: studioId, e164: randomE164(), providerPhoneId: `PN${randomUUID().replaceAll("-", "")}`, status: "reclaimed" },
        { businessId: studioId, e164: sharedSender, providerPhoneId: `PN${randomUUID().replaceAll("-", "")}` },
      ]);
      const recording = `${studioId}/recording/${randomUUID()}/call.wav`;
      const document = `${studioId}/knowledge/${randomUUID()}/menu.pdf`;
      await tx.insert(storageObjects).values([
        { businessId: studioId, objectKey: recording, purpose: "recording", fileName: "call.wav", contentType: "audio/wav", status: "ready" },
        { businessId: studioId, objectKey: document, purpose: "knowledge", fileName: "menu.pdf", contentType: "application/pdf", status: "pending" },
        { businessId: studioId, objectKey: `${studioId}/attachment/${randomUUID()}/gone.txt`, purpose: "attachment", fileName: "gone.txt", contentType: "text/plain", status: "deleted" },
      ]);
      await tx.insert(providerEvents).values({ provider: "polar", providerEventId: randomUUID(), eventType: "subscription.active", businessId: studioId, payload: { customerEmail: "owner@example.invalid" } });
      await tx.insert(productEvents).values({ name: "test", distinctId: "d", businessId: studioId, properties: {} });
      await tx.insert(feedbackSubmissions).values([{ userId: ownerId, businessId: studioId, businessName: "Studio", message: "Hello" }, { userId: adminId, businessId: studioId, businessName: "Studio", message: "From the admin" }]);
      await tx.insert(outboxMessages).values([
        { topic: "email.send", businessId: studioId, aggregateType: "business", aggregateId: studioId, dedupeKey: `test:${randomUUID()}`, payload: { to: "owner@example.invalid" } },
        { topic: "snapshot.refresh", businessId: studioId, aggregateType: "business", aggregateId: studioId, dedupeKey: `test:${randomUUID()}`, payload: {}, publishedAt: new Date() },
      ]);
      const clientId = `client_${randomUUID()}`;
      await tx.insert(oauthClients).values({ clientId, redirectUris: ["https://client.example/callback"] });
      await tx.insert(oauthConsents).values({ clientId, userId: ownerId, referenceId: studioId, scopes: ["mcp"] });
      const [refresh] = await tx.insert(oauthRefreshTokens).values({ token: randomUUID(), clientId, userId: ownerId, referenceId: studioId, scopes: ["mcp"] }).returning({ id: oauthRefreshTokens.id });
      await tx.insert(oauthAccessTokens).values({ token: randomUUID(), clientId, userId: ownerId, referenceId: studioId, refreshId: refresh!.id, scopes: ["mcp"] });
      await tx.insert(oauthConsents).values({ clientId, userId: ownerId, referenceId: rootId, scopes: ["mcp"] });

      expect(await remove(ownerId, studioId, "Studio")).toEqual({ releasedNumbers: 2, storedFiles: 2 });
      expect(await exists(studioId)).toBe(false);

      for (const table of [businessMemberships, services, contacts, conversations, calls, auditLogs, phoneNumbers, storageObjects, providerEvents, productEvents, feedbackSubmissions]) {
        expect(await tx.select({ businessId: table.businessId }).from(table).where(eq(table.businessId, studioId))).toEqual([]);
      }
      // Nothing that named it stays unlinked: not its feedback, events or jobs.
      expect(await tx.select({ message: feedbackSubmissions.message }).from(feedbackSubmissions).where(and(isNull(feedbackSubmissions.businessId), eq(feedbackSubmissions.businessName, "Studio")))).toEqual([]);
      for (const table of [oauthConsents, oauthRefreshTokens, oauthAccessTokens]) {
        expect(await tx.select({ referenceId: table.referenceId }).from(table).where(eq(table.referenceId, studioId))).toEqual([]);
      }
      expect(await tx.select({ referenceId: oauthConsents.referenceId }).from(oauthConsents).where(eq(oauthConsents.referenceId, rootId))).toEqual([{ referenceId: rootId }]);

      // Its jobs that hadn't gone out are dropped, and the worker's cleanup outlives it, naming it in the payload.
      const jobs = await tx.select({ topic: outboxMessages.topic, businessId: outboxMessages.businessId, payload: outboxMessages.payload }).from(outboxMessages).where(eq(outboxMessages.aggregateId, studioId));
      expect(jobs).toEqual(expect.arrayContaining([
        { topic: "phoneNumber.releaseDeleted", businessId: null, payload: { businessId: studioId, providerPhoneId: ownNumber } },
        { topic: "phoneNumber.releaseDeleted", businessId: null, payload: { businessId: studioId, providerPhoneId: releasingNumber } },
        { topic: "privacy.deleteStoredObjects", businessId: null, payload: { businessId: studioId, objectKeys: expect.arrayContaining([recording, document]) } },
      ]));
      expect(jobs).toHaveLength(3);

      // People keep their accounts; whoever had Studio open moves to another business of theirs, or to none.
      const people = await tx.select({ id: users.id, activeBusinessId: users.activeBusinessId }).from(users).where(sql`${users.id} in (${ownerId}, ${adminId})`);
      expect(Object.fromEntries(people.map((row) => [row.id, row.activeBusinessId]))).toEqual({ [ownerId]: rootId, [adminId]: null });
      // The root business is untouched.
      expect(await rootRows(tx, rootId)).toEqual({ memberships: 1, services: 1 });

      // The worker's jobs act only once their business is gone.
      expect(await as(ownerId, () => isBusinessDeleted({ db }, studioId), "lobbystack_worker")).toBe(true);
      expect(await as(ownerId, () => isBusinessDeleted({ db }, rootId), "lobbystack_worker")).toBe(false);
    });
  });
});
