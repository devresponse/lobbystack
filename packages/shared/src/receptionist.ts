// Receptionist settings rules the dashboard and the v1 API share.

/** When the receptionist may put a caller through to the team. */
export const transferModes = ["never", "always", "on_request", "on_urgent", "during_business_hours"] as const;

/** How the receptionist handles appointment requests. */
export const bookingModes = ["off", "request", "instant"] as const;

/** How a caller proves an appointment is theirs before changing it. */
export const appointmentChangeVerificationModes = ["phone_match_and_facts", "otp_required", "operator_only"] as const;

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
