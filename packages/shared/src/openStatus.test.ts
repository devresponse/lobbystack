import { describe, expect, it } from "vitest";

import { openStatus } from "./openStatus";

// Acme Dental's week in Vancouver: weekdays 8 to 5, Thursday split for lunch
// and open late, Saturday morning, closed Sunday.
const hours = [
  { dayOfWeek: 1, openMinutes: 480, closeMinutes: 1020 },
  { dayOfWeek: 2, openMinutes: 480, closeMinutes: 1020 },
  { dayOfWeek: 3, openMinutes: 480, closeMinutes: 1020 },
  { dayOfWeek: 4, openMinutes: 480, closeMinutes: 720 },
  { dayOfWeek: 4, openMinutes: 780, closeMinutes: 1140 },
  { dayOfWeek: 5, openMinutes: 480, closeMinutes: 900 },
  { dayOfWeek: 6, openMinutes: 540, closeMinutes: 780 },
];
const zone = "America/Vancouver";

describe("openStatus", () => {
  it("is open inside a window and says when it closes", () => {
    // Wednesday 2026-10-14, 10:00 in Vancouver (UTC-7).
    expect(openStatus(hours, [], zone, new Date("2026-10-14T17:00:00Z"))).toEqual({ configured: true, openNow: true, closesAt: "2026-10-15T00:00:00.000Z" });
  });

  it("closes at the window's end, not after it", () => {
    expect(openStatus(hours, [], zone, new Date("2026-10-14T23:59:59Z")).openNow).toBe(true);
    expect(openStatus(hours, [], zone, new Date("2026-10-15T00:00:00Z"))).toEqual({ configured: true, openNow: false, opensAt: "2026-10-15T15:00:00.000Z" });
  });

  it("is closed over a lunch break and opens again after it", () => {
    // Thursday 12:30.
    expect(openStatus(hours, [], zone, new Date("2026-10-15T19:30:00Z"))).toEqual({ configured: true, openNow: false, opensAt: "2026-10-15T20:00:00.000Z" });
  });

  it("finds the next opening days away", () => {
    // Saturday 14:00, closed until Monday 8:00.
    expect(openStatus(hours, [], zone, new Date("2026-10-17T21:00:00Z"))).toEqual({ configured: true, openNow: false, opensAt: "2026-10-19T15:00:00.000Z" });
  });

  it("is closed during a closure and skips it when looking for the next opening", () => {
    const closures = [{ startsAt: "2026-10-21T07:00:00Z", endsAt: "2026-10-22T07:00:00Z" }];
    // Wednesday 2026-10-21, 10:00, closed all day.
    expect(openStatus(hours, closures, zone, new Date("2026-10-21T17:00:00Z"))).toEqual({ configured: true, openNow: false, opensAt: "2026-10-22T15:00:00.000Z" });
  });

  it("closes early when a closure starts later the same day", () => {
    const closures = [{ startsAt: "2026-10-14T21:00:00Z", endsAt: "2026-10-15T07:00:00Z" }];
    expect(openStatus(hours, closures, zone, new Date("2026-10-14T17:00:00Z")).closesAt).toBe("2026-10-14T21:00:00.000Z");
  });

  it("follows daylight saving time", () => {
    // New York's clocks go back on 2026-11-01: Monday 8:00 is 12:00 UTC before it and 13:00 UTC after.
    expect(openStatus(hours, [], "America/New_York", new Date("2026-10-26T12:00:00Z")).openNow).toBe(true);
    expect(openStatus(hours, [], "America/New_York", new Date("2026-11-02T12:59:00Z")).openNow).toBe(false);
    expect(openStatus(hours, [], "America/New_York", new Date("2026-11-02T13:00:00Z")).openNow).toBe(true);
  });

  it("joins back-to-back windows", () => {
    const split = [{ dayOfWeek: 3, openMinutes: 480, closeMinutes: 720 }, { dayOfWeek: 3, openMinutes: 720, closeMinutes: 1020 }];
    expect(openStatus(split, [], zone, new Date("2026-10-14T17:00:00Z")).closesAt).toBe("2026-10-15T00:00:00.000Z");
  });

  it("runs a window that closes before it opens past midnight", () => {
    const overnight = [{ dayOfWeek: 5, openMinutes: 1320, closeMinutes: 120 }];
    // Saturday 2026-10-17 1:00 in Vancouver, inside Friday's 22:00 to 2:00.
    expect(openStatus(overnight, [], zone, new Date("2026-10-17T08:00:00Z"))).toEqual({ configured: true, openNow: true, closesAt: "2026-10-17T09:00:00.000Z" });
  });

  it("gives no closing time when it never closes within a week", () => {
    const always = [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, openMinutes: 0, closeMinutes: 1440 }));
    expect(openStatus(always, [], zone, new Date("2026-10-14T17:00:00Z"))).toEqual({ configured: true, openNow: true });
  });

  it("is closed without hours or with an unknown time zone", () => {
    expect(openStatus([], [], zone, new Date("2026-10-14T17:00:00Z"))).toEqual({ configured: false, openNow: false });
    expect(openStatus(hours, [], "Not/AZone", new Date("2026-10-14T17:00:00Z"))).toEqual({ configured: true, openNow: false });
  });
});
