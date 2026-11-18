import { describe, expect, it } from "vitest";

import { accessSettings, developmentAdmin, displayVersion, parseEmails } from "./config";

const AUD = "4714c1358e65fe4b408ad6d432a5f878f08194bdb4752441fd56faefa9b2b6f2";

describe("the panel's settings", () => {
  it("reads the team domain, audience tag and emails, forgiving how they were pasted", () => {
    expect(accessSettings({ CONTROL_ACCESS_TEAM_DOMAIN: " https://Example-Team.cloudflareaccess.com/ ", CONTROL_ACCESS_AUD: ` ${AUD} `, CONTROL_ADMIN_EMAILS: "Owner@Example.com, second@example.com" }))
      .toEqual({ teamDomain: "example-team.cloudflareaccess.com", audience: AUD, adminEmails: new Set(["owner@example.com", "second@example.com"]) });
  });

  it("names what is missing or wrong, so the panel stays shut", () => {
    const good = { CONTROL_ACCESS_TEAM_DOMAIN: "example-team.cloudflareaccess.com", CONTROL_ACCESS_AUD: AUD, CONTROL_ADMIN_EMAILS: "owner@example.com" };
    expect(accessSettings({})).toHaveProperty("problem", expect.stringContaining("CONTROL_ACCESS_TEAM_DOMAIN"));
    expect(accessSettings({ ...good, CONTROL_ACCESS_TEAM_DOMAIN: "example.com" })).toHaveProperty("problem", expect.stringContaining("CONTROL_ACCESS_TEAM_DOMAIN"));
    expect(accessSettings({ ...good, CONTROL_ACCESS_TEAM_DOMAIN: "evil.cloudflareaccess.com.example.com" })).toHaveProperty("problem");
    expect(accessSettings({ ...good, CONTROL_ACCESS_AUD: "short" })).toHaveProperty("problem", expect.stringContaining("CONTROL_ACCESS_AUD"));
    expect(accessSettings({ ...good, CONTROL_ADMIN_EMAILS: " , " })).toHaveProperty("problem", expect.stringContaining("CONTROL_ADMIN_EMAILS"));
    expect(accessSettings({ ...good, CONTROL_ADMIN_EMAILS: "owner@example.com, everyone" })).toHaveProperty("problem", expect.stringContaining("isn't an email"));
  });

  it("splits an email list on commas, semicolons and spaces", () => {
    expect(parseEmails("A@example.com; b@example.com  c@example.com,,")).toEqual(["a@example.com", "b@example.com", "c@example.com"]);
    expect(parseEmails(undefined)).toEqual([]);
  });

  it("lets a developer in without Access only when they name themselves", () => {
    expect(developmentAdmin({})).toBeNull();
    expect(developmentAdmin({ CONTROL_DEV_ADMIN_EMAIL: "not an email" })).toBeNull();
    expect(developmentAdmin({ CONTROL_DEV_ADMIN_EMAIL: " Dev@Example.com " })).toBe("dev@example.com");
  });

  it("shows the short commit it was built from", () => {
    expect(displayVersion({ RAILWAY_GIT_COMMIT_SHA: "00f6761a2b3c4d5e6f708192a3b4c5d6e7f80912" })).toBe("00f6761");
    expect(displayVersion({ SERVICE_VERSION: "821d351" })).toBe("821d351");
    expect(displayVersion({ SERVICE_VERSION: "latest" })).toBe("development");
    expect(displayVersion({})).toBe("development");
  });
});
