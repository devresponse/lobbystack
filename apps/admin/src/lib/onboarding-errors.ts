type Translate = { (key: string): string; (key: string, options: { count: number }): string };

function getErrorText(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }

  return error instanceof Error ? error.message : "";
}

function includesAny(value: string, needles: string[]): boolean {
  const normalized = value.toLowerCase();
  return needles.some((needle) => normalized.includes(needle.toLowerCase()));
}

/**
 * The words to show for an onboarding step's error. businessLimit is the most
 * businesses one account may own, as GET /api/businesses gives it, for the
 * refusal at that limit.
 */
export function getSafeOnboardingErrorMessage(
  error: unknown,
  t: Translate,
  fallbackKey: string,
  businessLimit?: number,
): string {
  const message = getErrorText(error);
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;

  if (code === "website_url_invalid") {
    return t("website.invalidUrl");
  }

  if (code === "business_limit") {
    return businessLimit ? t("errors.tooManyBusinesses", { count: businessLimit }) : t("errors.businessLimit");
  }

  if (includesAny(message, ["Too many number searches"])) {
    return t("number.tooManySearches");
  }

  if (includesAny(message, ["no longer available", "number is unavailable"])) {
    return t("number.unavailable");
  }

  if (includesAny(message, ["Number provisioning limit reached"])) {
    return t("number.claimRateLimited");
  }

  if (includesAny(message, ["Trial accounts can only buy eligible trial numbers"])) {
    return t("number.trialAccountPurchaseLimit");
  }

  return t(fallbackKey);
}
