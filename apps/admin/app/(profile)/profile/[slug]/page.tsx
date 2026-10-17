import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { cache } from "react";

import { getPublicBusinessProfile } from "@lobbystack/domain";
import { brandAccentColor, brandLinks, currentBrand, readableTextOn } from "@lobbystack/shared";

import { ProfilePage } from "@/components/public-profile/profile-page";
import { getSession } from "@/lib/auth";
import { loadBranding } from "@/lib/branding";
import { brandLogoSrc } from "@/lib/branding-snapshot";
import { createWorkerDomainContext } from "@/lib/domain-context";
import { LOCALE_LABEL_KEYS, SUPPORTED_LOCALES, type SupportedLocale } from "@/lib/locale";
import { localeFromRequestHeaders } from "@/lib/locale-request";
import { profileAlternates, profileDescription, profileTitle, publicProfileUrl } from "@/lib/public-profile-page";
import { serverTranslator } from "@/lib/server-translation";

type ProfileRouteProps = { params: Promise<{ slug: string }> };

// Business slugs are at most 120 characters, so a longer one is never a page.
const MAX_SLUG_LENGTH = 120;

/**
 * The page's business, read once for the page and its metadata. A page that
 * isn't published yet shows only to a signed-in member of its business, as a
 * preview.
 */
const loadProfile = cache(async (slug: string) => {
  if (!slug || slug.length > MAX_SLUG_LENGTH) return null;
  const context = createWorkerDomainContext();
  const now = new Date();
  const published = await getPublicBusinessProfile(context, { slug, now });
  if (published) return { profile: published, now };
  const session = await getSession(new Headers(await headers())).catch(() => null);
  if (!session) return null;
  const preview = await getPublicBusinessProfile(context, { slug, previewUserId: session.user.id, now });
  return preview ? { profile: preview, now } : null;
});

async function pageLocale(): Promise<SupportedLocale> {
  return localeFromRequestHeaders(await headers()).locale;
}

export async function generateMetadata({ params }: ProfileRouteProps): Promise<Metadata> {
  const { slug } = await params;
  const [loaded, locale, branding] = await Promise.all([loadProfile(slug), pageLocale(), loadBranding()]);
  const t = serverTranslator(locale, "profile", branding.appName);
  const logo = brandLogoSrc(branding);
  const icons = logo ? { icons: { icon: logo } } : {};
  if (!loaded) return { title: t("notFound.title"), robots: { index: false, follow: false }, ...icons };
  const { profile } = loaded;
  const pageUrl = publicProfileUrl(profile.slug);
  const title = profileTitle(profile, t);
  const description = profileDescription(profile, t);
  return {
    title,
    description,
    alternates: profileAlternates(pageUrl, locale),
    // A preview stays out of search results, and so does every page of a dev or test deployment.
    robots: profile.published && currentBrand().indexing ? { index: true, follow: true } : { index: false, follow: false },
    openGraph: { type: "website", url: pageUrl, title, description },
    twitter: { card: "summary", title, description },
    ...icons,
  };
}

export default async function PublicProfileRoute({ params }: ProfileRouteProps) {
  const { slug } = await params;
  const [loaded, locale, branding] = await Promise.all([loadProfile(slug), pageLocale(), loadBranding()]);
  if (!loaded) notFound();
  const { profile, now } = loaded;
  const languageName = serverTranslator(locale, "common", branding.appName);
  const accent = brandAccentColor(process.env);
  return (
    <ProfilePage
      profile={profile}
      locale={locale}
      t={serverTranslator(locale, "profile", branding.appName)}
      now={now}
      pageUrl={publicProfileUrl(profile.slug)}
      accent={accent}
      onAccent={readableTextOn(accent)}
      brand={{ appName: branding.appName, logoSrc: brandLogoSrc(branding), invertLogo: !branding.logoUrl, siteUrl: brandLinks().siteUrl }}
      mapsEmbedKey={process.env.GOOGLE_MAPS_EMBED_API_KEY?.trim() || null}
      languageNames={Object.fromEntries(SUPPORTED_LOCALES.map((language) => [language, languageName(LOCALE_LABEL_KEYS[language])])) as Record<SupportedLocale, string>}
    />
  );
}
