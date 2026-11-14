import { describe, expect, it } from "vitest";

import { widgetChallengeOffReason, widgetChallengeRequired, widgetChallengeSiteKey } from "./widget-challenge";

const keys = { NEXT_PUBLIC_TURNSTILE_SITE_KEY: " site-key ", TURNSTILE_SECRET_KEY: "secret-key" };

describe("the website chat's Turnstile check (AUDIT-004)", () => {
  it("runs with the deployment's Turnstile keys, the ones sign-up uses", () => {
    expect(widgetChallengeSiteKey(keys)).toBe("site-key");
    expect(widgetChallengeRequired(keys)).toBe(true);
  });

  it.each([
    ["no site key", { TURNSTILE_SECRET_KEY: "secret-key" }],
    ["no secret key", { NEXT_PUBLIC_TURNSTILE_SITE_KEY: "site-key" }],
    ["blank keys", { NEXT_PUBLIC_TURNSTILE_SITE_KEY: " ", TURNSTILE_SECRET_KEY: " " }],
  ])("doesn't run with %s, since it couldn't pass", (_label, env) => {
    expect(widgetChallengeSiteKey(env)).toBeNull();
    expect(widgetChallengeRequired(env)).toBe(false);
  });

  it.each(["false", "0", "no", "off", " OFF "])("turns off with WIDGET_TURNSTILE=%s", (value) => {
    expect(widgetChallengeRequired({ ...keys, WIDGET_TURNSTILE: value })).toBe(false);
  });

  it.each(["true", "1", "yes", ""])("stays on with WIDGET_TURNSTILE=%s", (value) => {
    expect(widgetChallengeRequired({ ...keys, WIDGET_TURNSTILE: value })).toBe(true);
  });

  describe("why a production server answers without it", () => {
    it("says the check was turned off on purpose", () => {
      expect(widgetChallengeOffReason({ ...keys, NODE_ENV: "production", WIDGET_TURNSTILE: "false" })).toBe("turned_off");
    });

    it("says a key is missing", () => {
      expect(widgetChallengeOffReason({ NODE_ENV: "production", NEXT_PUBLIC_TURNSTILE_SITE_KEY: "site-key" })).toBe("keys_missing");
      expect(widgetChallengeOffReason({ NODE_ENV: "production" })).toBe("keys_missing");
    });

    it.each([
      ["when the check runs", { ...keys, NODE_ENV: "production" }],
      ["outside production", { NODE_ENV: "development" }],
      ["during a build", { NODE_ENV: "production", NEXT_PHASE: "phase-production-build" }],
    ])("says nothing %s", (_label, env) => {
      expect(widgetChallengeOffReason(env)).toBeNull();
    });
  });
});
