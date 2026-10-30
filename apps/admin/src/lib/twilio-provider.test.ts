import { afterEach, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { requireTwilioProvider, twilioConfigured } from "./twilio-provider";

afterEach(() => vi.unstubAllEnvs());

it("answers 503 phone_numbers_unavailable when the deployment has no Twilio account", async () => {
  vi.stubEnv("TWILIO_ACCOUNT_SID", "");
  vi.stubEnv("TWILIO_AUTH_TOKEN", "");
  expect(twilioConfigured()).toBe(false);
  let refusal: unknown;
  try { requireTwilioProvider(); } catch (error) { refusal = error; }
  expect(refusal).toBeInstanceOf(Response);
  expect((refusal as Response).status).toBe(503);
  expect(await (refusal as Response).json()).toMatchObject({ code: "phone_numbers_unavailable" });
});

it("needs both the account SID and the auth token", () => {
  vi.stubEnv("TWILIO_ACCOUNT_SID", "AC00000000000000000000000000000000");
  vi.stubEnv("TWILIO_AUTH_TOKEN", "");
  expect(twilioConfigured()).toBe(false);
  vi.stubEnv("TWILIO_AUTH_TOKEN", "auth-token");
  expect(twilioConfigured()).toBe(true);
});
