// Onboarding's steps as the screens need them: the page of each stage, and
// the dots at the foot of every step. The server keeps the stages and their
// order (packages/domain/src/server/onboarding.ts); this file only draws them.

/** The page of each onboarding stage, as the server's resolveOnboardingRoute has them. */
export const onboardingStagePaths = {
  create_business: "/onboarding/business",
  plan: "/onboarding/plan",
  website: "/onboarding/website",
  knowledge: "/onboarding/knowledge",
  greeting: "/onboarding/greeting",
  phone_number: "/onboarding/number",
  phone_number_claiming: "/onboarding/number",
  attribution: "/onboarding/attribution",
  complete: "/",
} as const;

export type OnboardingStageName = keyof typeof onboardingStagePaths;

/** The page of a stage a server answer or a business row names, or undefined for a value that names none. */
export function onboardingStagePath(stage: unknown): string | undefined {
  return typeof stage === "string" && Object.hasOwn(onboardingStagePaths, stage) ? onboardingStagePaths[stage as OnboardingStageName] : undefined;
}

type OnboardingStepWidth = "sm" | "md" | "lg" | "xl" | "wide";
export type OnboardingRoute = { key: "brand" | "businessName" | "plan" | "website" | "knowledge" | "greeting" | "number" | "attribution"; step: number; width: OnboardingStepWidth };

// The steps after sign-up (step 1), in the order a business takes them. The
// plan comes right after the name, so the kind of account is chosen first.
const steps: ReadonlyArray<{ path: string; key: OnboardingRoute["key"]; width: OnboardingStepWidth }> = [
  { path: "/onboarding/business", key: "businessName", width: "md" },
  { path: "/onboarding/plan", key: "plan", width: "wide" },
  { path: "/onboarding/website", key: "website", width: "md" },
  { path: "/onboarding/knowledge", key: "knowledge", width: "lg" },
  { path: "/onboarding/greeting", key: "greeting", width: "md" },
  { path: "/onboarding/number", key: "number", width: "lg" },
  { path: "/onboarding/attribution", key: "attribution", width: "xl" },
];

const shownSteps = (planStep: boolean) => planStep ? steps : steps.filter((step) => step.key !== "plan");

/**
 * The onboarding pages keyed by path, each with its dot. A deployment that
 * takes no payments has no plan step (planStep false), so the steps after the
 * name move up one and the bar has seven dots, not eight. The brand step comes
 * before the business only for a deployment's first owner, so it shares step 2
 * and the dots keep linking that step to the business.
 */
export function onboardingRoutes(planStep: boolean): Record<string, OnboardingRoute> {
  return {
    "/onboarding/brand": { key: "brand", step: 2, width: "md" },
    ...Object.fromEntries(shownSteps(planStep).map((step, index) => [step.path, { key: step.key, step: index + 2, width: step.width }])),
  };
}

/** The page behind each dot, in order. The first dot is sign-up, which has no page to go back to. */
export function onboardingStepPaths(planStep: boolean): Array<string | undefined> {
  return [undefined, ...shownSteps(planStep).map((step) => step.path)];
}

/**
 * The last dot a business on this stage can open: its own step's. A business
 * stored on the plan step where there is none is on the website step, as the
 * server reads it. A finished business can open every dot.
 */
export function onboardingReachedStep(stage: string | undefined, planStep: boolean): number | undefined {
  if (stage === "complete") return onboardingStepPaths(planStep).length + 1;
  const path = onboardingStagePath(stage === "plan" && !planStep ? "website" : stage);
  return path === undefined ? undefined : onboardingRoutes(planStep)[path]?.step;
}
