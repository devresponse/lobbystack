type Translate = (key: string, options: Record<string, string>) => string;

// The number search and claim refusals the chooser can explain, by the code the
// server sends, as keys in the settings namespace.
const phoneNumberErrorKeys: Record<string, string> = {
  number_offer_expired: "phoneNumber.errors.offerExpired",
  number_offer_invalid: "phoneNumber.errors.offerExpired",
  number_offer_mismatch: "phoneNumber.errors.offerExpired",
  number_claim_in_progress: "phoneNumber.errors.claimInProgress",
  number_claim_rate_limited: "phoneNumber.errors.claimRateLimited",
  daily_claim_quota_reached: "phoneNumber.errors.dailyClaimQuota",
  monthly_claim_quota_reached: "phoneNumber.errors.monthlyClaimQuota",
  business_number_exists: "phoneNumber.errors.numberExists",
  invalid_onboarding_stage: "phoneNumber.errors.invalidStage",
  paid_plan_required: "phoneNumber.errors.paidPlanRequired",
  replacement_used: "phoneNumber.errors.replacementUsed",
  active_number_required: "phoneNumber.errors.activeNumberRequired",
  replacement_number_must_differ: "phoneNumber.errors.replacementMustDiffer",
  unsupported_country: "phoneNumber.errors.unsupportedCountry",
  number_search_rate_limited: "phoneNumber.errors.searchRateLimited",
  number_search_invalid: "phoneNumber.errors.searchInvalid",
  number_search_unsupported: "phoneNumber.errors.searchUnsupported",
};

/**
 * Explains a failed number search or claim, with `t` reading the settings
 * namespace: the refusal the server named, or for a failure the server logged,
 * `fallback` with the error ID it was logged under. Undefined for anything else.
 */
export function phoneNumberErrorMessage(error: unknown, t: Translate, fallback: string): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const { code, errorId } = error as { code?: unknown; errorId?: unknown };
  if (typeof code === "string" && Object.hasOwn(phoneNumberErrorKeys, code)) return t(phoneNumberErrorKeys[code]!, {});
  if (typeof errorId === "string" && errorId) return t("phoneNumber.errors.withErrorId", { message: fallback, errorId });
  return undefined;
}
