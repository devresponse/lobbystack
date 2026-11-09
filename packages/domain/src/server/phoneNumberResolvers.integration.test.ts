import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { businesses, createDatabaseClient, phoneNumbers, receptionistProfiles, type DatabaseTransaction } from "@lobbystack/db";

// The lookups an incoming call or text makes before it knows the business
// (app.resolve_business_by_phone, app.resolve_receptionist_by_phone and
// app.is_closed_business_phone), for numbers on their way back to Twilio. A
// number whose business's last prepaid pack ended stops answering at once
// (migration 0148); one set to go for any other reason answers as before.

// Explicit opt-in only; never fall back to DATABASE_URL or load an env file.
const testUrl = process.env.LOBBYSTACK_RELIABILITY_TEST_DATABASE_URL;
if (testUrl) {
  const url = new URL(testUrl);
  if (process.env.NODE_ENV === "production" || !["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname) || !/test/i.test(url.pathname)) {
    throw new Error("Phone number lookup integration tests require a dedicated local test database.");
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

const DAY = 86_400_000;
const phone = () => `+1604${Math.floor(Math.random() * 1e7).toString().padStart(7, "0")}`;

async function business(tx: DatabaseTransaction, status: "active" | "canceled" = "active"): Promise<string> {
  const id = randomUUID();
  await tx.insert(businesses).values({ id, slug: id, name: "Phone lookup test", timezone: "UTC", businessType: "test", telemetryEnabled: false, status, canceledAt: status === "canceled" ? new Date() : null });
  return id;
}

/** One of the business's numbers, set to go back to Twilio in 30 days for `reason` when it has one. */
async function number(tx: DatabaseTransaction, businessId: string, input: { reason?: string | null; status?: string } = {}): Promise<string> {
  const e164 = phone();
  await tx.insert(phoneNumbers).values({ businessId, e164, status: input.status ?? "active", reclaimScheduledAt: input.reason ? new Date(Date.now() + 30 * DAY) : null, reclaimReason: input.reason ?? null });
  return e164;
}

/** The business's default receptionist, which a trigger gave it. */
async function defaultReceptionist(tx: DatabaseTransaction, businessId: string): Promise<string> {
  const [row] = await tx.select({ id: receptionistProfiles.id }).from(receptionistProfiles).where(and(eq(receptionistProfiles.businessId, businessId), eq(receptionistProfiles.isDefault, true)));
  return row!.id;
}

/** What the incoming call webhook reads for a dialled number, as the dashboard's role. */
async function lookup(tx: DatabaseTransaction, e164: string) {
  await tx.execute(sql`set local role lobbystack_app`);
  const [row] = (await tx.execute<{ business_id: string | null; receptionist_id: string | null; closed: boolean }>(sql`select app.resolve_business_by_phone(${e164}) as business_id, app.resolve_receptionist_by_phone(${e164}) as receptionist_id, app.is_closed_business_phone(${e164}) as closed`)).rows;
  await tx.execute(sql`reset role`);
  return row!;
}

describe.skipIf(!testUrl)("phone number lookups against PostgreSQL", () => {
  it("find no business or receptionist for a number whose business's last pack ended, and read it as closed so the call is turned away", async () => {
    await rollbackTest(async (tx) => {
      const businessId = await business(tx);
      const ended = await number(tx, businessId, { reason: "pack_ended" });
      expect(await lookup(tx, ended)).toEqual({ business_id: null, receptionist_id: null, closed: true });
      // Once a new pack or a plan takes the release back, it answers again.
      await tx.update(phoneNumbers).set({ reclaimScheduledAt: null, reclaimReason: null }).where(eq(phoneNumbers.e164, ended));
      expect(await lookup(tx, ended)).toEqual({ business_id: businessId, receptionist_id: await defaultReceptionist(tx, businessId), closed: false });
    });
  });

  it("answer as before for a number set to go for another reason, or not set to go at all", async () => {
    await rollbackTest(async (tx) => {
      const businessId = await business(tx);
      const receptionistId = await defaultReceptionist(tx, businessId);
      for (const reason of [null, "replacement", "cancellation"]) {
        expect(await lookup(tx, await number(tx, businessId, { reason }))).toEqual({ business_id: businessId, receptionist_id: receptionistId, closed: false });
      }
      // A canceled business's numbers answer nothing and read as closed, as 0130 made them.
      const canceled = await business(tx, "canceled");
      expect(await lookup(tx, await number(tx, canceled, { reason: "cancellation" }))).toEqual({ business_id: null, receptionist_id: null, closed: true });
      // A number already back with Twilio is nobody's, whatever its reason was, and so is an unknown one.
      expect(await lookup(tx, await number(tx, businessId, { reason: "pack_ended", status: "reclaimed" }))).toEqual({ business_id: null, receptionist_id: null, closed: false });
      expect(await lookup(tx, phone())).toEqual({ business_id: null, receptionist_id: null, closed: false });
    });
  });
});
