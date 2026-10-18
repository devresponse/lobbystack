import { describe, expect, it } from "vitest";

import { PROVIDER_PRICE_RECHECKS, providerPriceRecheckJob } from "./providerPricing";

describe("providerPriceRecheckJob", () => {
  const text = (recheck: number, providerStatus = "sent") => providerPriceRecheckJob({ topic: "sms.syncPrice", businessId: "business_1", entityId: "SM123", payload: { providerMessageId: "SM123", providerStatus }, recheck });

  it("looks again a minute later, then waits twice as long after each miss", () => {
    const minutes = (recheck: number) => Math.round((text(recheck).availableAt!.getTime() - Date.now()) / 60_000);
    expect([1, 2, 3, PROVIDER_PRICE_RECHECKS].map(minutes)).toEqual([1, 2, 4, 512]);
  });

  it("repeats the check with its recheck count, in one chain per text or call", () => {
    expect(text(3)).toMatchObject({ topic: "sms.syncPrice", businessId: "business_1", aggregateType: "message", dedupeKey: "message:SM123:price:recheck:3", payload: { providerMessageId: "SM123", providerStatus: "sent", priceRecheck: 3 } });
    // The text's "sent" and "delivered" checks share their rechecks.
    expect(text(1, "delivered").dedupeKey).toBe(text(1).dedupeKey);
    expect(providerPriceRecheckJob({ topic: "call.syncPrice", businessId: "business_1", entityId: "call_1", payload: { callId: "call_1", providerCallStatus: "completed", priceRecheck: 1 }, recheck: 2 })).toMatchObject({ aggregateType: "call", dedupeKey: "call:call_1:price:recheck:2", payload: { callId: "call_1", providerCallStatus: "completed", priceRecheck: 2 } });
  });
});
