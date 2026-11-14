type Environment = Readonly<Record<string, string | undefined>>;

const OFF_VALUES = new Set(["false", "0", "no", "off"]);

/**
 * The Turnstile site key the website chat's check runs with, or null when the
 * chat answers without one (AUDIT-004). The check runs whenever the deployment
 * has both Turnstile keys, the ones sign-up uses, unless WIDGET_TURNSTILE is
 * "false". It runs inside the chat's frame, on the deployment's own address,
 * so the Turnstile widget needs no customer websites in its hostname list.
 */
export function widgetChallengeSiteKey(env: Environment = process.env): string | null {
  const siteKey = env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim();
  if (!siteKey || !env.TURNSTILE_SECRET_KEY?.trim()) return null;
  if (OFF_VALUES.has(env.WIDGET_TURNSTILE?.trim().toLowerCase() ?? "")) return null;
  return siteKey;
}

/** Whether the chat route wants a session that passed the check before the receptionist answers. */
export function widgetChallengeRequired(env: Environment = process.env): boolean {
  return widgetChallengeSiteKey(env) !== null;
}

/**
 * Why a production server answers website chats without the check, for the
 * warning it logs as it starts: WIDGET_TURNSTILE turned it off, or a Turnstile
 * key is missing. Null when the check runs, outside production, and during a
 * build, which serves no one.
 */
export function widgetChallengeOffReason(env: Environment = process.env): "turned_off" | "keys_missing" | null {
  if (env.NODE_ENV !== "production" || env.NEXT_PHASE === "phase-production-build" || widgetChallengeRequired(env)) return null;
  return env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim() && env.TURNSTILE_SECRET_KEY?.trim() ? "turned_off" : "keys_missing";
}
