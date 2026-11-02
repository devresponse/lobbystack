import { requireOnboardingStage } from "@/lib/onboarding-route";

// The website step was removed from onboarding: the Knowledge page imports a
// website instead. Keep the old route as a compatibility redirect to the
// caller's current onboarding step.
export default async function OnboardingWebsiteRedirectPage() {
  await requireOnboardingStage("/onboarding/website");
  return null;
}
