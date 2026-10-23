import { describe, expect, it } from "vitest";

import { billingCodePrefix, billingPlanName, discountedCents, isBillingCode, normalizeBillingCode } from "./billingCodes";

describe("promo codes", () => {
  it("compares codes regardless of case and spaces", () => {
    expect(normalizeBillingCode(" allo-7k2q px9m\n")).toBe("ALLO-7K2QPX9M");
    expect(normalizeBillingCode("a".repeat(500))).toHaveLength(64);
  });

  it("accepts letters and digits in groups joined by single hyphens", () => {
    expect(isBillingCode("ALLO-7K2Q-PX9M")).toBe(true);
    expect(isBillingCode("SPRING25")).toBe(true);
    expect(isBillingCode("ABC")).toBe(false);
    expect(isBillingCode("A".repeat(33))).toBe(false);
    expect(isBillingCode("ALLO--7K2Q")).toBe(false);
    expect(isBillingCode("-ALLO")).toBe(false);
    expect(isBillingCode("ALLO-")).toBe(false);
    expect(isBillingCode("allo-7k2q")).toBe(false);
    expect(isBillingCode("ALLO_7K2Q")).toBe(false);
  });

  it("makes a prefix from the brand's name", () => {
    expect(billingCodePrefix("AlloPlace")).toBe("ALLO");
    expect(billingCodePrefix("AlloPlace (dev)")).toBe("ALLO");
    expect(billingCodePrefix("A")).toBe("PROMO");
    expect(billingCodePrefix("")).toBe("PROMO");
  });

  it("takes a discount off a price, never below nothing", () => {
    expect(discountedCents(10_000, null)).toBe(10_000);
    expect(discountedCents(10_000, { type: "percentage", basis_points: 2_000 })).toBe(8_000);
    expect(discountedCents(2_999, { type: "percentage", basis_points: 1_250 })).toBe(2_624);
    expect(discountedCents(10_000, { type: "fixed", amount_cents: 2_500 })).toBe(7_500);
    expect(discountedCents(1_000, { type: "fixed", amount_cents: 2_500 })).toBe(0);
  });

  it("names a plan in the language asked for, else English, else any", () => {
    const names = { en: "Pro launch", fr: "Pro lancement" };
    expect(billingPlanName(names, "fr")).toBe("Pro lancement");
    expect(billingPlanName(names, "fr-CA")).toBe("Pro lancement");
    expect(billingPlanName(names, "es")).toBe("Pro launch");
    expect(billingPlanName({ sr: "Pro start" }, "es")).toBe("Pro start");
    expect(billingPlanName({}, "en")).toBeNull();
  });
});
