import { isBillingCode, normalizeBillingCode } from "@lobbystack/shared";

const PROMO_CODE_STORAGE_KEY = "lobbystack.billing.promoCode";

// A promo link (/signup?promo=CODE) can lead through sign-up, email
// verification and onboarding before the plan screen, so the code waits in
// storage. Storage can be missing or throw; the code can still be typed.
function readStorage(): string | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage.getItem(PROMO_CODE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStorage(value: string | null): void {
  try {
    if (typeof window === "undefined") return;
    if (value === null) window.localStorage.removeItem(PROMO_CODE_STORAGE_KEY);
    else window.localStorage.setItem(PROMO_CODE_STORAGE_KEY, value);
  } catch {
    // Keep going without persistence.
  }
}

/** A code in the shape codes take, normalized, or null. */
export function promoCodeFrom(value: string | null | undefined): string | null {
  const code = normalizeBillingCode(value ?? "");
  return isBillingCode(code) ? code : null;
}

/** Keeps the URL's ?promo= code for the plan screen and returns it. */
export function capturePromoCodeFromUrl(url: URL): string | null {
  const code = promoCodeFrom(url.searchParams.get("promo"));
  if (code) writeStorage(code);
  return code;
}

export function getStoredPromoCode(): string | null {
  return promoCodeFrom(readStorage());
}

export function clearStoredPromoCode(): void {
  writeStorage(null);
}
