import { describe, expect, it } from "vitest";

import en from "../../public/locales/en/settings.json";
import { phoneNumberErrorMessage } from "./phone-number-errors";

const t = (key: string, options: Record<string, string>): string => Object.keys(options).length ? `${key} ${JSON.stringify(options)}` : key;

describe("phoneNumberErrorMessage", () => {
  it.each([
    ["number_offer_expired", "phoneNumber.errors.offerExpired"],
    ["number_offer_invalid", "phoneNumber.errors.offerExpired"],
    ["number_claim_in_progress", "phoneNumber.errors.claimInProgress"],
    ["number_claim_rate_limited", "phoneNumber.errors.claimRateLimited"],
    ["daily_claim_quota_reached", "phoneNumber.errors.dailyClaimQuota"],
    ["number_search_rate_limited", "phoneNumber.errors.searchRateLimited"],
    ["paid_plan_required", "phoneNumber.errors.paidPlanRequired"],
  ])("explains %s", (code, key) => {
    expect(phoneNumberErrorMessage(Object.assign(new Error("English server text."), { code }), t, "Fallback.")).toBe(key);
  });

  it("names the error ID of a failure the server logged", () => {
    expect(phoneNumberErrorMessage(Object.assign(new Error("Request failed."), { errorId: "3f2b6c1e-9a1d-4e5f-8b7a-2c3d4e5f6a7b" }), t, "We couldn't search numbers right now.")).toBe(`phoneNumber.errors.withErrorId ${JSON.stringify({ message: "We couldn't search numbers right now.", errorId: "3f2b6c1e-9a1d-4e5f-8b7a-2c3d4e5f6a7b" })}`);
  });

  it("leaves anything else to the caller", () => {
    expect(phoneNumberErrorMessage(Object.assign(new Error("Forbidden."), { code: "forbidden" }), t, "Fallback.")).toBeUndefined();
    expect(phoneNumberErrorMessage(new TypeError("Failed to fetch"), t, "Fallback.")).toBeUndefined();
    expect(phoneNumberErrorMessage(null, t, "Fallback.")).toBeUndefined();
  });

  it("has English copy for every key it uses", () => {
    const errors = en.phoneNumber.errors as Record<string, string>;
    for (const code of ["number_offer_expired", "number_offer_invalid", "number_offer_mismatch", "number_claim_in_progress", "number_claim_rate_limited", "daily_claim_quota_reached", "monthly_claim_quota_reached", "business_number_exists", "invalid_onboarding_stage", "paid_plan_required", "replacement_used", "active_number_required", "replacement_number_must_differ", "unsupported_country", "number_search_rate_limited", "number_search_invalid", "number_search_unsupported"]) {
      const key = phoneNumberErrorMessage({ code }, (value) => value, "")!;
      expect(errors[key.replace("phoneNumber.errors.", "")], code).toEqual(expect.any(String));
    }
    expect(errors.withErrorId).toContain("{{errorId}}");
  });
});
