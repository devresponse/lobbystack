import { describe, expect, it } from "vitest";
import { builtInBillingPlanLimits } from "@lobbystack/shared";

import { canVisitOnboardingStage, isOnboardingStage, isValidOnboardingTransition, normalizeOnboardingStage, onboardingHasPlanStep, onboardingStageAfterName, resolveOnboardingRoute, resolveOnboardingStageForNumbers, resolveOnboardingStageForPlan, selectPreferredMembership } from "./onboarding";

describe("onboarding stages", () => {
  it("maps persisted stages to their dedicated routes", () => {
    expect(resolveOnboardingRoute("plan")).toBe("/onboarding/plan");
    expect(resolveOnboardingRoute("phone_number_claiming")).toBe("/onboarding/number");
    expect(resolveOnboardingRoute("complete")).toBe("/");
  });

  it("normalizes retired verification stages forward to plan", () => {
    expect(normalizeOnboardingStage("verify_phone")).toBe("plan");
    expect(normalizeOnboardingStage("verify_phone_code")).toBe("plan");
    expect(resolveOnboardingRoute("verify_phone")).toBe("/onboarding/plan");
    expect(resolveOnboardingRoute("verify_phone_code")).toBe("/onboarding/plan");
    expect(normalizeOnboardingStage("not-a-stage")).toBe("create_business");
  });

  it("puts the plan right after the name, and allows only adjacent transitions, with an explicit number-selection skip", () => {
    // After the name: the plan step, or the website step where the deployment has no plan step.
    expect(isValidOnboardingTransition("create_business", "plan")).toBe(true);
    expect(isValidOnboardingTransition("create_business", "website")).toBe(true);
    expect(isValidOnboardingTransition("plan", "website")).toBe(true);
    expect(isValidOnboardingTransition("website", "knowledge")).toBe(true);
    expect(isValidOnboardingTransition("knowledge", "greeting")).toBe(true);
    // After the greeting: the number step, or past it for a plan without a number.
    expect(isValidOnboardingTransition("greeting", "phone_number")).toBe(true);
    expect(isValidOnboardingTransition("greeting", "attribution")).toBe(true);
    // The plan no longer follows the greeting, and nothing but the website step follows the plan.
    expect(isValidOnboardingTransition("greeting", "plan")).toBe(false);
    expect(isValidOnboardingTransition("plan", "phone_number")).toBe(false);
    expect(isValidOnboardingTransition("plan", "attribution")).toBe(false);
    expect(isValidOnboardingTransition("plan", "knowledge")).toBe(false);
    expect(isValidOnboardingTransition("greeting", "knowledge")).toBe(false);
    expect(isValidOnboardingTransition("website", "plan")).toBe(false);
    expect(isValidOnboardingTransition("complete", "website")).toBe(false);
  });

  it("rejects unknown persisted values", () => {
    expect(isOnboardingStage("not-a-stage")).toBe(false);
    expect(isOnboardingStage("toString")).toBe(false);
    expect(isOnboardingStage("constructor")).toBe(false);
    expect(isOnboardingStage("verify_phone")).toBe(false);
    expect(isOnboardingStage("attribution")).toBe(true);
  });

  it("allows completed and later stages to revisit every reached step", () => {
    expect(canVisitOnboardingStage("create_business", "plan")).toBe(false);
    expect(canVisitOnboardingStage("create_business", "website")).toBe(false);
    expect(canVisitOnboardingStage("plan", "plan")).toBe(true);
    // A business on the plan step hasn't reached the steps that now follow it.
    expect(canVisitOnboardingStage("plan", "website")).toBe(false);
    expect(canVisitOnboardingStage("plan", "knowledge")).toBe(false);
    expect(canVisitOnboardingStage("plan", "phone_number")).toBe(false);
    expect(canVisitOnboardingStage("website", "website")).toBe(true);
    // The plan step stays open to go back to from every later step.
    expect(canVisitOnboardingStage("website", "plan")).toBe(true);
    expect(canVisitOnboardingStage("greeting", "plan")).toBe(true);
    expect(canVisitOnboardingStage("greeting", "phone_number")).toBe(false);
    expect(canVisitOnboardingStage("phone_number_claiming", "phone_number")).toBe(true);
    expect(canVisitOnboardingStage("complete", "attribution")).toBe(true);
    expect(canVisitOnboardingStage("complete", "create_business")).toBe(true);
  });
});

