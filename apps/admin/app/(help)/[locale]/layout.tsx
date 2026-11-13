import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { RootDocument, brandingMetadata } from "@/app/root-document";
import { buildTimeBrandingSnapshot } from "@/lib/branding";
import { HELP_LOCALES, isHelpLocale } from "@/lib/help/locales";
import { routeNamespaces } from "@/lib/route-namespaces";
import "../../globals.css";

// The help center (apps/admin/src/lib/help), built once for each language that
// has help. The proxy sends the other interface languages to English, so no
// page is built for them. Prerendered like the sign-in pages, so the header
// carries the name and logo the build environment sets.

export const dynamic = "error";
export const dynamicParams = false;
export const metadata: Metadata = brandingMetadata(buildTimeBrandingSnapshot());

export function generateStaticParams() {
  return HELP_LOCALES.map((locale) => ({ locale }));
}

export default async function HelpLocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!isHelpLocale(locale)) notFound();
  return (
    <RootDocument branding={buildTimeBrandingSnapshot()} locale={locale} localeSource="path" namespaces={routeNamespaces("/help")}>
      {children}
    </RootDocument>
  );
}
