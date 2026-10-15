import { BaseProviders } from "@/app/base-providers";
import { brandingSnapshot, loadBranding } from "@/lib/branding";
import { resourcesForRoute } from "@/lib/i18n-resources";
import { localeTag, type SupportedLocale } from "@/lib/locale";

/**
 * The website widget's document. Unlike `RootDocument`, it leaves out the saved
 * language preference and product analytics: the chat speaks the business's
 * language, which must neither give way to nor become a language saved on this
 * origin, and visitors on a business's site never download PostHog.
 */
export async function WidgetDocument({
  children,
  locale,
  namespaces,
}: {
  children: React.ReactNode;
  locale: SupportedLocale;
  namespaces: readonly string[];
}) {
  const branding = brandingSnapshot(await loadBranding());
  return (
    <html lang={localeTag(locale)} suppressHydrationWarning>
      <body>
        <BaseProviders branding={branding} initialLocale={locale} initialResources={resourcesForRoute(locale, namespaces)}>
          {children}
        </BaseProviders>
      </body>
    </html>
  );
}
