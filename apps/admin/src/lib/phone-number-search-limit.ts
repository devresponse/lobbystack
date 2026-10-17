import "server-only";

import { enforceFixedWindow, fixedWindowLimit, type FixedWindowResult } from "./fixed-window-limit";

/** Counts a number search against the person's limit, which the dashboard and API keys acting as them share. */
export async function checkPhoneNumberSearchLimit(input: { userId: string; initial: boolean }): Promise<FixedWindowResult> {
  const name = input.initial ? "initial-10m" : "search-10m";
  return await enforceFixedWindow([fixedWindowLimit("phone-number-search", name, input.userId, input.initial ? 10 : 20, 600, "rate_limit_user")]);
}

/** Refuses a dashboard search over the limit with a 429 the chooser explains. Without the limiter's Redis it's a logged 503. */
export async function assertPhoneNumberSearchAllowed(input: { userId: string; initial: boolean }): Promise<void> {
  const result = await checkPhoneNumberSearchLimit(input);
  if (result.allowed) return;
  if (result.status === 503) throw Object.assign(new Error("Phone number search protection is unavailable."), { status: 503, code: "number_search_unavailable" });
  // The limit counts in fixed 10-minute windows.
  const minutes = Math.ceil((600 - (Math.floor(Date.now() / 1_000) % 600)) / 60);
  throw Object.assign(new Error(`Too many number searches. Try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`), { status: 429, code: "number_search_rate_limited" });
}
