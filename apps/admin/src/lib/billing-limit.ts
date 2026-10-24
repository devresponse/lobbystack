import { enforceFixedWindow, fixedWindowLimit, type FixedWindowResult } from "./fixed-window-limit";

/**
 * Each checkout and portal session is a call to Polar, and Polar's request
 * budget is the whole organization's: past it, Polar refuses every call,
 * payments and usage included. So a business can start 10 checkouts and open
 * the portal 20 times an hour, from the dashboard and its API keys together,
 * and a person 20 checkouts and 40 portal sessions, across businesses.
 */
export const billingCallLimits = {
  checkout: { business: 10, person: 20 },
  portal: { business: 20, person: 40 },
} as const;

export type BillingCall = keyof typeof billingCallLimits;

/** Counts one checkout or portal session against the business's and the person's hourly limits. */
export async function checkBillingCallLimit(call: BillingCall, input: { businessId: string; userId: string }): Promise<FixedWindowResult> {
  const limits = billingCallLimits[call];
  return await enforceFixedWindow([
    fixedWindowLimit(`billing-${call}`, "business-hour", input.businessId, limits.business, 60 * 60, "rate_limit_business_hour"),
    fixedWindowLimit(`billing-${call}`, "user-hour", input.userId, limits.person, 60 * 60, "rate_limit_user_hour"),
  ]);
}

const refusals: Record<BillingCall, string> = {
  checkout: "Too many checkouts started.",
  portal: "The billing portal was opened too many times.",
};

/** Refuses a dashboard call over the limit with a 429 the plan screens explain. Without the limiter's Redis it's a logged 503. */
export async function assertBillingCallAllowed(call: BillingCall, input: { businessId: string; userId: string }): Promise<void> {
  const result = await checkBillingCallLimit(call, input);
  if (result.allowed) return;
  if (result.status === 503) throw Object.assign(new Error("Billing protection is unavailable."), { status: 503, code: "billing_limit_unavailable" });
  // The limits count in fixed one-hour windows.
  const minutes = Math.ceil((3_600 - (Math.floor(Date.now() / 1_000) % 3_600)) / 60);
  throw Object.assign(new Error(`${refusals[call]} Try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`), { status: 429, code: "billing_rate_limited" });
}
