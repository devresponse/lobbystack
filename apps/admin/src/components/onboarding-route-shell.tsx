"use client";

import { usePathname } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { requestJson } from "@/lib/request-json";
import { useActiveBusiness } from "@/hooks/use-active-business";
import { useSignOut } from "@/hooks/use-sign-out";
import { NestedPageSurfaceProvider } from "@/components/page-surface";
import { ReplacementOnboardingShell } from "@/components/replacement-onboarding-shell";
import { onboardingReachedStep, onboardingRoutes, onboardingStepPaths } from "@/lib/onboarding-steps";

/**
 * The frame of every onboarding step: its title, the words under it and the
 * dots. planStep says whether this deployment's onboarding has a plan step
 * (the server's onboardingHasPlanStep): with one, the plan is the third of
 * eight dots; without one there are seven.
 */
export function OnboardingRouteShell({ children, planStep }: { children: React.ReactNode; planStep: boolean }) {
  const pathname = usePathname();
  const { t } = useTranslation("onboarding");
  const signOut = useSignOut();
  const routes = onboardingRoutes(planStep);
  const route = routes[pathname] ?? routes["/onboarding/business"]!;
  const showDescription = !["number", "plan", "attribution"].includes(route.key);
  const { business } = useActiveBusiness();
  const stage = business?.onboardingStage;
  const phones = useQuery({ queryKey: ["onboarding-primary-number", business?.businessId], enabled: route.key === "number" && Boolean(business), queryFn: () => requestJson<{ phoneNumbers: Array<{ id: string; e164: string; reclaimScheduledAt: string | null }> }>(`/api/phone-numbers?businessId=${encodeURIComponent(business!.businessId)}`) });
  const hasPrimaryNumber = Boolean(phones.data?.phoneNumbers.some(number => !number.reclaimScheduledAt));
  const selectedNumber = route.key === "number" && hasPrimaryNumber && ["attribution", "complete"].includes(stage ?? "");
  const navigableUntil = onboardingReachedStep(stage, planStep);
  return (
    <ReplacementOnboardingShell
      description={showDescription ? t(`${route.key}.description`) : ""}
      onSignOut={() => void signOut()}
      progress={{ current: route.step, ...(navigableUntil === undefined ? {} : { navigableUntil }), paths: onboardingStepPaths(planStep) }}
      title={t(selectedNumber ? "number.selectedTitle" : `${route.key}.title`)}
      width={route.key === "number" && (!phones.data || hasPrimaryNumber) ? "md" : route.width}
    >
      <NestedPageSurfaceProvider>{children}</NestedPageSurfaceProvider>
    </ReplacementOnboardingShell>
  );
}
