import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { getActiveOnboardingState, resolveOnboardingRoute } from "@lobbystack/domain";
import { RootDocument } from "@/app/root-document";
import { DashboardShell } from "@/components/dashboard-shell";
import { getSession } from "@/lib/auth";
import { getAppDatabase } from "@/lib/api-helpers";
import { localizePublicPath } from "@/lib/locale-path";
import { localeFromRequestHeaders } from "@/lib/locale-request";
import { DASHBOARD_NAMESPACES } from "@/lib/route-namespaces";
import "../globals.css";

export const dynamic = "force-dynamic";
export { generateBrandingMetadata as generateMetadata } from "@/app/root-document";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const requestHeaders = await headers();
  const { locale, source } = localeFromRequestHeaders(requestHeaders);
  const session = await getSession(new Headers(requestHeaders));
  if (!session) redirect(localizePublicPath("/login", locale));
  const onboarding = await getActiveOnboardingState(getAppDatabase().db, session.user.id);
  if (onboarding.stage !== "complete") redirect(resolveOnboardingRoute(onboarding.stage));
  return (
    <RootDocument locale={locale} localeSource={source} namespaces={DASHBOARD_NAMESPACES}>
      <DashboardShell
        user={{
          email: session.user.email ?? "",
          name: session.user.name ?? session.user.email ?? "",
        }}
      >
        {children}
      </DashboardShell>
    </RootDocument>
  );
}
