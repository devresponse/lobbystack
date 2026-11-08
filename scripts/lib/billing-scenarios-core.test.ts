import { describe, expect, it } from "vitest";

import { expectedOverageCents, firstOfMonth, inPool, nextFirstOfMonth, parseScenarioArgs, redactKeys, SCENARIOS, scenarioKeyProblem, ScenarioUsage } from "./billing-scenarios-core";

describe("the sandbox scenarios' command line", () => {
  it("runs every scenario on RealInfoBot's file, four at once, by default", () => {
    expect(parseScenarioArgs([])).toEqual({ list: false, help: false, brand: "realinfobot", only: null, keep: false, parallel: 4 });
  });

  it("takes a list of scenarios, a brand, how many at once, and whether to keep the clocks", () => {
    expect(parseScenarioArgs(["--only", "usage,refund", "--brand=alloplace", "--parallel", "2", "--keep"])).toEqual({ list: false, help: false, brand: "alloplace", only: ["usage", "refund"], keep: true, parallel: 2 });
    expect(parseScenarioArgs(["--list"]).list).toBe(true);
  });

  it("refuses an unknown scenario or option, and a value that's missing or out of range", () => {
    expect(() => parseScenarioArgs(["--only", "usage,nope"])).toThrow("No scenario is called nope");
    expect(() => parseScenarioArgs(["--stripe", "sandbox"])).toThrow(ScenarioUsage);
    expect(() => parseScenarioArgs(["--only"])).toThrow("--only needs a value");
    expect(() => parseScenarioArgs(["--parallel", "9"])).toThrow("from 1 to 8");
    expect(() => parseScenarioArgs(["--brand", "../x"])).toThrow("names a folder");
  });

  it("names every scenario once, with the events check last", () => {
    expect(new Set(SCENARIOS.map((scenario) => scenario.name)).size).toBe(SCENARIOS.length);
    expect(SCENARIOS.at(-1)?.name).toBe("events");
  });
});

describe("the scenarios' key", () => {
  it("never shows a key, whole or as Stripe's errors mask one", () => {
    expect(redactKeys("Invalid API Key provided: sk_test_********************1234, with rk_live_abc too")).toBe("Invalid API Key provided: ‹key›, with ‹key› too");
    expect(redactKeys("sub_123 and cus_456 stay")).toBe("sub_123 and cus_456 stay");
  });

  it("takes a test key only", () => {
    expect(scenarioKeyProblem("sk_test_abc123")).toBeNull();
    expect(scenarioKeyProblem(" rk_test_abc123 ")).toBeNull();
    expect(scenarioKeyProblem(undefined)).toContain("Set STRIPE_SCENARIOS_KEY");
    expect(scenarioKeyProblem("sk_live_abc123")).toContain("is a live key");
    expect(scenarioKeyProblem("pk_test_abc123")).toContain("isn't a Stripe test key");
  });
});

describe("dates and money", () => {
  it("finds the 1st an overage subscription renews on, in UTC", () => {
    expect(nextFirstOfMonth(new Date("2026-11-08T23:59:00Z")).toISOString()).toBe("2026-12-01T00:00:00.000Z");
    expect(nextFirstOfMonth(new Date("2026-12-31T23:59:59Z")).toISOString()).toBe("2027-01-01T00:00:00.000Z");
    expect(firstOfMonth(new Date("2026-11-08T12:00:00Z")).toISOString()).toBe("2026-11-01T00:00:00.000Z");
  });

  it("rounds a month's sent prices once, as the invoice line does", () => {
    expect(expectedOverageCents([30, 6, 20, -10])).toBe(46);
    expect(expectedOverageCents([33.3333, 33.3333, 33.3334])).toBe(100);
    expect(expectedOverageCents([0.4, 0.4])).toBe(1);
  });

  it("runs work a few at a time, keeping each answer in its place", async () => {
    let running = 0;
    let most = 0;
    const answers = await inPool([5, 1, 3, 2], 2, async (value) => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, value));
      running -= 1;
      return value * 10;
    });
    expect(answers).toEqual([50, 10, 30, 20]);
    expect(most).toBe(2);
  });
});
