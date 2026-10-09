import { beforeEach, describe, expect, it, vi } from "vitest";

import { businesses } from "@lobbystack/db";

const mocks = vi.hoisted(() => ({ enqueueOutbox: vi.fn() }));
vi.mock("@lobbystack/db", async (original) => ({ ...(await original<typeof import("@lobbystack/db")>()), enqueueOutbox: mocks.enqueueOutbox }));

import { createBusiness, isIanaTimeZone, updateBusinessTimezoneInTransaction } from "./tenancy";

beforeEach(() => { vi.clearAllMocks(); });

it.each(["", " ", "!!!", "a", "a".repeat(121)])("rejects invalid normalized explicit slug %j as a client error", async slug => {
  await expect(createBusiness({ db: undefined as never }, { userId: "unused", name: "Test", slug, timezone: "UTC", businessType: "test" })).rejects.toMatchObject({ status: 400 });
});

describe("business timezone", () => {
  function useTransaction(found = true) {
    const updates: Array<{ table: unknown; values: Record<string, unknown> }> = [];
    const tx = { update: (table: unknown) => ({ set: (values: Record<string, unknown>) => { updates.push({ table, values }); return { where: () => ({ returning: async () => found ? [{ id: "biz-1" }] : [] }) }; } }) };
    return { updates, tx: tx as never };
  }

  it.each(["America/Vancouver", "Asia/Kolkata", "America/Argentina/Buenos_Aires", "America/Port-au-Prince", "UTC"])("accepts the IANA zone %s", zone => {
    expect(isIanaTimeZone(zone)).toBe(true);
  });

  it.each(["", "Mars/Olympus_Mons", "+05:00", "GMT+5:30", "America/Vancouver; drop", "x".repeat(81)])("rejects %j", zone => {
    expect(isIanaTimeZone(zone)).toBe(false);
  });

  it("saves the zone and refreshes the receptionist's snapshot", async () => {
    const { tx, updates } = useTransaction();
    await expect(updateBusinessTimezoneInTransaction(tx, { businessId: "biz-1", timezone: " Europe/Belgrade " })).resolves.toBe("Europe/Belgrade");
    expect(updates).toEqual([{ table: businesses, values: expect.objectContaining({ timezone: "Europe/Belgrade" }) }]);
    expect(mocks.enqueueOutbox).toHaveBeenCalledWith(tx, expect.objectContaining({ topic: "snapshot.refresh", businessId: "biz-1", payload: { businessId: "biz-1", reason: "timezone_updated" } }));
  });

  it("refuses a zone that isn't an IANA zone without saving anything", async () => {
    const { tx, updates } = useTransaction();
    await expect(updateBusinessTimezoneInTransaction(tx, { businessId: "biz-1", timezone: "Eastern" })).rejects.toMatchObject({ status: 400, code: "invalid_timezone" });
    expect(updates).toEqual([]);
    expect(mocks.enqueueOutbox).not.toHaveBeenCalled();
  });

  it("reports a missing business", async () => {
    const { tx } = useTransaction(false);
    await expect(updateBusinessTimezoneInTransaction(tx, { businessId: "missing", timezone: "UTC" })).rejects.toMatchObject({ status: 404 });
    expect(mocks.enqueueOutbox).not.toHaveBeenCalled();
  });
});
