import { describe, expect, it } from "vitest";

import { getSafeOnboardingErrorMessage } from "./onboarding-errors";

const t = (key: string, options?: Record<string, unknown>): string => options ? `${key} ${JSON.stringify(options)}` : key;

describe("getSafeOnboardingErrorMessage", () => {
  const limitReached = Object.assign(new Error("This account already owns 3 businesses, the most one account can own."), { code: "business_limit" });

  it("says the account's business limit, with the number the page has", () => {
    expect(getSafeOnboardingErrorMessage(limitReached, t, "businessName.submitFailed", 3)).toBe('errors.tooManyBusinesses {"count":3}');
  });

  it("says the business limit without a number when the page doesn't have it", () => {
    expect(getSafeOnboardingErrorMessage(limitReached, t, "businessName.submitFailed")).toBe("errors.businessLimit");
  });

  it("maps number search rate limits", () => {
    expect(
      getSafeOnboardingErrorMessage(
        new Error("Too many number searches. Please wait."),
        t,
        "number.searchFailed",
      ),
    ).toBe("number.tooManySearches");
  });

  it("preserves actionable Twilio trial-account guidance", () => {
    expect(
      getSafeOnboardingErrorMessage(
        "This Twilio account can't buy that number. Trial accounts can only buy eligible trial numbers and may need an existing number released or the account upgraded.",
        t,
        "number.claimFailed",
      ),
    ).toBe("number.trialAccountPurchaseLimit");
  });

  it("falls back for retired phone-verification errors instead of returning stale copy", () => {
    expect(
      getSafeOnboardingErrorMessage(
        Object.assign(new Error("A valid mobile phone number is required."), { code: "phone_number_invalid" }),
        t,
        "number.searchFailed",
      ),
    ).toBe("number.searchFailed");
  });
});
