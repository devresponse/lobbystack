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

/** The account's business allowance as GET /api/businesses gives it: the most it may own, and whether a higher plan on one of its businesses allows more. */
type BusinessAllowance = { max: number; upgrade?: boolean | undefined };

/** The words for an account that owns as many businesses as it may: with an upgrade hint when a higher plan allows more. */
export function businessLimitMessage(t: Translate, limit: BusinessAllowance): string {
  return t(limit.upgrade ? "errors.tooManyBusinessesUpgrade" : "errors.tooManyBusinesses", { count: limit.max });
}

/**
 * The words to show for an onboarding step's error. businessLimit is the
 * account's allowance, as GET /api/businesses gives it, for the refusal at
 * its limit.
 */
export function getSafeOnboardingErrorMessage(
  error: unknown,
  t: Translate,
  fallbackKey: string,
  businessLimit?: BusinessAllowance,
): string {
  const message = getErrorText(error);
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;

  if (code === "website_url_invalid") {
    return t("website.invalidUrl");
  }

  if (code === "business_limit") {
    return businessLimit ? businessLimitMessage(t, businessLimit) : t("errors.businessLimit");
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
