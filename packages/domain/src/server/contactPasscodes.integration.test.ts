import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { afterAll, describe, expect, it } from "vitest";
import { appointmentChangeVerifications, appointments, auditLogs, businessHours, businessMemberships, businesses, contactPasscodes, contacts, createDatabaseClient, receptionistProfiles, services, staff, users, type Database, type DatabaseTransaction } from "@lobbystack/db";
import type { AppointmentChangeVerificationMode } from "@lobbystack/shared";

import { createAppointmentChangeVerification, issueAppointmentChangeOtp, verifyAppointmentChangePasscode } from "./appointmentChanges";
import { cancelAppointmentForCaller, rescheduleAppointmentForCaller } from "./booking";
import { removeContactPasscode, setContactPasscode } from "./contactPasscodes";
import { deleteContact, getContactDetail } from "./contacts";

// Explicit opt-in only; never fall back to DATABASE_URL or load an env file.
const testUrl = process.env.LOBBYSTACK_RELIABILITY_TEST_DATABASE_URL;
if (testUrl) {
  const url = new URL(testUrl);
  if (process.env.NODE_ENV === "production" || !["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname) || !/test/i.test(url.pathname)) {
    throw new Error("Contact passcode integration tests require a dedicated local test database.");
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

const timezone = "UTC";
const phone = "+14165550100";
const pin = "480613";
const tomorrow = DateTime.utc().plus({ days: 1 }).set({ hour: 15, minute: 0, second: 0, millisecond: 0 });

/**
 * A business open all day that lets callers cancel and reschedule from the
 * booking number with the given check, and Milan's cut tomorrow at 3 PM. The dashboard runs
 * as the app role and the call as the worker, both under RLS.
 */
async function seed(tx: DatabaseTransaction, verificationMode: AppointmentChangeVerificationMode = "passcode_required") {
  await tx.execute(sql`reset role`);
  const businessId = randomUUID();
  const userIds = { admin: randomUUID(), scheduler: randomUUID() };
  await tx.insert(businesses).values({ id: businessId, slug: businessId, name: "Javor", timezone, businessType: "test", telemetryEnabled: false });
  for (const [role, id] of [["business_admin", userIds.admin], ["scheduler", userIds.scheduler]] as const) {
    await tx.insert(users).values({ id, email: `${id}@example.invalid`, normalizedEmail: `${id}@example.invalid` });
    await tx.insert(businessMemberships).values({ businessId, userId: id, role });
  }
  await tx.insert(receptionistProfiles).values({ businessId, greeting: "Hi", tone: "warm", summary: "Test", bookingPolicy: "Book", transferMode: "never", bookingMode: "instant", appointmentChangePolicy: { enabled: true, verificationMode, allowCancel: true, allowReschedule: true } });
  const [member] = await tx.insert(staff).values({ businessId, name: "Sam", timezone }).returning();
  const [service] = await tx.insert(services).values({ businessId, name: "Cut", slug: "cut", durationMinutes: 30 }).returning();
  await tx.insert(businessHours).values(Array.from({ length: 7 }, (_, dayOfWeek) => ({ businessId, dayOfWeek, openMinutes: 0, closeMinutes: 1439 })));
  const [milan] = await tx.insert(contacts).values({ businessId, name: "Milan", phone, smsConsentStatus: "subscribed" }).returning();
  const [appointment] = await tx.insert(appointments).values({ businessId, contactId: milan!.id, staffId: member!.id, serviceId: service!.id, startsAt: tomorrow.toJSDate(), endsAt: tomorrow.plus({ minutes: 30 }).toJSDate(), timezone, status: "confirmed", sourceChannel: "voice" }).returning();
  const db = tx as unknown as Database;
  const as = async (role: "lobbystack_worker" | "lobbystack_app") => { await tx.execute(sql.raw(`set local role ${role}`)); };
  const asOwner = async () => { await tx.execute(sql`reset role`); };
  const contactId = milan!.id;
  const appointmentId = appointment!.id;
  return {
    businessId,
    contactId,
    appointmentId,
    userIds,
    setPin: async (passcode: string, userId = userIds.admin, forContact = contactId) => {
      await as("lobbystack_app");
      return await setContactPasscode({ db }, { userId, businessId, contactId: forContact, passcode });
    },
    removePin: async () => {
      await as("lobbystack_app");
      return await removeContactPasscode({ db }, { userId: userIds.admin, businessId, contactId });
    },
    detail: async () => {
      await as("lobbystack_app");
      return await getContactDetail({ db }, { userId: userIds.scheduler, businessId, contactId });
    },
    row: async (forContact = contactId) => {
      await asOwner();
      return (await tx.select().from(contactPasscodes).where(eq(contactPasscodes.contactId, forContact)))[0];
    },
    addContact: async (name: string, contactPhone: string) => {
      await asOwner();
      return (await tx.insert(contacts).values({ businessId, name, phone: contactPhone }).returning({ id: contacts.id }))[0]!.id;
    },
    lock: async () => {
      await asOwner();
      await tx.update(contactPasscodes).set({ lockedAt: new Date() }).where(eq(contactPasscodes.contactId, contactId));
    },
    audits: async (prefix: string) => {
      await asOwner();
      // Rows from one transaction share a timestamp, so sort them by name.
      return (await tx.select({ eventType: auditLogs.eventType }).from(auditLogs).where(and(eq(auditLogs.businessId, businessId), sql`${auditLogs.eventType} like ${`${prefix}%`}`))).map((row) => row.eventType).sort();
    },
    // What a phone call from the booking number runs, as the worker.
    verify: async (action: "cancel" | "reschedule" = "cancel") => {
      await as("lobbystack_worker");
      return await createAppointmentChangeVerification({ db }, { businessId, callerPhone: phone, action, serviceName: "Cut" });
    },
    type: async (verificationId: string, passcode: string) => {
      await as("lobbystack_worker");
      return await verifyAppointmentChangePasscode({ db }, { businessId, verificationId, passcode });
    },
    cancel: async (verificationId: string) => {
      await as("lobbystack_worker");
      return await cancelAppointmentForCaller({ db }, { businessId, appointmentId, callerPhone: phone, verificationId });
    },
    reschedule: async (verificationId: string) => {
      await as("lobbystack_worker");
      return await rescheduleAppointmentForCaller({ db }, { businessId, appointmentId, callerPhone: phone, verificationId, startsAt: tomorrow.plus({ days: 1 }).toISO()! });
    },
    verification: async (verificationId: string) => {
      await asOwner();
      return (await tx.select({ status: appointmentChangeVerifications.status, attemptCount: appointmentChangeVerifications.attemptCount }).from(appointmentChangeVerifications).where(eq(appointmentChangeVerifications.id, verificationId)))[0];
    },
    setMode: async (mode: AppointmentChangeVerificationMode) => {
      await asOwner();
      await tx.update(receptionistProfiles).set({ appointmentChangePolicy: { enabled: true, verificationMode: mode, allowCancel: true, allowReschedule: true } }).where(eq(receptionistProfiles.businessId, businessId));
    },
    expire: async (verificationId: string) => {
      await asOwner();
      await tx.update(appointmentChangeVerifications).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(appointmentChangeVerifications.id, verificationId));
    },
    appointmentStatus: async () => {
      await asOwner();
      return (await tx.select({ status: appointments.status }).from(appointments).where(eq(appointments.id, appointmentId)))[0]?.status;
    },
    deleteContact: async (forContact: string) => {
      await as("lobbystack_app");
      return await deleteContact({ db }, { userId: userIds.admin, businessId, contactId: forContact });
    },
  };
}

describe.skipIf(!client)("a contact's keypad PIN", () => {
  it("lets an admin set, replace and remove it, keeping only a hash", async () => {
    await rollbackTest(async (tx) => {
      const { setPin, removePin, detail, row, audits } = await seed(tx);
      expect((await detail()).passcode).toBeNull();

      const first = await setPin(pin);
      expect(first).toMatchObject({ locked: false });
      const stored = await row();
      expect(stored!.passcodeHash).toMatch(/^scrypt-v1:[0-9a-f]{32}:[0-9a-f]{128}$/);
      expect(stored!.passcodeHash).not.toContain(pin);
      expect((await detail()).passcode).toEqual({ setAt: first!.setAt, locked: false });
      expect(JSON.stringify(await detail())).not.toContain(stored!.passcodeHash);

      await setPin("935172");
      expect((await row())!.passcodeHash).not.toBe(stored!.passcodeHash);

      expect(await removePin()).toBe(true);
      expect((await detail()).passcode).toBeNull();
      expect(await removePin()).toBe(true);
      expect(await audits("contact.passcode")).toEqual(["contact.passcode_removed", "contact.passcode_set", "contact.passcode_set"]);
    });
  });

  it("keeps two contacts with the same PIN apart", async () => {
    await rollbackTest(async (tx) => {
      const { setPin, row, addContact } = await seed(tx);
      const ana = await addContact("Ana", "+14165550101");
      await setPin(pin);
      await setPin(pin, undefined, ana);
      expect((await row(ana))!.passcodeHash).not.toBe((await row())!.passcodeHash);
    });
  });

  it("can't be set by a scheduler, on another business's contact, or to a guessable PIN", async () => {
    await rollbackTest(async (tx) => {
      const { userIds, setPin, row } = await seed(tx);
      await expect(setPin(pin, userIds.scheduler)).rejects.toMatchObject({ status: 403 });
      const other = await seed(tx);
      expect(await setPin(pin, undefined, other.contactId)).toBeNull();
      await expect(setPin("1234")).rejects.toMatchObject({ status: 400, code: "guessable_passcode" });
      await expect(setPin("12")).rejects.toMatchObject({ status: 400, code: "invalid_passcode" });
      expect(await row()).toBeUndefined();
    });
  });

  it("goes with its contact", async () => {
    await rollbackTest(async (tx) => {
      const { setPin, deleteContact: remove, row, addContact } = await seed(tx);
      const ana = await addContact("Ana", "+14165550101");
      await setPin(pin, undefined, ana);
      expect(await remove(ana)).toBe(true);
      expect(await row(ana)).toBeUndefined();
    });
  });
});

describe.skipIf(!client)("appointment changes that need the keypad PIN", () => {
  it("waits for the PIN, then lets the change through once", async () => {
    await rollbackTest(async (tx) => {
      const { setPin, verify, type, cancel, appointmentStatus, audits } = await seed(tx);
      await setPin(pin);
      const pending = await verify();
      expect(pending).toMatchObject({ status: "passcode_pending" });
      expect(await cancel(pending!.verificationId)).toBeNull();

      expect(await type(pending!.verificationId, pin)).toMatchObject({ ok: true, status: "passcode_verified", action: "cancel", smsConsent: "subscribed" });
      expect(await cancel(pending!.verificationId)).toMatchObject({ smsConsentOnFile: "subscribed" });
      expect(await appointmentStatus()).toBe("canceled");
      expect(await type(pending!.verificationId, pin)).toMatchObject({ ok: false, status: "expired" });
      expect(await audits("appointment_change.passcode")).toEqual(["appointment_change.passcode_verified"]);
    });
  });

  it("sends a caller without a PIN, or with a locked one, to the team", async () => {
    await rollbackTest(async (tx) => {
      const { setPin, removePin, verify, type, lock, audits } = await seed(tx);
      expect(await verify()).toMatchObject({ status: "passcode_missing" });

      await setPin(pin);
      const pending = (await verify())!;
      await lock();
      // Asked for before the lock, and refused without comparing the PIN.
      expect(await type(pending.verificationId, pin)).toMatchObject({ ok: false, status: "passcode_locked" });
      expect(await verify()).toMatchObject({ status: "passcode_locked" });

      await setPin(pin);
      const again = (await verify())!;
      await removePin();
      expect(await type(again.verificationId, pin)).toMatchObject({ ok: false, status: "passcode_missing" });
      expect(await audits("appointment_change.passcode")).toEqual(["appointment_change.passcode_locked", "appointment_change.passcode_missing"]);
    });
  });

  it("allows three tries per change and locks the PIN after five wrong ones in a row", async () => {
    await rollbackTest(async (tx) => {
      const { setPin, verify, type, row, detail, audits } = await seed(tx);
      await setPin(pin);
      const first = (await verify())!;
      expect(await type(first.verificationId, "111222")).toMatchObject({ ok: false, status: "passcode_pending", attemptsLeft: 2 });
      expect(await type(first.verificationId, "111222")).toMatchObject({ ok: false, status: "passcode_pending", attemptsLeft: 1 });
      expect(await type(first.verificationId, "111222")).toMatchObject({ ok: false, status: "failed", attemptsLeft: 0 });
      expect(await type(first.verificationId, pin)).toMatchObject({ ok: false, status: "failed" });

      const second = (await verify())!;
      expect(await type(second.verificationId, "111222")).toMatchObject({ ok: false, status: "passcode_pending", attemptsLeft: 2 });
      expect(await type(second.verificationId, "111222")).toMatchObject({ ok: false, status: "passcode_locked" });
      expect((await row())!.failedAttempts).toBe(5);
      expect((await detail()).passcode).toMatchObject({ locked: true });
      expect(await verify()).toMatchObject({ status: "passcode_locked" });
      expect(await audits("appointment_change.passcode_locked")).toEqual(["appointment_change.passcode_locked"]);

      // A new PIN clears the lock.
      await setPin("935172");
      expect((await detail()).passcode).toMatchObject({ locked: false });
      const third = (await verify())!;
      expect(await type(third.verificationId, "935172")).toMatchObject({ ok: true, status: "passcode_verified" });
    });
  });

  it("forgets earlier wrong PINs once the right one is typed", async () => {
    await rollbackTest(async (tx) => {
      const { setPin, verify, type, row } = await seed(tx);
      await setPin(pin);
      const pending = (await verify())!;
      await type(pending.verificationId, "111222");
      await type(pending.verificationId, "111222");
      expect((await row())!.failedAttempts).toBe(2);
      expect(await type(pending.verificationId, pin)).toMatchObject({ ok: true });
      expect((await row())!.failedAttempts).toBe(0);
    });
  });

  it("counts an accepted PIN for the same appointment instead of asking again", async () => {
    await rollbackTest(async (tx) => {
      const { setPin, verify, type, reschedule, verification } = await seed(tx);
      await setPin(pin);
      const pending = (await verify())!;
      await type(pending.verificationId, pin);
      // The agent verifies again before cancelling: the accepted PIN still counts.
      expect(await verify()).toMatchObject({ verificationId: pending.verificationId, status: "passcode_verified" });

      // The caller would rather move it: no second PIN.
      const moving = (await verify("reschedule"))!;
      expect(moving).toMatchObject({ status: "passcode_verified" });
      expect(moving.verificationId).not.toBe(pending.verificationId);
      expect(moving.expiresAt).toBe((await verify("reschedule"))!.expiresAt);
      expect(await verification(pending.verificationId)).toMatchObject({ status: "superseded" });
      expect(await reschedule(moving.verificationId)).not.toBeNull();
    });
  });

  it("expires with the verification", async () => {
    await rollbackTest(async (tx) => {
      const { setPin, verify, type, expire, row } = await seed(tx);
      await setPin(pin);
      const pending = (await verify())!;
      await expire(pending.verificationId);
      expect(await type(pending.verificationId, "111222")).toMatchObject({ ok: false, status: "expired" });
      expect((await row())!.failedAttempts).toBe(0);
    });
  });

  it("never takes a texted code instead", async () => {
    await rollbackTest(async (tx) => {
      const { businessId, setPin, verify } = await seed(tx);
      await setPin(pin);
      const pending = (await verify())!;
      await tx.execute(sql.raw("set local role lobbystack_worker"));
      expect(await issueAppointmentChangeOtp({ db: tx as unknown as Database }, { businessId, verificationId: pending.verificationId })).toMatchObject({ ok: false, status: "passcode_pending" });
    });
  });

  it("refuses a change verified the looser way once the business requires a PIN", async () => {
    await rollbackTest(async (tx) => {
      const { verify, cancel, setMode, appointmentStatus } = await seed(tx, "phone_match_and_facts");
      const facts = (await verify())!;
      expect(facts.status).toBe("facts_verified");
      await setMode("passcode_required");
      expect(await cancel(facts.verificationId)).toBeNull();
      expect(await appointmentStatus()).toBe("confirmed");
    });
  });

  it("lets a change verified by PIN through after the business relaxes the check", async () => {
    await rollbackTest(async (tx) => {
      const { setPin, verify, type, cancel, setMode, appointmentStatus } = await seed(tx);
      await setPin(pin);
      const pending = (await verify())!;
      await type(pending.verificationId, pin);
      await setMode("phone_match_and_facts");
      expect(await cancel(pending.verificationId)).not.toBeNull();
      expect(await appointmentStatus()).toBe("canceled");
    });
  });
});
