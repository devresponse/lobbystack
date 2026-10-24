import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const enforce = vi.hoisted(() => vi.fn());
vi.mock("./fixed-window-limit", async (importOriginal) => ({ ...await importOriginal<typeof import("./fixed-window-limit")>(), enforceFixedWindow: enforce }));

import { assertBillingCallAllowed } from "./billing-limit";

describe("checkout and billing portal limits", () => {
  beforeEach(() => enforce.mockReset());
  afterEach(() => vi.useRealTimers());

  it("counts a checkout against the business's hour and the person's, and a portal session against their own", async () => {
    enforce.mockResolvedValue({ allowed: true });
    await assertBillingCallAllowed("checkout", { businessId: "business-a", userId: "user-a" });
    await assertBillingCallAllowed("portal", { businessId: "business-a", userId: "user-a" });
    const [checkout, portal] = enforce.mock.calls.map(([limits]) => (limits as Array<{ key: string; limit: number; windowSeconds: number; reason: string }>).map(({ key, limit, windowSeconds, reason }) => ({ key: key.split(":").slice(1, 3).join(":"), limit, windowSeconds, reason })));
    expect(checkout).toEqual([
      { key: "billing-checkout:business-hour", limit: 10, windowSeconds: 3_600, reason: "rate_limit_business_hour" },
      { key: "billing-checkout:user-hour", limit: 20, windowSeconds: 3_600, reason: "rate_limit_user_hour" },
    ]);
    expect(portal).toEqual([
      { key: "billing-portal:business-hour", limit: 20, windowSeconds: 3_600, reason: "rate_limit_business_hour" },
      { key: "billing-portal:user-hour", limit: 40, windowSeconds: 3_600, reason: "rate_limit_user_hour" },
    ]);
  });

  it("refuses a call over the limit with a 429 that says when to try again", async () => {
    // 47 minutes and a second into the hour's window.
    vi.useFakeTimers({ now: new Date("2026-10-24T08:47:01Z") });
    enforce.mockResolvedValue({ allowed: false, status: 429, reason: "rate_limit_user_hour" });
    await expect(assertBillingCallAllowed("checkout", { businessId: "business-a", userId: "user-a" })).rejects.toMatchObject({ status: 429, code: "billing_rate_limited", message: "Too many checkouts started. Try again in 13 minutes." });
    await expect(assertBillingCallAllowed("portal", { businessId: "business-a", userId: "user-a" })).rejects.toMatchObject({ status: 429, message: "The billing portal was opened too many times. Try again in 13 minutes." });
  });

  it("reports a missing limiter as a server failure", async () => {
    enforce.mockResolvedValue({ allowed: false, status: 503, reason: "rate_limit_unavailable" });
    await expect(assertBillingCallAllowed("portal", { businessId: "business-a", userId: "user-a" })).rejects.toMatchObject({ status: 503, code: "billing_limit_unavailable" });
  });
});
