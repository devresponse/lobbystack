import { redirect } from "next/navigation";

import { OnboardingBusinessSurface } from "@/components/onboarding-business-surface";
import { initialBrandingFields } from "@/lib/onboarding-branding";
import { requireOnboardingStage } from "@/lib/onboarding-route";

export default async function OnboardingBusinessPage({ searchParams }: { searchParams: Promise<{ create?: string }> }) {
  const params = await searchParams;
  const createNew = params.create === "true";
  const { userId, businessId } = await requireOnboardingStage("/onboarding/business", { allowCreate: createNew });
  // A fresh deployment's first owner names it before naming their business.
  if (businessId === null && await initialBrandingFields(userId)) redirect("/onboarding/brand");
  return <OnboardingBusinessSurface createNew={createNew} />;
}
