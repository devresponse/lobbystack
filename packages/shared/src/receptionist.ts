// Receptionist settings rules the dashboard and the v1 API share.

/** When the receptionist may put a caller through to the team. */
export const transferModes = ["never", "always", "on_request", "on_urgent", "during_business_hours"] as const;

/** How the receptionist handles appointment requests. */
export const bookingModes = ["off", "request", "instant"] as const;

/** How a caller proves an appointment is theirs before changing it. */
export const appointmentChangeVerificationModes = ["phone_match_and_facts", "otp_required", "passcode_required", "operator_only"] as const;

/** Shortest and longest keypad PIN a contact can have, for passcode_required. */
export const CONTACT_PASSCODE_MIN_LENGTH = 4;
export const CONTACT_PASSCODE_MAX_LENGTH = 8;

/** Whether a value can be a contact's keypad PIN: digits only, of an allowed length. */
export function isContactPasscode(value: string): boolean {
  return new RegExp(`^\\d{${CONTACT_PASSCODE_MIN_LENGTH},${CONTACT_PASSCODE_MAX_LENGTH}}$`).test(value);
}

/**
 * Whether a PIN is one of the first a stranger would try: one digit repeated
 * or digits counting up or down, like 1111, 1234 or 4321. A PIN locks after a
 * few wrong tries, so these would fall within them.
 */
export function isGuessableContactPasscode(value: string): boolean {
  const digits = [...value].map(Number);
  const step = (digits[1] ?? 0) - (digits[0] ?? 0);
  return Math.abs(step) <= 1 && digits.every((digit, index) => index === 0 || digit - digits[index - 1]! === step);
}

/** Longest greeting, tone, summary or booking policy. */
export const RECEPTIONIST_TEXT_MAX_LENGTH = 2_000;

/** Longest voice, SMS or chat instructions. */
export const RECEPTIONIST_INSTRUCTIONS_MAX_LENGTH = 8_000;

/** Longest rule title. */
export const RULE_TITLE_MAX_LENGTH = 160;

/** Longest rule text the dashboard saves. */
export const RULE_CONTENT_MAX_LENGTH = 10_000;

/** Most rules the API lets a business keep, and so the most ids one reorder sends. */
export const RULES_MAX = 100;

/** Rule text calls read. The dashboard keeps longer text, but calls use only this much of it. */
export const RULE_CONTENT_CALL_MAX_LENGTH = 4_000;

/** Active rules calls follow, in order. */
export const RULES_CALL_MAX = 50;