describe("the plan step, only where the deployment takes payments", () => {
  const polar = { POLAR_ACCESS_TOKEN: "token", POLAR_ORGANIZATION_ID: "organization" };
  const stripe = { BILLING_PROVIDER: "stripe", STRIPE_API_KEY: "rk_test_key", STRIPE_ACCOUNT_ID: "acct_1" };

  it("has one where the deployment's billing provider is set up, and the name is followed by it", () => {
    expect(onboardingHasPlanStep(polar)).toBe(true);
    expect(onboardingHasPlanStep(stripe)).toBe(true);
    expect(onboardingHasPlanStep({ ...polar, DEPLOYMENT_MODE: "cloud" })).toBe(true);
    expect(onboardingStageAfterName(polar)).toBe("plan");
    expect(onboardingStageAfterName(stripe)).toBe("plan");
  });

  it("has none where nothing can be bought, and the name is followed by the website", () => {
    expect(onboardingHasPlanStep({})).toBe(false);
    expect(onboardingHasPlanStep({ POLAR_ACCESS_TOKEN: "token" })).toBe(false);
    expect(onboardingHasPlanStep({ BILLING_PROVIDER: "stripe", STRIPE_API_KEY: "rk_test_key" })).toBe(false);
    // The deployment's own provider counts: Polar's settings sell nothing on a Stripe deployment.
    expect(onboardingHasPlanStep({ ...polar, BILLING_PROVIDER: "stripe" })).toBe(false);
    expect(onboardingStageAfterName({})).toBe("website");
  });

  it("has none on a self-hosted server, whose businesses get its unlimited plan", () => {
    expect(onboardingHasPlanStep({ ...polar, DEPLOYMENT_MODE: "self_hosted_standard" })).toBe(false);
    expect(onboardingStageAfterName({ ...polar, DEPLOYMENT_MODE: "self_hosted_standard" })).toBe("website");
  });

  it("shows the website step for a business stored on the plan step where there is none", () => {
    expect(resolveOnboardingStageForNumbers("plan", 0, false)).toBe("website");
    expect(resolveOnboardingStageForNumbers("plan", null, false)).toBe("website");
    expect(resolveOnboardingStageForNumbers("plan", 0, true)).toBe("plan");
    expect(resolveOnboardingStageForPlan("plan", null, { tiers: builtInBillingPlanLimits, plans: {} }, null, false)).toBe("website");
    // Every other stage shows as stored.
    for (const stage of ["create_business", "website", "knowledge", "greeting", "attribution", "complete"] as const) {
      expect(resolveOnboardingStageForNumbers(stage, 0, false)).toBe(stage);
      expect(resolveOnboardingStageForNumbers(stage, 0, true)).toBe(stage);
    }
  });
});

describe("original legacy plan-stage navigation", () => {
  const builtIn = { tiers: builtInBillingPlanLimits, plans: {} };
  // On a deployment with a plan step, which is where a plan can be changed.
  it.each(["phone_number", "phone_number_claiming"] as const)("returns free-plan %s stages to plan selection", stage => {
    expect(resolveOnboardingStageForPlan(stage, "free_cloud", builtIn, null, true)).toBe("plan");
    expect(resolveOnboardingStageForPlan(stage, "starter", builtIn, null, true)).toBe(stage);
    expect(resolveOnboardingStageForPlan(stage, "self_host", builtIn, null, true)).toBe(stage);
  });
  it.each(["phone_number", "phone_number_claiming"] as const)("leaves a free-plan %s stage on the number step, which can be skipped, where there is no plan step to go back to", stage => {
    expect(resolveOnboardingStageForPlan(stage, "free_cloud", builtIn, null, false)).toBe(stage);
    expect(resolveOnboardingStageForNumbers(stage, 0, false)).toBe(stage);
  });
  it("preserves completed onboarding on the free plan", () => {
    expect(resolveOnboardingStageForPlan("complete", "free_cloud", builtIn, null, true)).toBe("complete");
  });
  it("lets a free plan whose catalog includes a number stay on the number steps", () => {
    const tiers = { ...builtInBillingPlanLimits, free_cloud: { ...builtInBillingPlanLimits.free_cloud, includedBusinessNumbers: 1 } };
    expect(resolveOnboardingStageForPlan("phone_number", "free_cloud", { tiers, plans: {} }, null, true)).toBe("phone_number");
  });
  it("sends a promo plan without a number back to its plan", () => {
    const limits = { tiers: builtInBillingPlanLimits, plans: { "starter-chat": { tier: "starter", limits: { ...builtInBillingPlanLimits.starter, includedBusinessNumbers: 0 } } } };
    expect(resolveOnboardingStageForPlan("phone_number", "starter", limits, "starter-chat", true)).toBe("plan");
    expect(resolveOnboardingStageForPlan("phone_number", "starter", limits, null, true)).toBe("phone_number");
  });
});

describe("active business fallback", () => {
  it("prefers an operable membership over a viewer membership", () => {
    expect(selectPreferredMembership([{ business_id: "a", role: "viewer" }, { business_id: "b", role: "business_owner" }])?.business_id).toBe("b");
  });
  it("uses the first membership when every membership is a viewer", () => {
    expect(selectPreferredMembership([{ business_id: "a", role: "viewer" }, { business_id: "b", role: "viewer" }])?.business_id).toBe("a");
  });
  it("returns undefined when the user has no active membership", () => {
    expect(selectPreferredMembership([])).toBeUndefined();
  });
});
