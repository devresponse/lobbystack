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

/** The Twilio error code of a failed SMS send, when it has one. */
export function smsErrorCode(error: unknown): number | undefined {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "number" ? code : undefined;
}

/** The Twilio error code when an SMS send failed in a way a retry can't fix. */
export function permanentSmsErrorCode(error: unknown): number | undefined {
  const code = smsErrorCode(error);
  return code !== undefined && PERMANENT_SMS_ERROR_CODES.has(code) ? code : undefined;
}

/**
 * Why a text can't go to a contact: they have no phone number, the business
 * blocked them, they texted STOP, they never agreed to texts and never texted
 * the conversation, or the business has no number that can send texts.
 */
export type SmsHoldReason = "no_phone" | "blocked" | "opted_out" | "no_consent" | "no_sender";

/**
 * Why a text failed before it went out: it was held, Twilio refused the number
 * ("rejected") or its country ("region_blocked"), or every try to send it
 * failed for another reason ("unsent"), such as a text that's too long.
 */
export type SmsFailureReason = SmsHoldReason | "rejected" | "region_blocked" | "unsent";

/** How a text failed before it went out, as the worker records it. */
export type SmsFailure = { held: SmsHoldReason } | { rejected: number } | { unsent: number | undefined };

const SMS_HOLD_REASONS: ReadonlySet<string> = new Set<SmsHoldReason>(["no_phone", "blocked", "opted_out", "no_consent", "no_sender"]);

/**
 * The provider status a text keeps when it fails before it goes out:
 * "held:opted_out" for one held back, "rejected:21610" for one Twilio refused,
 * and "unsent:21617", or "unsent" without a Twilio code, after its last try.
 */
export function failedSmsProviderStatus(failure: SmsFailure): string {
  if ("held" in failure) return `held:${failure.held}`;
  if ("rejected" in failure) return `rejected:${failure.rejected}`;
  return failure.unsent === undefined ? "unsent" : `unsent:${failure.unsent}`;
}

/** Why a text failed before it went out, read from its provider status. Null for any other text. */
export function smsFailureReason(providerStatus: string | null | undefined): SmsFailureReason | null {
  // 21408: the business's Twilio account isn't allowed to text that country.
  if (providerStatus === "rejected:21408") return "region_blocked";
  if (providerStatus?.startsWith("rejected:")) return "rejected";
  if (providerStatus === "unsent" || providerStatus?.startsWith("unsent:")) return "unsent";
  const held = providerStatus?.startsWith("held:") ? providerStatus.slice("held:".length) : "";
  return SMS_HOLD_REASONS.has(held) ? held as SmsHoldReason : null;
}
