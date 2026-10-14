import type { Metadata } from "next";

import { Providers } from "@/app/providers";
import { brandingSnapshot, loadBranding } from "@/lib/branding";
import { brandLogoSrc, type BrandingSnapshot } from "@/lib/branding-snapshot";
import { resourcesForRoute } from "@/lib/i18n-resources";
import { localeTag, type SupportedLocale } from "@/lib/locale";
import type { LocaleSource } from "@/lib/locale-request";

/** The title, description and tab icon every page takes from the deployment's name and logo. */
export function brandingMetadata(branding: Pick<BrandingSnapshot, "appName" | "logoUrl">): Metadata {
  const icon = brandLogoSrc(branding);
  return {
    title: branding.appName,
    description: "AI receptionist dashboard",
    ...(icon ? { icons: { icon } } : {}),
  };
}

/** Metadata for a layout rendered per request, from the deployment's current branding. */
export async function generateBrandingMetadata(): Promise<Metadata> {
  return brandingMetadata(await loadBranding());
}

/**
 * The document every route group renders. A prerendered layout passes the
 * branding its build knows; a layout rendered per request leaves it out, and
 * the deployment's current branding is read here.
 */
export async function RootDocument({
  branding,
  children,
  locale,
  localeSource,
  namespaces,
}: {
  branding?: BrandingSnapshot;
  children: React.ReactNode;
  locale: SupportedLocale;
  localeSource: LocaleSource;
  namespaces: readonly string[];
}) {
  const shown = branding ?? brandingSnapshot(await loadBranding());
  return (
    <html lang={localeTag(locale)} suppressHydrationWarning>
      <body>
        <Providers
          branding={shown}
          initialLocale={locale}
          initialLocaleSource={localeSource}
          initialResources={resourcesForRoute(locale, namespaces)}
        >
          {children}
        </Providers>
      </body>
    </html>
  );
}
