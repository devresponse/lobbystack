import { describe, expect, it } from "vitest";

import { promoEndStep, type PromoEndFacts } from "./billingPromoEnd";

const day = 24 * 60 * 60_000;
const now = new Date("2026-11-24T12:00:00.000Z");
const at = (offsetDays: number) => new Date(now.getTime() + offsetDays * day);

/** A monthly Starter subscription on a three-month promo plan whose months run out on December 1. */
function facts(overrides: Partial<PromoEndFacts> = {}): PromoEndFacts {
  return {
    plan: "starter", planCode: "salons-half-off", planEnds: new Date("2026-12-01T12:00:00.000Z"), planEnding: "tier", endWith: null, endNoticeAt: null, endSetAt: null,
    source: "polar", subscriptionState: "active", currentPeriodStart: new Date("2026-11-01T12:00:00.000Z"), currentPeriodEnd: new Date("2026-12-01T12:00:00.000Z"), ...overrides,
  };
}

describe("promo plan endings", () => {
  it("are due a week before the renewal that ends the plan, with Polar to tell and owners to email", () => {
    expect(promoEndStep(facts(), at(-1))).toEqual({ due: false });
    expect(promoEndStep(facts(), now)).toEqual({ due: true, ending: "tier", endsAt: new Date("2026-12-01T12:00:00.000Z"), set: true, notify: true, overdue: false });
    expect(promoEndStep(facts({ planEnding: "cancel" }), now)).toMatchObject({ due: true, ending: "cancel" });
  });

  it("wait for the renewal that reaches the plan's end, and end at it", () => {
    // Months count a little differently in Polar, so a renewal a day short still ends it.
    expect(promoEndStep(facts({ currentPeriodEnd: new Date("2026-11-30T20:00:00.000Z") }), now)).toMatchObject({ due: true, endsAt: new Date("2026-11-30T20:00:00.000Z") });
    // A yearly subscription whose plan ran out mid-year ends at its renewal, and hears a week before.
    const yearly = facts({ planEnds: at(-30), currentPeriodStart: at(-90), currentPeriodEnd: at(275) });
    expect(promoEndStep(yearly, now)).toEqual({ due: false });
    expect(promoEndStep(yearly, at(268))).toMatchObject({ due: true, endsAt: at(275) });
    // Without a renewal that reaches it, a plan whose end has passed is due at once.
    expect(promoEndStep(facts({ planEnds: at(-1), currentPeriodEnd: at(-2) }), now)).toMatchObject({ due: true, endsAt: at(-1) });
    // A period that ends well before the plan's end isn't the last one yet.
    expect(promoEndStep(facts({ planEnds: at(30), currentPeriodEnd: at(6) }), now)).toEqual({ due: false });
  });

  it("do each step once, and again when a renewal kept the plan anyway", () => {
    expect(promoEndStep(facts({ endSetAt: at(-1), endNoticeAt: at(-1) }), now)).toMatchObject({ due: true, set: false, notify: false, overdue: false });
    const overdue = facts({ planEnds: at(-8), endSetAt: at(-14), endNoticeAt: at(-14), currentPeriodStart: at(-7), currentPeriodEnd: at(23) });
    expect(promoEndStep(overdue, now)).toMatchObject({ due: true, set: true, notify: false, overdue: true });
  });

  it("never end a plan that keeps going, a standard plan, a lapsed subscription or a managed plan", () => {
    expect(promoEndStep(facts({ planEnding: "keep" }), now)).toEqual({ due: false });
    // An operator's end is due at once, even weeks before the renewal it ends at.
    expect(promoEndStep(facts({ planEnding: "keep", endWith: "tier", planEnds: at(-1), currentPeriodEnd: at(20) }), now)).toMatchObject({ due: true, ending: "tier", endsAt: at(20) });
    expect(promoEndStep(facts({ planCode: null }), now)).toEqual({ due: false });
    expect(promoEndStep(facts({ planCode: "starter" }), now)).toEqual({ due: false });
    expect(promoEndStep(facts({ planEnds: null }), now)).toEqual({ due: false });
    expect(promoEndStep(facts({ subscriptionState: "canceled" }), now)).toEqual({ due: false });
    expect(promoEndStep(facts({ source: "managed" }), now)).toEqual({ due: false });
  });
});
