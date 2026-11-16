type Environment = Readonly<Record<string, string | undefined>>;

/**
 * The true/false settings, read one way (AUDIT-017).
 *
 * Each one was its own `=== "true"` or `!== "false"` comparison, so "1", "yes"
 * and "TRUE" silently meant off, and a setting read in several places could
 * disagree with itself about its default. Here the names and their defaults sit
 * together, and a value that is neither true nor false is an error at startup
 * instead of behaviour nobody can explain.
 */

const ON = new Set(["true", "1", "yes", "on"]);
const OFF = new Set(["false", "0", "no", "off"]);

/** What a true/false setting takes, for an error message. */
export const BOOLEAN_SETTING_VALUES = "true, false, 1, 0, yes, no, on or off";

/**
 * Every true/false setting a service reads, and what it means when unset.
 * "production" means on in production and off everywhere else.
 */
export const booleanSettings = {
  BETTER_AUTH_USE_SECURE_COOKIES: "production",
  BRAND_REQUIRED: false,
  CONTENT_RETENTION_ENABLED: true,
  LIVE_PROTOTYPE_ENABLED: false,
  LIVE_RECORDED_GREETING: true,
  LOBBYSTACK_CERTIFICATION_MODE: false,
  LOBBYSTACK_MAINTENANCE_MODE: false,
  POLAR_ACCEPT_LEGACY_BUSINESS_IDS: false,
  REQUIRE_EMAIL_VERIFICATION: true,
  S3_FORCE_PATH_STYLE: false,
  SMTP_SECURE: false,
  WIDGET_KEY_ISSUANCE_ENABLED: false,
  WIDGET_TURNSTILE: true,
} as const satisfies Record<string, boolean | "production">;

export type BooleanSetting = keyof typeof booleanSettings;

/** Reads a true/false setting. Throws when its value is neither, naming it. */
export function envFlag(source: Environment, name: BooleanSetting): boolean {
  const value = source[name]?.trim().toLowerCase();
  if (!value) {
    const fallback = booleanSettings[name];
    return fallback === "production" ? source.NODE_ENV === "production" : fallback;
  }
  if (ON.has(value)) return true;
  if (OFF.has(value)) return false;
  throw new Error(`${name} must be ${BOOLEAN_SETTING_VALUES}.`);
}

/**
 * Every true/false setting whose value is neither, in one message per setting,
 * so a service can refuse to start and name all of them at once.
 */
export function booleanSettingErrors(source: Environment): string[] {
  return Object.keys(booleanSettings).flatMap((name) => {
    try {
      envFlag(source, name as BooleanSetting);
      return [];
    } catch (error) {
      return [error instanceof Error ? error.message : String(error)];
    }
  });
}
