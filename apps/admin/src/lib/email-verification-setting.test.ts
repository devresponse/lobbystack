import { describe, expect, it } from "vitest";

import { emailVerificationOffInProduction, emailVerificationRequired } from "./email-verification-setting";

describe("emailVerificationRequired", () => {
  it.each([
    ["unset", true, {}],
    ["empty", true, { REQUIRE_EMAIL_VERIFICATION: "" }],
    ["true", true, { REQUIRE_EMAIL_VERIFICATION: "true" }],
    ["on", true, { REQUIRE_EMAIL_VERIFICATION: "YES" }],
    ["false", false, { REQUIRE_EMAIL_VERIFICATION: "false" }],
    ["false with spaces and capitals", false, { REQUIRE_EMAIL_VERIFICATION: " False " }],
    ["off", false, { REQUIRE_EMAIL_VERIFICATION: "0" }],
  ])("%s: required is %s", (_label, required, env) => {
    expect(emailVerificationRequired(env)).toBe(required);
  });

  // AUDIT-017: a typo used to keep the code on and say nothing. The admin now
  // refuses to start, so nobody runs a server whose setting nobody can read.
  it("refuses a typo instead of guessing", () => {
    expect(() => emailVerificationRequired({ REQUIRE_EMAIL_VERIFICATION: "flase" })).toThrow("REQUIRE_EMAIL_VERIFICATION must be");
  });
});

describe("emailVerificationOffInProduction", () => {
  it("is true when a production server turns the code off", () => {
    expect(emailVerificationOffInProduction({ NODE_ENV: "production", REQUIRE_EMAIL_VERIFICATION: "false" })).toBe(true);
  });

  it.each([
    ["the code is on by default", { NODE_ENV: "production" }],
    ["the code is on", { NODE_ENV: "production", REQUIRE_EMAIL_VERIFICATION: "true" }],
    ["it runs in development", { NODE_ENV: "development", REQUIRE_EMAIL_VERIFICATION: "false" }],
    ["it's a production build", { NODE_ENV: "production", NEXT_PHASE: "phase-production-build", REQUIRE_EMAIL_VERIFICATION: "false" }],
  ])("is false when %s", (_label, env) => {
    expect(emailVerificationOffInProduction(env)).toBe(false);
  });
});
