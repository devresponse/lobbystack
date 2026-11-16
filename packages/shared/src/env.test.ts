import { describe, expect, it } from "vitest";

import { booleanSettingErrors, booleanSettings, envFlag } from "./env";

describe("true/false settings", () => {
  it("reads every way of writing on and off, whatever the case or spacing", () => {
    for (const value of ["true", "1", "yes", "on", " TRUE ", "Yes", "ON"]) {
      expect(envFlag({ LIVE_PROTOTYPE_ENABLED: value }, "LIVE_PROTOTYPE_ENABLED"), value).toBe(true);
    }
    for (const value of ["false", "0", "no", "off", " FALSE ", "No", "Off"]) {
      expect(envFlag({ LIVE_PROTOTYPE_ENABLED: value }, "LIVE_PROTOTYPE_ENABLED"), value).toBe(false);
    }
  });

  // AUDIT-017: "1" used to mean off, because every site compared with === "true".
  it("refuses a value that is neither, naming the setting", () => {
    expect(() => envFlag({ SMTP_SECURE: "maybe" }, "SMTP_SECURE")).toThrow("SMTP_SECURE must be true, false, 1, 0, yes, no, on or off.");
  });

  it("falls back to what the setting means when it is unset or empty", () => {
    expect(envFlag({}, "LIVE_PROTOTYPE_ENABLED")).toBe(false);
    expect(envFlag({ CONTENT_RETENTION_ENABLED: "" }, "CONTENT_RETENTION_ENABLED")).toBe(true);
    expect(envFlag({ REQUIRE_EMAIL_VERIFICATION: "   " }, "REQUIRE_EMAIL_VERIFICATION")).toBe(true);
  });

  it("gives secure cookies the setting that production wants", () => {
    expect(envFlag({ NODE_ENV: "production" }, "BETTER_AUTH_USE_SECURE_COOKIES")).toBe(true);
    expect(envFlag({ NODE_ENV: "development" }, "BETTER_AUTH_USE_SECURE_COOKIES")).toBe(false);
    expect(envFlag({ NODE_ENV: "production", BETTER_AUTH_USE_SECURE_COOKIES: "no" }, "BETTER_AUTH_USE_SECURE_COOKIES")).toBe(false);
  });

  it("names every setting a deployment got wrong, not only the first", () => {
    expect(booleanSettingErrors({ SMTP_SECURE: "ssl", WIDGET_TURNSTILE: "enabled", LIVE_PROTOTYPE_ENABLED: "1" })).toEqual([
      "SMTP_SECURE must be true, false, 1, 0, yes, no, on or off.",
      "WIDGET_TURNSTILE must be true, false, 1, 0, yes, no, on or off.",
    ]);
    expect(booleanSettingErrors({})).toEqual([]);
  });

  it("gives each setting a default", () => {
    for (const [name, fallback] of Object.entries(booleanSettings)) {
      expect(typeof fallback === "boolean" || fallback === "production", name).toBe(true);
    }
  });
});
