import { beforeEach, describe, expect, it, vi } from "vitest";

import { auditLogs, businesses, receptionistProfiles, staff } from "@lobbystack/db";

const mocks = vi.hoisted(() => ({ enqueueOutbox: vi.fn(), tx: undefined as unknown }));
vi.mock("@lobbystack/db", async (original) => ({ ...(await original<typeof import("@lobbystack/db")>()), enqueueOutbox: mocks.enqueueOutbox, withBusinessTransaction: async (_db: unknown, _context: unknown, callback: (tx: unknown) => unknown) => await callback(mocks.tx) }));
vi.mock("../authz", async (original) => ({ ...(await original<typeof import("../authz")>()), requireBusinessAdmin: vi.fn() }));

import { createBusiness, ianaTimeZone, inviteMember, updateBusiness, updateBusinessInTransaction } from "./tenancy";

beforeEach(() => { vi.clearAllMocks(); });

it.each(["", " ", "!!!", "a", "a".repeat(121)])("rejects invalid normalized explicit slug %j as a client error", async slug => {
  await expect(createBusiness({ db: undefined as never }, { userId: "unused", name: "Test", slug, timezone: "UTC", businessType: "test" })).rejects.toMatchObject({ status: 400 });
});

it.each(["a@x.com, b@y.com", "a@x.com;b@y.com", "Ann <a@x.com>", "g:a@x.com", "a@x", "not-an-email"])("rejects invite email %j that is not exactly one address", async email => {
  await expect(inviteMember({ db: undefined as never }, { userId: "unused", businessId: "unused", email, role: "viewer" })).rejects.toMatchObject({ status: 400 });
});

describe("business timezone", () => {
  // The business is in English until the change; its default receptionist's row is "front-desk".
  function useTransaction() {
    const updates: Array<{ table: unknown; values: Record<string, unknown> }> = [];
    const inserts: Array<{ table: unknown; values: unknown }> = [];
    mocks.tx = {
      select: () => ({ from: () => ({ where: () => ({ limit: () => ({ for: async () => [{ defaultLocale: "en" }] }) }) }) }),
      update: (table: unknown) => ({ set: (values: Record<string, unknown>) => { updates.push({ table, values }); return { where: () => ({ returning: async () => [{ id: table === receptionistProfiles ? "front-desk" : "biz-1" }] }) }; } }),
      insert: (table: unknown) => ({ values: async (values: unknown) => { inserts.push({ table, values }); } }),
    };
    return { updates, inserts, tx: mocks.tx as never };
  }

  it.each(["America/Vancouver", "Asia/Kolkata", "America/Argentina/Buenos_Aires", "America/Port-au-Prince", "UTC"])("accepts the IANA zone %s", zone => {
    expect(ianaTimeZone(zone)).toBe(zone);
  });

  it.each([[" UTC ", "UTC"], ["europe/london", "Europe/London"]])("names %j by its canonical zone", (zone, canonical) => {
    expect(ianaTimeZone(zone)).toBe(canonical);
  });

  it.each(["", "Mars/Olympus_Mons", "Etc/Unknown", "+05:00", "GMT+5:30", "America/Vancouver; drop", "x".repeat(81), 5, null])("rejects %j", zone => {
    expect(ianaTimeZone(zone)).toBeUndefined();
  });

  it("refuses to create a business in a zone that isn't an IANA zone", async () => {
    await expect(createBusiness({ db: undefined as never }, { userId: "unused", name: "Test", timezone: "Eastern", businessType: "test" })).rejects.toMatchObject({ status: 400, code: "invalid_timezone" });
  });

  it("saves the canonical zone for the business and its default staff member, and refreshes the snapshot", async () => {
    const { tx, updates } = useTransaction();
    await updateBusinessInTransaction(tx, { businessId: "biz-1", timezone: " europe/belgrade " });
    expect(updates).toEqual([
      { table: businesses, values: expect.objectContaining({ timezone: "Europe/Belgrade" }) },
      { table: staff, values: expect.objectContaining({ timezone: "Europe/Belgrade" }) },
    ]);
    expect(mocks.enqueueOutbox).toHaveBeenCalledWith(tx, expect.objectContaining({ topic: "snapshot.refresh", businessId: "biz-1" }));
  });

  it.each(["Eastern", 5])("refuses the zone %j without saving anything", async (zone) => {
    const { tx, updates } = useTransaction();
    await expect(updateBusinessInTransaction(tx, { businessId: "biz-1", timezone: zone as string })).rejects.toMatchObject({ status: 400, code: "invalid_timezone" });
    expect(updates).toEqual([]);
    expect(mocks.enqueueOutbox).not.toHaveBeenCalled();
  });

  it("saves any language calls can open in, and refuses one they can't without saving anything", async () => {
    const saved = useTransaction();
    await updateBusinessInTransaction(saved.tx, { businessId: "biz-1", defaultLocale: " ko ", audit: { actorUserId: "owner" } });
    // The default receptionist takes the language's "Front desk" while it has English's, which the code gave it, and the audit log says so.
    expect(saved.updates).toEqual([
      { table: businesses, values: expect.objectContaining({ defaultLocale: "ko" }) },
      { table: receptionistProfiles, values: { name: "안내 데스크", updatedAt: expect.any(Date) } },
    ]);
    expect(saved.inserts).toEqual([{ table: auditLogs, values: [{ businessId: "biz-1", actorUserId: "owner", eventType: "receptionist.updated", entityType: "receptionist", entityId: "front-desk", payload: { fields: ["name"], from: "Front desk", to: "안내 데스크", reason: "business_language" } }] }]);

    for (const locale of ["sr", "english", 5]) {
      vi.clearAllMocks();
      const refused = useTransaction();
      await expect(updateBusinessInTransaction(refused.tx, { businessId: "biz-1", defaultLocale: locale as string })).rejects.toMatchObject({ status: 400, code: "invalid_locale" });
      expect(refused.updates).toEqual([]);
      expect(mocks.enqueueOutbox).not.toHaveBeenCalled();
    }
  });

  it("leaves the default receptionist's name alone when the language stays the same", async () => {
    const same = useTransaction();
    await updateBusinessInTransaction(same.tx, { businessId: "biz-1", defaultLocale: "en" });
    expect(same.updates).toEqual([{ table: businesses, values: expect.objectContaining({ defaultLocale: "en" }) }]);
    expect(same.inserts).toEqual([]);
  });

  it("refreshes the receptionist's snapshot when the dashboard updates the business", async () => {
    const { tx } = useTransaction();
    await updateBusiness({ db: undefined as never }, { userId: "operator", businessId: "biz-1", timezone: "Europe/Belgrade" });
    expect(mocks.enqueueOutbox).toHaveBeenCalledWith(tx, expect.objectContaining({ topic: "snapshot.refresh", businessId: "biz-1", payload: { businessId: "biz-1", reason: "business_updated" } }));
  });
});
