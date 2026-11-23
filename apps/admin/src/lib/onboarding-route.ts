import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { canVisitOnboardingStage, getActiveOnboardingState, onboardingHasPlanStep, resolveOnboardingRoute, type OnboardingStage } from "@lobbystack/domain";

import { getAppDatabase } from "./api-helpers";
import { getSession } from "./auth";

const routeStages: Record<string, OnboardingStage> = {
  "/onboarding/business": "create_business",
  "/onboarding/plan": "plan",
  "/onboarding/website": "website",
  "/onboarding/knowledge": "knowledge",
  "/onboarding/greeting": "greeting",
  "/onboarding/number": "phone_number",
  "/onboarding/attribution": "attribution",
};

export type OnboardingVisit = { userId: string; businessId: string | null; stage: OnboardingStage };

export async function requireOnboardingStage(pathname: string, options: { allowCreate?: boolean } = {}): Promise<OnboardingVisit> {
  const session = await getSession(new Headers(await headers()));
  if (!session) redirect("/login");
  const state = await getActiveOnboardingState(getAppDatabase().db, session.user.id);
  const visit = { userId: session.user.id, ...state };
  const expected = routeStages[pathname];
  if (!expected) redirect(resolveOnboardingRoute(state.stage));
  if (options.allowCreate && expected === "create_business" && state.businessId === null) return visit;
  // A deployment that takes no payments has no plan step, so its plan page sends everyone on to the step they are on.
  if (expected === "plan" && !onboardingHasPlanStep()) redirect(resolveOnboardingRoute(state.stage));
  if (!canVisitOnboardingStage(state.stage, expected)) redirect(resolveOnboardingRoute(state.stage));
  return visit;
}
