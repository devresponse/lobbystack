import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { getActiveOnboardingState, resolveOnboardingRoute } from "@lobbystack/domain";
import { OnboardingBrandSurface } from "@/components/onboarding-brand-surface";
import { getAppDatabase } from "@/lib/api-helpers";
import { getSession } from "@/lib/auth";
import { initialBrandingFields } from "@/lib/onboarding-branding";

/** The deployment's name and logo, asked of its first owner before their business. */
export default async function OnboardingBrandPage() {
  const session = await getSession(new Headers(await headers()));
  if (!session) redirect("/login");
  const fields = await initialBrandingFields(session.user.id);
  if (!fields) redirect(resolveOnboardingRoute((await getActiveOnboardingState(getAppDatabase().db, session.user.id)).stage));
  return <OnboardingBrandSurface askAppName={fields.appName} askLogo={fields.logo} />;
}
