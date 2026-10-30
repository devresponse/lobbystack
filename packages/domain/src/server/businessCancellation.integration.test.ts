import { createHash, randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { auditLogs, billingAccounts, businessCancellationRequests, businessInvitations, businessMemberships, businesses, calls, createDatabaseClient, listSchedulerBusinesses, outboxMessages, phoneNumbers, services, users, withBusinessTransaction, type Database, type DatabaseTransaction } from "@lobbystack/db";

import { requireBusinessMembership } from "../authz";
import { confirmBusinessCancellation, previewBusinessCancellation, requestBusinessCancellation } from "./businessCancellation";
import { deleteBusiness } from "./businessDeletion";
import { getActiveOnboardingState } from "./onboarding";
import { createBusiness, listUserBusinesses } from "./tenancy";

// The inbox is the brand's contact address; each test sets it, or leaves none.
const brand = vi.hoisted(() => ({ contactEmail: "inbox@example.test" as string | null }));
vi.mock("@lobbystack/shared", async (importOriginal) => {
  const original = await importOriginal<typeof import("@lobbystack/shared")>();
  return { ...original, brandLinks: () => ({ ...original.brandLinks(), contactEmail: brand.contactEmail }) };
});

// Explicit opt-in only; never fall back to DATABASE_URL or load an env file.
const testUrl = process.env.LOBBYSTACK_RELIABILITY_TEST_DATABASE_URL;
if (testUrl) {
  const url = new URL(testUrl);
  if (process.env.NODE_ENV === "production" || !["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname) || !/test/i.test(url.pathname)) {
    throw new Error("Business cancellation integration tests require a dedicated local test database.");
  }
}
const client = testUrl ? createDatabaseClient("lobbystack_migrator", { DATABASE_URL: testUrl }) : undefined;
afterAll(async () => { await client?.pool.end(); });
beforeEach(() => { brand.contactEmail = "inbox@example.test"; vi.stubEnv("FEEDBACK_TO_EMAIL", ""); vi.stubEnv("APP_BASE_URL", "https://app.example.test"); });
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
const hash = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * An owner whose only business, Main, is their root, with an admin and a
 * viewer, a phone number, a plan paid through Polar and a service. Everything
 * is inserted as the migrator; `as` runs code as the dashboard's database
 * role, so row-level security and migration 0130's guards apply.
 */
async function seed(tx: DatabaseTransaction) {
  const db = tx as unknown as Database;
  const person = async (name?: string) => {
    const id = randomUUID();
    await tx.insert(users).values({ id, email: `${id}@example.invalid`, normalizedEmail: `${id}@example.invalid`, ...(name ? { name } : {}) });
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
  const ownerId = await person("Ana Owner");
  const adminId = await person();
  const viewerId = await person();
  const mainId = await business("Main", daysAgo(30));
  await join(mainId, ownerId, "business_owner", daysAgo(30));
  await join(mainId, adminId, "business_admin");
  await join(mainId, viewerId, "viewer");
  await tx.update(users).set({ activeBusinessId: mainId }).where(eq(users.id, ownerId));
  await tx.update(users).set({ activeBusinessId: mainId }).where(eq(users.id, adminId));
  const number = randomE164();
  await tx.insert(phoneNumbers).values({ businessId: mainId, e164: number, providerPhoneId: `PN${randomUUID().replaceAll("-", "")}` });
  await tx.insert(billingAccounts).values({ businessId: mainId, billingKey: `business:${mainId}`, plan: "starter", billingInterval: "monthly", subscriptionId: `sub_${mainId}`, subscriptionState: "active" });
  await tx.insert(services).values({ businessId: mainId, name: "Consult", slug: "consult", durationMinutes: 30 });

  const as = async <T>(run: () => Promise<T>, role: "lobbystack_app" | "lobbystack_worker" = "lobbystack_app"): Promise<T> => {
    await tx.execute(sql.raw(`set local role ${role}`));
    try {
      return await run();
    } finally {
      await tx.execute(sql`reset role`);
    }
  };
  const request = (userId: string, businessId = mainId, confirmName = "Main") => as(() => requestBusinessCancellation({ db }, { userId, businessId, confirmName, locale: "fr" }));
  /** The token in the link that still works, from its email as the worker would send it. Every row here shares the fixture transaction's now(), so the pending row is the newest. */
  const latestToken = async (businessId = mainId) => {
    const rows = await tx.select({ payload: outboxMessages.payload }).from(outboxMessages).where(and(eq(outboxMessages.businessId, businessId), eq(outboxMessages.topic, "email.send"), sql`${outboxMessages.payload}->>'template' = 'cancellation_confirm'`));
    const [pending] = await tx.select({ tokenHash: businessCancellationRequests.tokenHash }).from(businessCancellationRequests).where(and(eq(businessCancellationRequests.businessId, businessId), eq(businessCancellationRequests.status, "pending")));
    return String(rows.map((row) => row.payload.token).find((token) => hash(String(token)) === pending?.tokenHash));
  };
  const confirm = (userId: string, token: string) => as(() => confirmBusinessCancellation({ db }, { userId, tokenHash: hash(token) }));
  const status = async (businessId = mainId) => (await tx.select({ status: businesses.status, canceledAt: businesses.canceledAt, canceledBy: businesses.canceledByUserId }).from(businesses).where(eq(businesses.id, businessId)))[0];
  const emails = async (template: string, businessId = mainId) => (await tx.select({ payload: outboxMessages.payload }).from(outboxMessages).where(and(eq(outboxMessages.businessId, businessId), eq(outboxMessages.topic, "email.send"), sql`${outboxMessages.payload}->>'template' = ${template}`))).map((row) => row.payload);
  const jobs = async (topic: string, businessId = mainId) => (await tx.select({ payload: outboxMessages.payload }).from(outboxMessages).where(and(eq(outboxMessages.businessId, businessId), eq(outboxMessages.topic, topic)))).map((row) => row.payload);
  /** What a team member can still reach of the business, as the dashboard's role. */
  const reach = (userId: string, businessId = mainId) => as(async () => await withBusinessTransaction(db, { userId, businessId, actorType: "operator" }, async (inner) => ({
    member: await requireBusinessMembership(inner, { userId, businessId }).then(() => true, () => false),
    services: (await inner.select({ id: services.id }).from(services).where(eq(services.businessId, businessId))).length,
    workspaces: (await inner.execute<{ business_id: string }>(sql`select business_id from app.list_user_businesses(${userId})`)).rows.map((row) => row.business_id),
  })));
  return { db, person, business, join, ownerId, adminId, viewerId, mainId, number, as, request, latestToken, confirm, status, emails, jobs, reach };
}

describe.skipIf(!client)("asking to cancel an account", () => {
  it("emails the owner a link for 24 hours and the inbox the business's details, and changes nothing else", async () => {
    await rollbackTest(async (tx) => {
      const { ownerId, mainId, number, request, emails, jobs, status, reach } = await seed(tx);
      const asked = await request(ownerId);
      const [owner] = await tx.select({ email: users.email }).from(users).where(eq(users.id, ownerId));

      expect(asked).toMatchObject({ email: owner!.email, inboxNotified: true });
      expect(Math.abs(asked.expiresAt.getTime() - (Date.now() + 24 * 60 * 60_000))).toBeLessThan(60_000);
      const [row] = await tx.select().from(businessCancellationRequests).where(eq(businessCancellationRequests.businessId, mainId));
      expect(row).toMatchObject({ requestedByUserId: ownerId, email: owner!.email, status: "pending", confirmedAt: null });
      // Only the hash is kept; the email carries the token.
      const [confirmEmail] = await emails("cancellation_confirm");
      expect(confirmEmail).toMatchObject({ email: owner!.email, variables: { businessName: "Main", locale: "fr" } });
      expect(hash(String(confirmEmail!.token))).toBe(row!.tokenHash);
      expect(confirmEmail!.url).toBe(`https://app.example.test/cancel-account?token=${encodeURIComponent(String(confirmEmail!.token))}`);
      const [inboxEmail] = await emails("cancellation_request");
      expect(inboxEmail).toMatchObject({ to: "inbox@example.test", variables: { businessId: mainId, businessName: "Main", requesterName: "Ana Owner", requesterEmail: owner!.email, owners: `Ana Owner <${owner!.email}>`, teamSize: "3", phoneNumbers: number, appUrl: "https://app.example.test" } });
      expect(inboxEmail!.variables).toMatchObject({ plan: expect.stringContaining("paid through Polar") });
      expect((await tx.select({ eventType: auditLogs.eventType }).from(auditLogs).where(eq(auditLogs.businessId, mainId))).map((log) => log.eventType)).toContain("business.cancellation_requested");

      // Until the owner confirms, everything carries on.
      expect(await status()).toMatchObject({ status: "active", canceledAt: null });
      expect(await reach(ownerId)).toMatchObject({ member: true, services: 1 });
      expect(await jobs("billing.revokeSubscription")).toEqual([]);
      expect((await tx.select({ at: phoneNumbers.reclaimScheduledAt }).from(phoneNumbers).where(eq(phoneNumbers.businessId, mainId)))[0]!.at).toBeNull();
    });
  });

  it("falls back to FEEDBACK_TO_EMAIL, and still emails the owner when there's no inbox at all", async () => {
    await rollbackTest(async (tx) => {
      const { ownerId, request, emails } = await seed(tx);
      brand.contactEmail = null;
      vi.stubEnv("FEEDBACK_TO_EMAIL", "feedback@example.test");
      await request(ownerId);
      expect((await emails("cancellation_request")).map((email) => email.to)).toEqual(["feedback@example.test"]);

      vi.stubEnv("FEEDBACK_TO_EMAIL", "");
      await expect(request(ownerId)).resolves.toMatchObject({ inboxNotified: false });
      expect(await emails("cancellation_request")).toHaveLength(1);
      expect(await emails("cancellation_confirm")).toHaveLength(2);
    });
  });

  it("is refused while the owner owns another business, whichever they made first, and allowed once they're deleted", async () => {
    await rollbackTest(async (tx) => {
      const { db, business, join, ownerId, mainId, request, as, status } = await seed(tx);
      const studioId = await business("Studio", daysAgo(5));
      const shopId = await business("Shop", daysAgo(1));
      await join(studioId, ownerId, "business_owner", daysAgo(5));
      await join(shopId, ownerId, "business_owner", daysAgo(1));
      await expect(request(ownerId)).rejects.toMatchObject({ status: 403, code: "other_businesses" });
      // A later business isn't the root, so it can't be canceled either: it's deleted.
      await expect(request(ownerId, studioId, "Studio")).rejects.toMatchObject({ status: 403, code: "other_businesses" });
      // The newer one goes first here; the order doesn't matter.
      await as(() => deleteBusiness({ db }, { userId: ownerId, businessId: shopId, confirmName: "Shop" }));
      await expect(request(ownerId)).rejects.toMatchObject({ code: "other_businesses" });
      await as(() => deleteBusiness({ db }, { userId: ownerId, businessId: studioId, confirmName: "Studio" }));
      await expect(request(ownerId)).resolves.toMatchObject({ inboxNotified: true });
      expect(await status()).toMatchObject({ status: "active" });
    });
  });

  it("is refused to an admin, a viewer and someone off the team, and to a name that doesn't match", async () => {
    await rollbackTest(async (tx) => {
      const { person, ownerId, adminId, viewerId, request } = await seed(tx);
      const stranger = await person();
      for (const userId of [adminId, viewerId, stranger]) await expect(request(userId)).rejects.toMatchObject({ status: 403, code: "forbidden" });
      await expect(request(ownerId, undefined, "Mains")).rejects.toMatchObject({ status: 400, code: "confirmation_mismatch" });
      await expect(request(ownerId, undefined, "  Main  ")).resolves.toBeTruthy();
      expect(await tx.select().from(businessCancellationRequests)).toHaveLength(1);
    });
  });

  it("replaces the earlier link when asked again", async () => {
    await rollbackTest(async (tx) => {
      const { ownerId, mainId, request, latestToken, as, db } = await seed(tx);
      await request(ownerId);
      const first = await latestToken();
      await request(ownerId);
      const second = await latestToken();
      expect(second).not.toBe(first);
      expect((await tx.select({ status: businessCancellationRequests.status }).from(businessCancellationRequests).where(eq(businessCancellationRequests.businessId, mainId))).map((row) => row.status).sort()).toEqual(["pending", "replaced"]);
      expect(await as(() => previewBusinessCancellation({ db }, { tokenHash: hash(first) }))).toMatchObject({ businessName: "Main", state: "replaced" });
      expect(await as(() => previewBusinessCancellation({ db }, { tokenHash: hash(second) }))).toMatchObject({ businessName: "Main", state: "pending" });
      expect(await as(() => previewBusinessCancellation({ db }, { tokenHash: hash("never-sent") }))).toBeNull();
    });
  });
});

describe.skipIf(!client)("confirming a cancellation", () => {
  it("closes the business to its whole team at once, ends its plan and schedules its numbers' release, and deletes nothing", async () => {
    await rollbackTest(async (tx) => {
      const { db, ownerId, adminId, viewerId, mainId, number, request, latestToken, confirm, status, emails, jobs, reach, as } = await seed(tx);
      const servicesBefore = (await tx.select({ id: services.id }).from(services).where(eq(services.businessId, mainId))).length;
      await request(ownerId);
      const token = await latestToken();
      const canceled = await confirm(ownerId, token);

      expect(canceled).toMatchObject({ businessId: mainId, businessName: "Main", endsPlan: true });
      expect(await status()).toMatchObject({ status: "canceled", canceledBy: ownerId });
      expect((await status())!.canceledAt).toBeInstanceOf(Date);
      expect((await tx.select({ status: businessCancellationRequests.status, confirmedAt: businessCancellationRequests.confirmedAt }).from(businessCancellationRequests))[0]).toMatchObject({ status: "confirmed", confirmedAt: expect.any(Date) });

      // Nobody on the team reaches it, the owner included, and it leaves their workspace lists.
      for (const userId of [ownerId, adminId, viewerId]) expect(await reach(userId)).toEqual({ member: false, services: 0, workspaces: [] });
      // Whoever had it open has nothing to open, so the dashboard starts onboarding.
      for (const userId of [ownerId, adminId]) expect((await tx.select({ active: users.activeBusinessId }).from(users).where(eq(users.id, userId)))[0]!.active).toBeNull();
      expect(await as(() => getActiveOnboardingState(db, ownerId))).toEqual({ businessId: null, stage: "create_business" });

      // Nothing is deleted: the worker still sees every row.
      expect((await tx.select({ id: services.id }).from(services).where(eq(services.businessId, mainId))).length).toBe(servicesBefore);
      expect((await tx.select({ status: businessMemberships.status }).from(businessMemberships).where(eq(businessMemberships.businessId, mainId))).map((row) => row.status)).toEqual(["active", "active", "active"]);
      expect(await as(async () => (await withBusinessTransaction(db, { businessId: mainId, actorType: "worker" }, (inner) => inner.select({ id: services.id }).from(services).where(eq(services.businessId, mainId)))).length, "lobbystack_worker")).toBe(servicesBefore);

      // Its number answers nothing now and goes back to Twilio in 30 days.
      const [reclaim] = await tx.select({ at: phoneNumbers.reclaimScheduledAt, reason: phoneNumbers.reclaimReason, status: phoneNumbers.status }).from(phoneNumbers).where(eq(phoneNumbers.businessId, mainId));
      expect(reclaim).toMatchObject({ reason: "cancellation", status: "active" });
      expect(Math.abs(reclaim!.at!.getTime() - (Date.now() + 30 * 24 * 60 * 60_000))).toBeLessThan(60_000);
      expect(canceled.numbersReleasedOn?.getTime()).toBe(reclaim!.at!.getTime());
      const lookup = await as(async () => (await tx.execute<{ business_id: string | null; closed: boolean }>(sql`select app.resolve_business_by_phone(${number}) as business_id, app.is_closed_business_phone(${number}) as closed`)).rows[0]);
      expect(lookup).toEqual({ business_id: null, closed: true });
      expect((await as(async () => (await tx.execute<{ business_id: string | null }>(sql`select app.resolve_business_by_slug(${mainId}) as business_id`)).rows[0]))!.business_id).toBeNull();

      // The worker ends the plan; the inbox hears about it.
      expect(await jobs("billing.revokeSubscription")).toEqual([{ subscriptionId: `sub_${mainId}` }]);
      const [done] = await emails("cancellation_completed");
      expect(done).toMatchObject({ to: "inbox@example.test", variables: { businessId: mainId, businessName: "Main", planOutcome: "polar", phoneNumbers: number, numbersReleasedOn: reclaim!.at!.toISOString().slice(0, 10) } });
      expect((await tx.select({ eventType: auditLogs.eventType, actor: auditLogs.actorUserId }).from(auditLogs).where(and(eq(auditLogs.businessId, mainId), eq(auditLogs.eventType, "business.canceled"))))).toEqual([{ eventType: "business.canceled", actor: ownerId }]);
    });
  });

  it("lets the owner start again: a new business is their root, with a free plan, and the link reads as used", async () => {
    await rollbackTest(async (tx) => {
      const { db, ownerId, request, latestToken, confirm, as } = await seed(tx);
      await request(ownerId);
      const token = await latestToken();
      await confirm(ownerId, token);
      expect(await as(() => previewBusinessCancellation({ db }, { tokenHash: hash(token) }))).toMatchObject({ businessName: "Main", state: "canceled" });

      const created = await as(() => createBusiness({ db }, { userId: ownerId, name: "Main", timezone: "UTC", businessType: "test" }));
      const listed = await as(() => listUserBusinesses(db, ownerId));
      expect(listed).toEqual([expect.objectContaining({ businessId: created.businessId, name: "Main", isRoot: true, isAccountRoot: true })]);
      // The canceled business keeps its address, so the new one gets another.
      expect(listed[0]!.slug).not.toBe((await tx.select({ slug: businesses.slug }).from(businesses).where(eq(businesses.status, "canceled")))[0]?.slug);
      expect(await tx.select().from(billingAccounts).where(eq(billingAccounts.businessId, created.businessId))).toEqual([]);
    });
  });

  it("is refused to another account, and for a link that's expired, replaced, used or never sent", async () => {
    await rollbackTest(async (tx) => {
      const { ownerId, adminId, mainId, request, latestToken, confirm, status } = await seed(tx);
      await request(ownerId);
      const first = await latestToken();
      await expect(confirm(adminId, first)).rejects.toMatchObject({ status: 403, code: "wrong_account" });
      await expect(confirm(ownerId, "never-sent")).rejects.toMatchObject({ status: 404, code: "invalid_link" });
      await request(ownerId);
      const second = await latestToken();
      await expect(confirm(ownerId, first)).rejects.toMatchObject({ status: 410, code: "replaced" });
      await tx.update(businessCancellationRequests).set({ expiresAt: new Date(Date.now() - 1_000) }).where(eq(businessCancellationRequests.tokenHash, hash(second)));
      await expect(confirm(ownerId, second)).rejects.toMatchObject({ status: 410, code: "expired" });
      expect(await status()).toMatchObject({ status: "active" });

      await tx.update(businessCancellationRequests).set({ expiresAt: new Date(Date.now() + 60_000) }).where(eq(businessCancellationRequests.tokenHash, hash(second)));
      await confirm(ownerId, second);
      await expect(confirm(ownerId, second)).rejects.toMatchObject({ status: 409, code: "already_canceled" });
      expect((await tx.select({ id: businessCancellationRequests.id }).from(businessCancellationRequests).where(and(eq(businessCancellationRequests.businessId, mainId), eq(businessCancellationRequests.status, "confirmed"))))).toHaveLength(1);
    });
  });

  it("is refused while a call is in progress, and once the owner has another business again", async () => {
    await rollbackTest(async (tx) => {
      const { db, ownerId, mainId, request, latestToken, confirm, status, as } = await seed(tx);
      await request(ownerId);
      const token = await latestToken();
      const [call] = await tx.insert(calls).values({ businessId: mainId, providerCallId: randomUUID(), transport: "pstn", startedAt: new Date(Date.now() - 60_000) }).returning({ id: calls.id });
      await expect(confirm(ownerId, token)).rejects.toMatchObject({ status: 409, code: "call_in_progress" });
      await tx.update(calls).set({ endedAt: new Date() }).where(eq(calls.id, call!.id));

      await as(() => createBusiness({ db }, { userId: ownerId, name: "Second", timezone: "UTC", businessType: "test" }));
      await expect(confirm(ownerId, token)).rejects.toMatchObject({ status: 403, code: "other_businesses" });
      expect(await status()).toMatchObject({ status: "active" });
    });
  });

  it("leaves a number already set to go with its own date, and the shared sender with none", async () => {
    await rollbackTest(async (tx) => {
      const { ownerId, mainId, request, latestToken, confirm } = await seed(tx);
      const replaced = randomE164();
      const soon = new Date(Date.now() + 2 * 24 * 60 * 60_000);
      await tx.insert(phoneNumbers).values({ businessId: mainId, e164: replaced, providerPhoneId: `PN${randomUUID().replaceAll("-", "")}`, reclaimScheduledAt: soon, reclaimReason: "replacement" });
      // The shared sender texts for every business, so it never goes back with one.
      const shared = randomE164();
      vi.stubEnv("TWILIO_ALERT_SMS_FROM", shared);
      await tx.insert(phoneNumbers).values({ businessId: mainId, e164: shared, providerPhoneId: `PN${randomUUID().replaceAll("-", "")}` });
      await request(ownerId);
      await confirm(ownerId, await latestToken());
      const rows = await tx.select({ e164: phoneNumbers.e164, at: phoneNumbers.reclaimScheduledAt, reason: phoneNumbers.reclaimReason }).from(phoneNumbers).where(eq(phoneNumbers.businessId, mainId));
      expect(rows.find((row) => row.e164 === replaced)).toMatchObject({ at: soon, reason: "replacement" });
      expect(rows.find((row) => row.e164 === shared)).toMatchObject({ at: null, reason: null });
      expect(rows.filter((row) => row.reason === "cancellation")).toHaveLength(1);
    });
  });

  it("ends no plan on the free plan, and leaves one billed outside the app to the operator", async () => {
    await rollbackTest(async (tx) => {
      const { ownerId, mainId, request, latestToken, confirm, emails, jobs } = await seed(tx);
      await tx.update(billingAccounts).set({ source: "managed", plan: "enterprise", subscriptionId: null }).where(eq(billingAccounts.businessId, mainId));
      await request(ownerId);
      expect((await emails("cancellation_request"))[0]!.variables).toMatchObject({ plan: "enterprise plan, billed outside the app" });
      await expect(confirm(ownerId, await latestToken())).resolves.toMatchObject({ endsPlan: false });
      expect(await jobs("billing.revokeSubscription")).toEqual([]);
      expect((await emails("cancellation_completed"))[0]!.variables).toMatchObject({ planOutcome: "managed" });
    });
  });
});

describe.skipIf(!client)("the database's guards on canceling", () => {
  it("lets the dashboard's role cancel only through app.cancel_business, as the owner whose last business it is", async () => {
    await rollbackTest(async (tx) => {
      const { db, business, join, ownerId, adminId, mainId, as, status } = await seed(tx);
      const inContext = (userId: string, run: (inner: DatabaseTransaction) => Promise<unknown>) => as(() => withBusinessTransaction(db, { userId, businessId: mainId, actorType: "operator" }, run));
      const refusal = async (userId: string, run: (inner: DatabaseTransaction) => Promise<unknown>) => {
        try {
          await inContext(userId, (inner) => inner.transaction(run));
          return null;
        } catch (error) {
          return (error as { cause?: { constraint?: string } }).cause?.constraint ?? String(error);
        }
      };
      // Not by writing the row, even as its owner.
      expect(await refusal(ownerId, (inner) => inner.update(businesses).set({ status: "canceled" }).where(eq(businesses.id, mainId)))).toBe("businesses_status_change");
      expect(await refusal(ownerId, (inner) => inner.update(businesses).set({ canceledAt: new Date() }).where(eq(businesses.id, mainId)))).toBe("businesses_status_change");
      // Not by an admin.
      expect(await refusal(adminId, (inner) => inner.execute(sql`select app.cancel_business(${mainId}::uuid)`))).toBe("businesses_owner_cancel");
      // Not while the owner owns another business.
      const studioId = await business("Studio", daysAgo(2));
      await join(studioId, ownerId, "business_owner", daysAgo(2));
      expect(await refusal(ownerId, (inner) => inner.execute(sql`select app.cancel_business(${mainId}::uuid)`))).toBe("businesses_cancel_other_owned");
      await tx.delete(businessMemberships).where(and(eq(businessMemberships.businessId, studioId), eq(businessMemberships.userId, ownerId)));
      // Not for another business than the one the transaction is bound to.
      expect(await refusal(ownerId, (inner) => inner.execute(sql`select app.cancel_business(${studioId}::uuid)`))).toBe("businesses_owner_cancel");
      expect(await status()).toMatchObject({ status: "active" });
      expect(await refusal(ownerId, (inner) => inner.execute(sql`select app.cancel_business(${mainId}::uuid)`))).toBeNull();
      expect(await status()).toMatchObject({ status: "canceled", canceledBy: ownerId });
      expect(await refusal(ownerId, (inner) => inner.execute(sql`select app.cancel_business(${mainId}::uuid)`))).toBe("businesses_already_canceled");
    });
  });

  it("brings a canceled business back for an operator with app.reactivate_business, numbers and all", async () => {
    await rollbackTest(async (tx) => {
      const { ownerId, adminId, mainId, request, latestToken, confirm, status, reach } = await seed(tx);
      const replaced = randomE164();
      await tx.insert(phoneNumbers).values({ businessId: mainId, e164: replaced, providerPhoneId: `PN${randomUUID().replaceAll("-", "")}`, reclaimScheduledAt: new Date(Date.now() + 60_000), reclaimReason: "replacement" });
      await request(ownerId);
      await confirm(ownerId, await latestToken());
      await expect(tx.transaction((inner) => inner.execute(sql`select app.reactivate_business(${randomUUID()}::uuid)`))).rejects.toThrow();

      await tx.execute(sql`select app.reactivate_business(${mainId}::uuid)`);
      expect(await status()).toEqual({ status: "active", canceledAt: null, canceledBy: null });
      for (const userId of [ownerId, adminId]) expect(await reach(userId)).toMatchObject({ member: true, services: 1, workspaces: [mainId] });
      const numbers = await tx.select({ e164: phoneNumbers.e164, at: phoneNumbers.reclaimScheduledAt, reason: phoneNumbers.reclaimReason }).from(phoneNumbers).where(eq(phoneNumbers.businessId, mainId));
      // Only the cancellation's release is called off.
      expect(numbers.filter((number) => number.e164 !== replaced)).toEqual([expect.objectContaining({ at: null, reason: null })]);
      expect(numbers.find((number) => number.e164 === replaced)).toMatchObject({ reason: "replacement", at: expect.any(Date) });
      expect((await tx.select({ eventType: auditLogs.eventType }).from(auditLogs).where(eq(auditLogs.businessId, mainId))).map((log) => log.eventType)).toContain("business.reactivated");
      // The dashboard's role can't run it.
      await tx.execute(sql`set local role lobbystack_app`);
      await expect(tx.transaction((inner) => inner.execute(sql`select app.reactivate_business(${mainId}::uuid)`))).rejects.toMatchObject({ cause: { message: expect.stringMatching(/permission denied/) } });
      await tx.execute(sql`reset role`);
    });
  });

  it("turns away an invitation to a canceled business", async () => {
    await rollbackTest(async (tx) => {
      const { ownerId, mainId, request, latestToken, confirm, as } = await seed(tx);
      const tokenHash = hash(randomUUID());
      await tx.insert(businessInvitations).values({ businessId: mainId, invitedByUserId: ownerId, email: "new@example.invalid", normalizedEmail: "new@example.invalid", role: "viewer", tokenHash, expiresAt: new Date(Date.now() + 60_000) });
      const resolve = () => as(async () => (await tx.execute<{ business_id: string | null }>(sql`select app.resolve_business_by_invitation(${tokenHash}) as business_id`)).rows[0]!.business_id);
      expect(await resolve()).toBe(mainId);
      await request(ownerId);
      await confirm(ownerId, await latestToken());
      expect(await resolve()).toBeNull();
    });
  });

  it("marks a canceled business closed and never active for the worker's scheduler", async () => {
    await rollbackTest(async (tx) => {
      const { ownerId, mainId, request, latestToken, confirm } = await seed(tx);
      await tx.update(businesses).set({ onboardingStage: "complete" }).where(eq(businesses.id, mainId));
      const listed = async () => {
        await tx.execute(sql`set local session authorization lobbystack_dispatcher`);
        try {
          return (await listSchedulerBusinesses(tx as unknown as Database)).find((row) => row.id === mainId);
        } finally {
          await tx.execute(sql`reset session authorization`);
        }
      };
      expect(await listed()).toEqual({ id: mainId, active: true, closed: false });
      await request(ownerId);
      await confirm(ownerId, await latestToken());
      expect(await listed()).toEqual({ id: mainId, active: false, closed: true });
    });
  });
});
