"use client";

import { usePathname } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { requestJson } from "@/lib/request-json";
import { useActiveBusiness } from "@/hooks/use-active-business";
import { useSignOut } from "@/hooks/use-sign-out";
import { NestedPageSurfaceProvider } from "@/components/page-surface";
import { onboardingRoutes as routes, onboardingStepCount, ReplacementOnboardingShell } from "@/components/replacement-onboarding-shell";

export function OnboardingRouteShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { t } = useTranslation("onboarding");
  const signOut = useSignOut();
  const route = routes[pathname as keyof typeof routes] ?? routes["/onboarding/business"];
  const showDescription = !["number", "plan", "attribution"].includes(route.key);
  const { business } = useActiveBusiness();
  const stage = business?.onboardingStage;
  const phones = useQuery({ queryKey: ["onboarding-primary-number", business?.businessId], enabled: route.key === "number" && Boolean(business), queryFn: () => requestJson<{ phoneNumbers: Array<{ id: string; e164: string; reclaimScheduledAt: string | null }> }>(`/api/phone-numbers?businessId=${encodeURIComponent(business!.businessId)}`) });
  const hasPrimaryNumber = Boolean(phones.data?.phoneNumbers.some(number => !number.reclaimScheduledAt));
  const selectedNumber = route.key === "number" && hasPrimaryNumber && ["attribution", "complete"].includes(stage ?? "");
  // A business still on the retired website step resumes on knowledge.
  const navigableUntil = ({ create_business: 2, website: 3, knowledge: 3, greeting: 4, plan: 5, phone_number: 6, phone_number_claiming: 6, attribution: 7, complete: 8 } as Record<string, number>)[stage ?? ""];
  return (
    <ReplacementOnboardingShell
      description={showDescription ? t(`${route.key}.description`) : ""}
      onSignOut={() => void signOut()}
      progress={{ current: route.step, ...(navigableUntil === undefined ? {} : { navigableUntil }), total: onboardingStepCount }}
      title={t(selectedNumber ? "number.selectedTitle" : `${route.key}.title`)}
      width={route.key === "number" && (!phones.data || hasPrimaryNumber) ? "md" : route.width}
    >
      <NestedPageSurfaceProvider>{children}</NestedPageSurfaceProvider>
    </ReplacementOnboardingShell>
  );
}
