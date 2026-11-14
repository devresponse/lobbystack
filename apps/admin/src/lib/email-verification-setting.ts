type Environment = Readonly<Record<string, string | undefined>>;

/**
 * Whether a new account, and an account that never entered its code, needs the
 * code emailed to its address before it can sign in: on unless
 * REQUIRE_EMAIL_VERIFICATION is "false". Off, anyone can sign up with an
 * address they don't own and use the instance, so it's on by default.
 */
export function emailVerificationRequired(env: Environment = process.env): boolean {
  return env.REQUIRE_EMAIL_VERIFICATION?.trim().toLowerCase() !== "false";
}

/**
 * Whether a production server should say, as it starts, that the code is off.
 * A build loads the same startup file but serves no one, so it stays quiet.
 */
export function emailVerificationOffInProduction(env: Environment = process.env): boolean {
  return env.NODE_ENV === "production" && env.NEXT_PHASE !== "phase-production-build" && !emailVerificationRequired(env);
}
