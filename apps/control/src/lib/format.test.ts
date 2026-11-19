import { describe, expect, it } from "vitest";

import { ago, change, compact, count, counted, date, dateTime, duration, minutes, money, monthName, signInMethods, usd, words } from "./format";

describe("how the panel writes things", () => {
  it("writes numbers", () => {
    expect(count(1284)).toBe("1,284");
    expect(count(null)).toBe("-");
    expect(compact(9_999)).toBe("9,999");
    expect(compact(12_900)).toBe("12.9K");
    expect(compact(4_200_000)).toBe("4.2M");
    expect(minutes(0.04)).toBe("<0.1");
    expect(minutes(0)).toBe("0");
    expect(minutes(1234.56)).toBe("1,234.6");
  });

  it("writes a number with its noun", () => {
    expect(counted(1, "call", "calls")).toBe("1 call");
    expect(counted(0, "call", "calls")).toBe("0 calls");
    expect(counted(1204, "person", "people")).toBe("1,204 people");
  });

  it("writes call lengths", () => {
    expect(duration(245)).toBe("4:05");
    expect(duration(3729)).toBe("1:02:09");
    expect(duration(0)).toBe("0:00");
    expect(duration(null)).toBe("-");
  });

  it("writes money in its own currency", () => {
    expect(money(4900, "usd")).toBe("$49.00");
    expect(money(8700, "CAD")).toBe("CA$87.00");
    expect(money(100, "not-a-currency")).toBe("1.00 NOT-A-CURRENCY");
    expect(money(null, "USD")).toBe("-");
    expect(usd(1.234)).toBe("$1.23");
  });

  it("writes times in UTC", () => {
    expect(dateTime(new Date("2026-11-18T19:04:59Z"))).toBe("2026-11-18 19:04");
    expect(date("2026-11-18T23:30:00-05:00")).toBe("2026-11-19");
    expect(dateTime("garbage")).toBe("-");
    expect(monthName("2026-11")).toBe("Nov 2026");
  });

  it("writes how long ago", () => {
    const now = Date.UTC(2026, 10, 18, 12);
    expect(ago(null, now)).toBe("never");
    expect(ago(new Date(now - 10_000), now)).toBe("just now");
    expect(ago(new Date(now - 60_000), now)).toBe("1 minute ago");
    expect(ago(new Date(now - 3 * 3_600_000), now)).toBe("3 hours ago");
    expect(ago(new Date(now - 12 * 86_400_000), now)).toBe("12 days ago");
    expect(ago(new Date(now - 120 * 86_400_000), now)).toBe("3 months ago");
    expect(ago(new Date(now - 3 * 365 * 86_400_000), now)).toBe("2 years ago");
  });

  it("writes codes in words", () => {
    expect(words("business_owner")).toBe("business owner");
    expect(words(null)).toBe("-");
    expect(signInMethods("credential, google, credential")).toBe("password, Google");
    expect(signInMethods(null)).toBe("-");
    expect(change(110, 100)).toBe("+10%");
    expect(change(97, 100)).toBe("-3%");
    expect(change(5, 0)).toBeNull();
  });
});
