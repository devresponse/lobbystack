import { describe, expect, it } from "vitest";
import { builtInBillingPlanLimits } from "@lobbystack/shared";

import { limitsFor } from "./billingPlans";
import { billableQuantityForEvent, effectiveBillingPlan, estimateSmsSegments, periodKeyFor, replayEvents } from "./usage";

const event = (sourceKey: string, usageKind: string, quantity: number, isFinal: boolean, minute: number, billingInterval = "annual", planCodeAtRecordTime: string | null = null) => ({ sourceKey, usageKind, quantity, isFinal, planAtRecordTime: "starter", planCodeAtRecordTime, billingIntervalAtRecordTime: billingInterval, createdAt: new Date(Date.UTC(2026, 8, 1, 0, minute)) });
const starter = { plan: "starter" as const, planCode: null };
const builtIn = { tiers: builtInBillingPlanLimits, plans: {} };

describe("overage spend and overage billing", () => {
  it("never counts website chats as overage spend", () => {
    const chats = Array.from({ length: 60 }, (_, index) => event(`chat:${index}`, "chat_ai_tokens", 1, true, index, "monthly"));
    const replay = replayEvents(chats, starter, builtIn);
    expect(replay.usage.chat_ai_tokens).toBe(60);
    expect(replay.rawSpendCents).toBe(0);
  });

  it("bills annual voice overage only against usage already final", () => {
    // 8,900 of Starter's 9,000 seconds are used. A browser call holds 300 s
    // while a 120 s phone call ends, then the browser call ends at 30 s.
    const used = event("voice:used", "voice_seconds", 8_900, true, 0);
    const widget = event("voice:widget", "voice_seconds", 300, false, 1);
    const phone = event("voice:phone", "voice_seconds", 120, true, 2);
    expect(billableQuantityForEvent([used, widget], phone, starter, builtIn)).toBe(20);
    const widgetEnded = { ...widget, quantity: 30, isFinal: true };
    expect(billableQuantityForEvent([used, phone], widgetEnded, starter, builtIn)).toBe(30);
    // A repeat correction of the phone call keeps the 20 it already billed.
    expect(billableQuantityForEvent([used, widgetEnded], phone, starter, builtIn, { quantity: 120, billableQuantity: 20 })).toBe(20);
  });

  it("bills a monthly plan's overage the same way, so Polar's products need no Credits", () => {
    const used = event("voice:used", "voice_seconds", 8_900, true, 0, "monthly");
    expect(billableQuantityForEvent([used], event("voice:phone", "voice_seconds", 120, true, 1, "monthly"), starter, builtIn)).toBe(20);
    expect(billableQuantityForEvent([], event("voice:first", "voice_seconds", 120, true, 1, "monthly"), starter, builtIn)).toBe(0);
  });
});

describe("usage under the catalog's limits", () => {
  const limits = { tiers: { ...builtInBillingPlanLimits, starter: { ...builtInBillingPlanLimits.starter, voiceSecondsIncluded: 6_000, voiceOverageRatePerMinuteCents: 30 } }, plans: {} };

  it("prices overage at the catalog's allowance and rate", () => {
    const calls = [event("voice:a", "voice_seconds", 6_000, true, 0, "monthly"), event("voice:b", "voice_seconds", 120, true, 1, "monthly")];
    expect(replayEvents(calls, starter, limits).rawSpendCents).toBe(60);
    expect(replayEvents(calls, starter, builtIn).rawSpendCents).toBe(0);
  });

  it("bills annual overage past the catalog's allowance", () => {
    const used = event("voice:used", "voice_seconds", 5_900, true, 0);
    expect(billableQuantityForEvent([used], event("voice:phone", "voice_seconds", 120, true, 1), starter, limits)).toBe(20);
  });
});

describe("usage on a promo plan with its own allowances", () => {
  // Starter with 300 minutes instead of 150, and 25 cents a minute over.
  const plus = { ...builtInBillingPlanLimits.starter, voiceSecondsIncluded: 18_000, voiceOverageRatePerMinuteCents: 25 };
  const limits = { tiers: builtInBillingPlanLimits, plans: { "salons-plus": { tier: "starter", limits: plus } } };
  const onPlus = { plan: "starter" as const, planCode: "salons-plus" };

  it("finds the plan's own limits only for its tier", () => {
    expect(limitsFor(limits, "starter", "salons-plus")).toBe(plus);
    expect(limitsFor(limits, "pro", "salons-plus")).toBe(builtInBillingPlanLimits.pro);
    expect(limitsFor(limits, "starter", "unknown-plan")).toBe(builtInBillingPlanLimits.starter);
    expect(limitsFor(limits, "starter", null)).toBe(builtInBillingPlanLimits.starter);
  });

  it("prices each event at the plan it was used under", () => {
    // 250 minutes on the promo plan are all included; on Starter, 100 are over at 20 cents.
    const promo = [event("voice:a", "voice_seconds", 15_000, true, 0, "monthly", "salons-plus")];
    expect(replayEvents(promo, onPlus, limits).rawSpendCents).toBe(0);
    expect(replayEvents(promo.map((row) => ({ ...row, planCodeAtRecordTime: null })), starter, limits).rawSpendCents).toBe(2_000);
    // Leaving it after 250 minutes: the next 10 minutes on Starter are over its 150.
    const moved = [...promo, event("voice:b", "voice_seconds", 600, true, 1, "monthly")];
    expect(replayEvents(moved, starter, limits).rawSpendCents).toBe(200);
    // Staying on it, 60 minutes past its 300 cost its own rate.
    const over = [...promo, event("voice:c", "voice_seconds", 6_600, true, 2, "monthly", "salons-plus")];
    expect(replayEvents(over, onPlus, limits).rawSpendCents).toBe(60 * 25);
  });

  it("reports annual overage only past the plan's own allowance", () => {
    const used = event("voice:used", "voice_seconds", 17_900, true, 0, "annual", "salons-plus");
    expect(billableQuantityForEvent([used], event("voice:phone", "voice_seconds", 120, true, 1, "annual", "salons-plus"), onPlus, limits)).toBe(20);
    // An event recorded without a plan counts under the plan in force.
    expect(billableQuantityForEvent([used], { ...event("voice:old", "voice_seconds", 120, true, 1), planAtRecordTime: null }, onPlus, limits)).toBe(20);
  });
});

describe("replacement non-AI usage policy", () => {
  it("uses the free plan when a cloud subscription is not active", () => {
    expect(effectiveBillingPlan({ deploymentMode: "cloud", accountPlan: "pro", subscriptionState: "canceled" })).toBe("free_cloud");
    expect(effectiveBillingPlan({ deploymentMode: "cloud", accountPlan: "pro", subscriptionState: "active" })).toBe("pro");
    expect(effectiveBillingPlan({ deploymentMode: "self_hosted", accountPlan: null, subscriptionState: null })).toBe("self_host");
  });

  it("estimates GSM and Unicode SMS segments conservatively", () => {
    expect(estimateSmsSegments("Appointment confirmed.")).toBe(1);
    expect(estimateSmsSegments("a".repeat(161))).toBe(2);
    expect(estimateSmsSegments("漢".repeat(71))).toBe(2);
    expect(estimateSmsSegments("😀".repeat(35))).toBe(1);
    expect(estimateSmsSegments("😀".repeat(36))).toBe(2);
  });

  it("uses UTC month keys for usage accounting", () => {
    expect(periodKeyFor(new Date("2026-08-14T23:59:59.000Z"))).toBe("2026-08");
    expect(periodKeyFor(new Date("2026-09-01T00:00:00.000Z"))).toBe("2026-09");
  });
});
