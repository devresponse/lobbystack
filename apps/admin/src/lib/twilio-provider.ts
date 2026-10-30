import "server-only";

import { TwilioProvider } from "@lobbystack/providers";

import { jsonError } from "./api-helpers";

let provider: TwilioProvider | undefined;

export function getTwilioProvider(): TwilioProvider {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) throw new Error("Twilio is not configured: set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN.");
  provider ??= new TwilioProvider({ accountSid, authToken });
  return provider;
}

/**
 * Twilio for a dashboard route that searches numbers. A deployment without
 * Twilio answers 503 phone_numbers_unavailable, which the number picker
 * explains, instead of an alertable 500.
 */
export function requireTwilioProvider(): TwilioProvider {
  if (!twilioConfigured()) throw jsonError("Phone numbers aren't set up on this dashboard.", 503, "phone_numbers_unavailable");
  return getTwilioProvider();
}

/** Whether the deployment has a Twilio account to search and buy numbers with. Checked before a search counts against the rate limit. */
export function twilioConfigured(): boolean {
  return Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN);
}

export function getNumberClaimTokenSecret(): string {
  const value = process.env.NUMBER_CLAIM_TOKEN_SECRET;
  if (!value || value.length < 32) throw new Error("Number claim signing is not configured.");
  return value;
}
