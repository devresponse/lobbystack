import { describe, expect, it } from "vitest";
import { builtInBillingPlanLimits } from "@lobbystack/shared";

import { canVisitOnboardingStage, isOnboardingStage, isValidOnboardingTransition, normalizeOnboardingStage, resolveOnboardingRoute, resolveOnboardingStageForPlan, selectPreferredMembership } from "./onboarding";

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

  it("resumes the retired website step on knowledge", () => {
    expect(isOnboardingStage("website")).toBe(false);
    expect(normalizeOnboardingStage("website")).toBe("knowledge");
    expect(resolveOnboardingRoute("website")).toBe("/onboarding/knowledge");
  });

  it("allows only adjacent transitions, with an explicit number-selection skip", () => {
    expect(isValidOnboardingTransition("create_business", "knowledge")).toBe(true);
    expect(isValidOnboardingTransition("knowledge", "greeting")).toBe(true);
    expect(isValidOnboardingTransition("plan", "attribution")).toBe(true);
    expect(isValidOnboardingTransition("greeting", "plan")).toBe(true);
    expect(isValidOnboardingTransition("greeting", "knowledge")).toBe(false);
    expect(isValidOnboardingTransition("create_business", "greeting")).toBe(false);
    expect(isValidOnboardingTransition("complete", "knowledge")).toBe(false);
  });

  it("rejects unknown persisted values", () => {
    expect(isOnboardingStage("not-a-stage")).toBe(false);
    expect(isOnboardingStage("toString")).toBe(false);
    expect(isOnboardingStage("constructor")).toBe(false);
    expect(isOnboardingStage("verify_phone")).toBe(false);
    expect(isOnboardingStage("attribution")).toBe(true);
  });

  it("allows completed and later stages to revisit every reached step", () => {
    expect(canVisitOnboardingStage("create_business", "knowledge")).toBe(false);
    expect(canVisitOnboardingStage("knowledge", "knowledge")).toBe(true);
    expect(canVisitOnboardingStage("knowledge", "create_business")).toBe(true);
    expect(canVisitOnboardingStage("plan", "knowledge")).toBe(true);
    expect(canVisitOnboardingStage("plan", "phone_number")).toBe(false);
    expect(canVisitOnboardingStage("phone_number_claiming", "phone_number")).toBe(true);
    expect(canVisitOnboardingStage("complete", "attribution")).toBe(true);
    expect(canVisitOnboardingStage("complete", "create_business")).toBe(true);
  });
});

describe("original legacy plan-stage navigation", () => {
  const builtIn = { tiers: builtInBillingPlanLimits, plans: {} };
  it.each(["phone_number", "phone_number_claiming"] as const)("returns free-plan %s stages to plan selection", stage => {
    expect(resolveOnboardingStageForPlan(stage, "free_cloud", builtIn)).toBe("plan");
    expect(resolveOnboardingStageForPlan(stage, "starter", builtIn)).toBe(stage);
    expect(resolveOnboardingStageForPlan(stage, "self_host", builtIn)).toBe(stage);
  });
  it("preserves completed onboarding on the free plan", () => {
    expect(resolveOnboardingStageForPlan("complete", "free_cloud", builtIn)).toBe("complete");
  });
  it("lets a free plan whose catalog includes a number stay on the number steps", () => {
    const tiers = { ...builtInBillingPlanLimits, free_cloud: { ...builtInBillingPlanLimits.free_cloud, includedBusinessNumbers: 1 } };
    expect(resolveOnboardingStageForPlan("phone_number", "free_cloud", { tiers, plans: {} })).toBe("phone_number");
  });
  it("sends a promo plan without a number back to its plan", () => {
    const limits = { tiers: builtInBillingPlanLimits, plans: { "starter-chat": { tier: "starter", limits: { ...builtInBillingPlanLimits.starter, includedBusinessNumbers: 0 } } } };
    expect(resolveOnboardingStageForPlan("phone_number", "starter", limits, "starter-chat")).toBe("plan");
    expect(resolveOnboardingStageForPlan("phone_number", "starter", limits)).toBe("phone_number");
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
