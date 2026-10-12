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
