import { onboardingHasPlanStep } from "@lobbystack/domain";

import { OnboardingRouteShell } from "@/components/onboarding-route-shell";

// The parent layout reads the session, so this renders for each request and
// the plan step follows the deployment's settings as they are now.
export default function OnboardingLayout({ children }: { children: React.ReactNode }) {
  return <OnboardingRouteShell planStep={onboardingHasPlanStep()}>{children}</OnboardingRouteShell>;
}
