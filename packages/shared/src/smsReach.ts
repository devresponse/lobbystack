// Twilio toll-free numbers can only text numbers in the US and Canada.
const TOLL_FREE = /^\+18(?:00|33|44|55|66|77|88)\d{7}$/;

/** Whether a sender can text this number. False without a sender. */
export function canTextNumber(from: string | null | undefined, to: string | null | undefined): boolean {
  if (!from || !to) return false;
  return !TOLL_FREE.test(from) || to.startsWith("+1");
}

// Twilio errors that fail the same way on every retry: an invalid number (21211),
// a country the account can't text (21408), an unsubscribed recipient (21610),
// a number the sender can't reach (21612) and a number that can't get texts (21614).
const PERMANENT_SMS_ERROR_CODES = new Set([21211, 21408, 21610, 21612, 21614]);

/** The Twilio error code when an SMS send failed in a way a retry can't fix. */
export function permanentSmsErrorCode(error: unknown): number | undefined {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "number" && PERMANENT_SMS_ERROR_CODES.has(code) ? code : undefined;
}

/**
 * Why a text can't go to a contact: they have no phone number, the business
 * blocked them, they texted STOP, they never agreed to texts and never texted
 * the conversation, or the business has no number that can send texts.
 */
export type SmsHoldReason = "no_phone" | "blocked" | "opted_out" | "no_consent" | "no_sender";

/** Why a text failed before it went out: it was held, or Twilio refused the number ("rejected"). */
export type SmsFailureReason = SmsHoldReason | "rejected";

const SMS_HOLD_REASONS: ReadonlySet<string> = new Set<SmsHoldReason>(["no_phone", "blocked", "opted_out", "no_consent", "no_sender"]);

/**
 * The provider status a text keeps when it fails before it goes out:
 * "held:opted_out" for one held back, "rejected:21610" for one Twilio refused.
 */
export function failedSmsProviderStatus(failure: { held: SmsHoldReason } | { rejected: number }): string {
  return "held" in failure ? `held:${failure.held}` : `rejected:${failure.rejected}`;
}

/** Why a text failed before it went out, read from its provider status. Null for any other text. */
export function smsFailureReason(providerStatus: string | null | undefined): SmsFailureReason | null {
  if (providerStatus?.startsWith("rejected:")) return "rejected";
  const held = providerStatus?.startsWith("held:") ? providerStatus.slice("held:".length) : "";
  return SMS_HOLD_REASONS.has(held) ? held as SmsHoldReason : null;
}
