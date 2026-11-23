import { describe, expect, it } from "vitest";

import { onboardingReachedStep, onboardingRoutes, onboardingStagePath, onboardingStepPaths } from "./onboarding-steps";

describe("onboarding's steps as the screens draw them", () => {
  it("puts the plan right after the name on a deployment that takes payments: eight dots", () => {
    expect(onboardingStepPaths(true)).toEqual([undefined, "/onboarding/business", "/onboarding/plan", "/onboarding/website", "/onboarding/knowledge", "/onboarding/greeting", "/onboarding/number", "/onboarding/attribution"]);
    const routes = onboardingRoutes(true);
    expect(Object.fromEntries(Object.entries(routes).map(([path, route]) => [path, route.step]))).toEqual({
      "/onboarding/brand": 2,
      "/onboarding/business": 2,
      "/onboarding/plan": 3,
      "/onboarding/website": 4,
      "/onboarding/knowledge": 5,
      "/onboarding/greeting": 6,
      "/onboarding/number": 7,
      "/onboarding/attribution": 8,
    });
    expect(routes["/onboarding/plan"]).toEqual({ key: "plan", step: 3, width: "wide" });
  });

  it("has no plan step where the deployment takes none, and the later steps move up: seven dots", () => {
    expect(onboardingStepPaths(false)).toEqual([undefined, "/onboarding/business", "/onboarding/website", "/onboarding/knowledge", "/onboarding/greeting", "/onboarding/number", "/onboarding/attribution"]);
    const routes = onboardingRoutes(false);
    expect(routes["/onboarding/plan"]).toBeUndefined();
    expect(routes["/onboarding/website"]?.step).toBe(3);
    expect(routes["/onboarding/attribution"]?.step).toBe(7);
    // The brand step still shares the name's dot.
    expect(routes["/onboarding/brand"]?.step).toBe(2);
  });

  it("opens the dots up to the step the business is on", () => {
    expect(onboardingReachedStep("create_business", true)).toBe(2);
    expect(onboardingReachedStep("plan", true)).toBe(3);
    expect(onboardingReachedStep("website", true)).toBe(4);
    expect(onboardingReachedStep("greeting", true)).toBe(6);
    expect(onboardingReachedStep("phone_number", true)).toBe(7);
    expect(onboardingReachedStep("phone_number_claiming", true)).toBe(7);
    expect(onboardingReachedStep("attribution", true)).toBe(8);
    // A finished business can open every dot, the last one too.
    expect(onboardingReachedStep("complete", true)).toBe(9);
    expect(onboardingReachedStep(undefined, true)).toBeUndefined();
    expect(onboardingReachedStep("not-a-stage", true)).toBeUndefined();
  });

  it("counts the dots without a plan step, where a business stored on it is on the website step", () => {
    expect(onboardingReachedStep("create_business", false)).toBe(2);
    expect(onboardingReachedStep("plan", false)).toBe(3);
    expect(onboardingReachedStep("website", false)).toBe(3);
    expect(onboardingReachedStep("greeting", false)).toBe(5);
    expect(onboardingReachedStep("phone_number", false)).toBe(6);
    expect(onboardingReachedStep("attribution", false)).toBe(7);
    expect(onboardingReachedStep("complete", false)).toBe(8);
  });

  it("names the page of a stage, and none for a value that isn't one", () => {
    expect(onboardingStagePath("plan")).toBe("/onboarding/plan");
    expect(onboardingStagePath("phone_number_claiming")).toBe("/onboarding/number");
    expect(onboardingStagePath("complete")).toBe("/");
    expect(onboardingStagePath("toString")).toBeUndefined();
    expect(onboardingStagePath(undefined)).toBeUndefined();
    expect(onboardingStagePath(3)).toBeUndefined();
  });
});
