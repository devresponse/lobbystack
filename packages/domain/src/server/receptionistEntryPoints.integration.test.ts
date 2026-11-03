import { createHash, randomInt, randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  auditLogs,
  billingAccounts,
  createDatabaseClient,
  outboxMessages,
  phoneNumbers,
  receptionistProfiles,
  rlsContextStatement,
  users,
  widgetKeys,
  type Database,
  type DatabaseTransaction,
} from "@lobbystack/db";

import { readEntryPointReceptionist, requireAssignableReceptionistInTransaction, setPhoneNumberReceptionistInTransaction, setWidgetKeyReceptionistInTransaction } from "./receptionistEntryPoints";
import { archiveReceptionistInTransaction, createReceptionistInTransaction, setReceptionistStatusInTransaction } from "./receptionists";
import { createBusiness } from "./tenancy";

// Explicit opt-in only; never fall back to DATABASE_URL or load an env file.
const testUrl = process.env.LOBBYSTACK_RELIABILITY_TEST_DATABASE_URL;
if (testUrl) {
  const url = new URL(testUrl);
  if (process.env.NODE_ENV === "production" || !["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname) || !/test/i.test(url.pathname)) {
    throw new Error("Entry point integration tests require a dedicated local test database.");
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

async function as(tx: DatabaseTransaction, role: "lobbystack_app" | null) {
  await tx.execute(sql`reset role`);
  if (role) await tx.execute(sql.raw(`set local role ${role}`));
}

/** Runs a step that should fail in a savepoint, so the transaction goes on after it. */
async function failure(tx: DatabaseTransaction, run: (inner: DatabaseTransaction) => Promise<unknown>): Promise<unknown> {
  return await tx.transaction(async (inner) => { await run(inner); }).then(() => null, (error: unknown) => error);
}

/**
 * A Pro clinic with its front desk, the default receptionist, and one for its
 * Kitsilano location; a number and a widget key, which name the front desk.
 */
async function seedClinic(tx: DatabaseTransaction, name = "Kitsilano Physio") {
  const userId = randomUUID();
  await tx.insert(users).values({ id: userId, email: `${userId}@example.invalid`, normalizedEmail: `${userId}@example.invalid`, name: "Sam Owner" });
  await as(tx, "lobbystack_app");
  const { businessId } = await createBusiness({ db: tx as unknown as Database }, { userId, name, timezone: "America/Vancouver", businessType: "clinic", deploymentMode: "cloud" });
  await as(tx, null);
  await tx.insert(billingAccounts).values({ businessId, billingKey: `business:${businessId}`, plan: "pro", subscriptionState: "active", source: "polar" });
  const [frontDesk] = await tx.select({ id: receptionistProfiles.id }).from(receptionistProfiles).where(and(eq(receptionistProfiles.businessId, businessId), eq(receptionistProfiles.isDefault, true)));
  const clinic = { userId, businessId, frontDeskId: frontDesk!.id };
  const kitsilano = await owner(tx, clinic, () => createReceptionistInTransaction(tx, { businessId, actorUserId: userId, receptionist: { name: "Kitsilano clinic", handle: "kitsilano" } }));
  const [number] = await tx.insert(phoneNumbers).values({ businessId, e164: `+1604${randomInt(1_000_000, 9_999_999)}`, providerPhoneId: `PN${randomUUID().replaceAll("-", "")}` }).returning({ id: phoneNumbers.id, e164: phoneNumbers.e164, receptionistId: phoneNumbers.receptionistId });
  const keyValue = `wk_test_${randomUUID().replaceAll("-", "")}`;
  const [widget] = await tx.insert(widgetKeys).values({ businessId, keyHash: createHash("sha256").update(keyValue).digest("hex"), keyValue, status: "active" }).returning({ id: widgetKeys.id, receptionistId: widgetKeys.receptionistId });
  return { ...clinic, kitsilanoId: kitsilano.id, number: number!, widget: widget! };
}

type Clinic = { userId: string; businessId: string };

/** Runs a dashboard step as the clinic's owner, under its row level security, then hands the connection back to the migrator. */
async function owner<T>(tx: DatabaseTransaction, clinic: Clinic, run: () => Promise<T>): Promise<T> {
  await as(tx, "lobbystack_app");
  await tx.execute(rlsContextStatement({ userId: clinic.userId, businessId: clinic.businessId, actorType: "operator" }));
  try {
    return await run();
  } finally {
    await as(tx, null);
  }
}

async function audits(tx: DatabaseTransaction, businessId: string, eventType: string) {
  return await tx.select({ actorUserId: auditLogs.actorUserId, entityType: auditLogs.entityType, entityId: auditLogs.entityId, payload: auditLogs.payload }).from(auditLogs)
    .where(and(eq(auditLogs.businessId, businessId), eq(auditLogs.eventType, eventType)))
    .orderBy(auditLogs.createdAt);
}

describe("a receptionist id in a request", () => {
  it("is read in lower case", () => {
    expect(readEntryPointReceptionist("00000000-0000-4000-8000-0000000000A2")).toBe("00000000-0000-4000-8000-0000000000a2");
  });

  it.each([undefined, null, "", "kitsilano", 42, ["00000000-0000-4000-8000-0000000000a2"]])("is refused as %j", (value) => {
    expect(() => readEntryPointReceptionist(value)).toThrow(expect.objectContaining({ status: 400, code: "invalid_receptionist" }));
  });
});

describe.skipIf(!testUrl)("who answers each number and widget, against PostgreSQL under RLS", () => {
  it("starts as the default receptionist for a new number and widget key", async () => {
    await rollbackTest(async (tx) => {
      const clinic = await seedClinic(tx);
      expect(clinic.number.receptionistId).toBe(clinic.frontDeskId);
      expect(clinic.widget.receptionistId).toBe(clinic.frontDeskId);
    });
  });

  it("moves a number to another receptionist, recording who did and from whom", async () => {
    await rollbackTest(async (tx) => {
      const clinic = await seedClinic(tx);
      const moved = await owner(tx, clinic, () => setPhoneNumberReceptionistInTransaction(tx, { businessId: clinic.businessId, actorUserId: clinic.userId, phoneNumberId: clinic.number.id, receptionistId: clinic.kitsilanoId }));
      expect(moved).toEqual({ id: clinic.number.id, e164: clinic.number.e164, receptionistId: clinic.kitsilanoId });
      const [stored] = await tx.select({ receptionistId: phoneNumbers.receptionistId }).from(phoneNumbers).where(eq(phoneNumbers.id, clinic.number.id));
      expect(stored!.receptionistId).toBe(clinic.kitsilanoId);
      // Choosing the receptionist it already has changes nothing and records nothing.
      await owner(tx, clinic, () => setPhoneNumberReceptionistInTransaction(tx, { businessId: clinic.businessId, actorUserId: clinic.userId, phoneNumberId: clinic.number.id, receptionistId: clinic.kitsilanoId }));
      expect(await audits(tx, clinic.businessId, "phone_number.receptionist_changed")).toEqual([
        { actorUserId: clinic.userId, entityType: "phone_number", entityId: clinic.number.id, payload: { from: clinic.frontDeskId, to: clinic.kitsilanoId } },
      ]);
      // One snapshot refresh, after which the worker records the new receptionist's opening for the number's calls.
      const refreshes = await tx.select({ aggregateId: outboxMessages.aggregateId, payload: outboxMessages.payload }).from(outboxMessages)
        .where(and(eq(outboxMessages.businessId, clinic.businessId), eq(outboxMessages.topic, "snapshot.refresh"), eq(outboxMessages.aggregateType, "phone_number")));
      expect(refreshes).toEqual([{ aggregateId: clinic.number.id, payload: { businessId: clinic.businessId, reason: "phone_number_receptionist_changed" } }]);
    });
  });

  it("moves a widget key to another receptionist, recording who did and from whom", async () => {
    await rollbackTest(async (tx) => {
      const clinic = await seedClinic(tx);
      const moved = await owner(tx, clinic, () => setWidgetKeyReceptionistInTransaction(tx, { businessId: clinic.businessId, actorUserId: clinic.userId, widgetKeyId: clinic.widget.id, receptionistId: clinic.kitsilanoId.toUpperCase() }));
      expect(moved).toEqual({ id: clinic.widget.id, receptionistId: clinic.kitsilanoId });
      await owner(tx, clinic, () => setWidgetKeyReceptionistInTransaction(tx, { businessId: clinic.businessId, actorUserId: null, widgetKeyId: clinic.widget.id, receptionistId: clinic.frontDeskId }));
      expect(await audits(tx, clinic.businessId, "widget_key.receptionist_changed")).toEqual([
        { actorUserId: clinic.userId, entityType: "widget_key", entityId: clinic.widget.id, payload: { from: clinic.frontDeskId, to: clinic.kitsilanoId } },
        { actorUserId: null, entityType: "widget_key", entityId: clinic.widget.id, payload: { from: clinic.kitsilanoId, to: clinic.frontDeskId } },
      ]);
    });
  });

  it("lets a paused receptionist be chosen, since the default answers for it until it resumes, but not an archived one", async () => {
    await rollbackTest(async (tx) => {
      const clinic = await seedClinic(tx);
      const actor = { businessId: clinic.businessId, actorUserId: clinic.userId, receptionistId: clinic.kitsilanoId };
      await owner(tx, clinic, () => setReceptionistStatusInTransaction(tx, { ...actor, status: "paused" }));
      expect(await owner(tx, clinic, () => requireAssignableReceptionistInTransaction(tx, { businessId: clinic.businessId, receptionistId: clinic.kitsilanoId })))
        .toEqual({ id: clinic.kitsilanoId, name: "Kitsilano clinic", status: "paused", isDefault: false });
      expect(await owner(tx, clinic, () => setPhoneNumberReceptionistInTransaction(tx, { businessId: clinic.businessId, actorUserId: clinic.userId, phoneNumberId: clinic.number.id, receptionistId: clinic.kitsilanoId }))).toMatchObject({ receptionistId: clinic.kitsilanoId });
      await owner(tx, clinic, () => archiveReceptionistInTransaction(tx, actor));
      expect(await owner(tx, clinic, () => failure(tx, (inner) => setWidgetKeyReceptionistInTransaction(inner, { businessId: clinic.businessId, actorUserId: clinic.userId, widgetKeyId: clinic.widget.id, receptionistId: clinic.kitsilanoId }))))
        .toMatchObject({ status: 409, code: "receptionist_archived" });
      expect(await owner(tx, clinic, () => failure(tx, (inner) => setPhoneNumberReceptionistInTransaction(inner, { businessId: clinic.businessId, actorUserId: clinic.userId, phoneNumberId: clinic.number.id, receptionistId: clinic.kitsilanoId }))))
        .toMatchObject({ status: 409, code: "receptionist_archived" });
    });
  });

  it("finds no receptionist, number or widget key of another business, or a number already given back", async () => {
    await rollbackTest(async (tx) => {
      const clinic = await seedClinic(tx);
      const other = await seedClinic(tx, "Other Physio");
      const setNumber = (phoneNumberId: string, receptionistId: string) => owner(tx, clinic, () => failure(tx, (inner) => setPhoneNumberReceptionistInTransaction(inner, { businessId: clinic.businessId, actorUserId: clinic.userId, phoneNumberId, receptionistId })));
      const setWidget = (widgetKeyId: string, receptionistId: string) => owner(tx, clinic, () => failure(tx, (inner) => setWidgetKeyReceptionistInTransaction(inner, { businessId: clinic.businessId, actorUserId: clinic.userId, widgetKeyId, receptionistId })));
      expect(await setNumber(clinic.number.id, other.kitsilanoId)).toMatchObject({ status: 404, code: "receptionist_not_found" });
      expect(await setNumber(clinic.number.id, "kitsilano")).toMatchObject({ status: 404, code: "receptionist_not_found" });
      expect(await setNumber(other.number.id, clinic.kitsilanoId)).toMatchObject({ status: 404, code: "phone_number_not_found" });
      expect(await setNumber("not-a-number", clinic.kitsilanoId)).toMatchObject({ status: 404, code: "phone_number_not_found" });
      expect(await setWidget(other.widget.id, clinic.kitsilanoId)).toMatchObject({ status: 404, code: "widget_key_not_found" });
      expect(await setWidget(randomUUID(), clinic.kitsilanoId)).toMatchObject({ status: 404, code: "widget_key_not_found" });
      await tx.update(phoneNumbers).set({ status: "reclaimed" }).where(eq(phoneNumbers.id, clinic.number.id));
      expect(await setNumber(clinic.number.id, clinic.kitsilanoId)).toMatchObject({ status: 404, code: "phone_number_not_found" });
      // Nothing of the other business moved.
      const [otherNumber] = await tx.select({ receptionistId: phoneNumbers.receptionistId }).from(phoneNumbers).where(eq(phoneNumbers.id, other.number.id));
      expect(otherNumber!.receptionistId).toBe(other.frontDeskId);
    });
  });
});
