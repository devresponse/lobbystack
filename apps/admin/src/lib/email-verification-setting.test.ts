import { describe, expect, it } from "vitest";

import { emailVerificationOffInProduction, emailVerificationRequired } from "./email-verification-setting";

describe("emailVerificationRequired", () => {
  it.each([
    ["unset", true, {}],
    ["empty", true, { REQUIRE_EMAIL_VERIFICATION: "" }],
    ["true", true, { REQUIRE_EMAIL_VERIFICATION: "true" }],
    // Only "false" turns it off, so a typo keeps the code.
    ["a typo", true, { REQUIRE_EMAIL_VERIFICATION: "flase" }],
    ["false", false, { REQUIRE_EMAIL_VERIFICATION: "false" }],
    ["false with spaces and capitals", false, { REQUIRE_EMAIL_VERIFICATION: " False " }],
  ])("%s: required is %s", (_label, required, env) => {
    expect(emailVerificationRequired(env)).toBe(required);
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
