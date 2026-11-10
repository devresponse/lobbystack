import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { cache, type ReactElement } from "react";

import { getPublicProfilePage } from "@lobbystack/domain";
import { brandAccentColor, brandLinks, currentBrand, isReceptionistHandle, publicProfilePath, readableTextOn } from "@lobbystack/shared";
import { logEvent } from "@lobbystack/telemetry/node";

import { getSession } from "@/lib/auth";
import { loadBranding } from "@/lib/branding";
import { brandLogoSrc } from "@/lib/branding-snapshot";
import { createWorkerDomainContext } from "@/lib/domain-context";
import { LOCALE_LABEL_KEYS, SUPPORTED_LOCALES, type SupportedLocale } from "@/lib/locale";
import { localeFromRequestHeaders } from "@/lib/locale-request";
import { profileAlternates, profileDescription, profileTitle, receptionistPageDescription, receptionistPageTitle, receptionistPageUrl, receptionistPicker } from "@/lib/public-profile-page";
import { serverTranslator } from "@/lib/server-translation";
import { createReceptionistPageToken } from "@/lib/widget-keys";

import { ProfilePage } from "./profile-page";

// What the business page, /profile/<slug>, and a receptionist's page,
// /profile/<slug>/<handle>, share: the lookup both the page and its metadata
// read, the metadata, and the page with its chat's signed receptionist token
// and the visitor's dropdown. A handle names the receptionist; null is the
// business page, which the default receptionist answers.

// Business slugs are at most 120 characters, so a longer one is never a page.
const MAX_SLUG_LENGTH = 120;

/**
 * The page, read once for the page and its metadata. A page that isn't
 * published yet shows only to a signed-in member of its business, as a
 * preview. A handle that can't be one is never looked up.
 */
export const loadProfilePage = cache(async (slug: string, handle: string | null) => {
  if (!slug || slug.length > MAX_SLUG_LENGTH) return null;
  if (handle !== null && !isReceptionistHandle(handle.toLowerCase())) return null;
  const context = createWorkerDomainContext();
  const now = new Date();
  const published = await getPublicProfilePage(context, { slug, handle, now });
  if (published) return { found: published, now };
  const session = await getSession(new Headers(await headers())).catch(() => null);
  if (!session) return null;
  const preview = await getPublicProfilePage(context, { slug, handle, previewUserId: session.user.id, now });
  return preview ? { found: preview, now } : null;
});

async function pageLocale(): Promise<SupportedLocale> {
  return localeFromRequestHeaders(await headers()).locale;
}

export async function profileRouteMetadata(slug: string, handle: string | null): Promise<Metadata> {
  const [loaded, locale, branding] = await Promise.all([loadProfilePage(slug, handle), pageLocale(), loadBranding()]);
  const t = serverTranslator(locale, "profile", branding.appName);
  const logo = brandLogoSrc(branding);
  const icons = logo ? { icons: { icon: logo } } : {};
  // A receptionist that no longer has its own page sends visitors to the business page, which has its own metadata.
  if (!loaded || loaded.found.kind !== "page") return { title: t("notFound.title"), robots: { index: false, follow: false }, ...icons };
  const { profile, access } = loaded.found;
  const receptionistPage = handle !== null;
  const pageUrl = receptionistPageUrl(profile.slug, receptionistPage ? profile.receptionist?.handle ?? null : null);
  const title = receptionistPage ? receptionistPageTitle(profile, t) : profileTitle(profile, t);
  const description = receptionistPage ? receptionistPageDescription(profile, t) : profileDescription(profile, t);
  return {
    title,
    description,
    alternates: profileAlternates(pageUrl, locale),
    // A preview stays out of search results, and so do an unlisted receptionist's page and every page of a dev or test deployment.
    robots: profile.published && access.listed && currentBrand().indexing ? { index: true, follow: true } : { index: false, follow: false },
    openGraph: { type: "website", url: pageUrl, title, description },
    twitter: { card: "summary", title, description },
    ...icons,
  };
}

/**
 * The token the page's chat sends, naming the receptionist that answers the
 * page; only a published page with a chat signs one. A token that can't be
 * signed leaves the chat to the widget key's receptionist rather than the page
 * without a chat.
 */
function pageToken(access: { businessId: string; widgetKeyId: string | null; receptionistId: string | null }, chat: boolean): string | null {
  if (!chat || !access.widgetKeyId || !access.receptionistId) return null;
  try {
    return createReceptionistPageToken({ businessId: access.businessId, widgetKeyId: access.widgetKeyId, receptionistId: access.receptionistId });
  } catch (error) {
    logEvent("error", "public_profile.receptionist_token_failed", { businessId: access.businessId, error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

/** The page for the route: the business page with handle null, else the receptionist's. */
export async function renderProfileRoute(slug: string, handle: string | null): Promise<ReactElement> {
  const [loaded, locale, branding] = await Promise.all([loadProfilePage(slug, handle), pageLocale(), loadBranding()]);
  if (!loaded) notFound();
  const { found, now } = loaded;
  // A paused or archived receptionist's page, or the default one's, is the business page.
  if (found.kind === "businessPage") redirect(publicProfilePath(found.slug));
  const { profile, access } = found;
  const receptionistPage = handle !== null;
  const languageName = serverTranslator(locale, "common", branding.appName);
  const accent = brandAccentColor();
  return (
    <ProfilePage
      profile={profile}
      locale={locale}
      t={serverTranslator(locale, "profile", branding.appName)}
      now={now}
      pageUrl={receptionistPageUrl(profile.slug, receptionistPage ? profile.receptionist?.handle ?? null : null)}
      accent={accent}
      onAccent={readableTextOn(accent)}
      brand={{ appName: branding.appName, logoSrc: brandLogoSrc(branding), invertLogo: !branding.logoUrl, siteUrl: brandLinks().siteUrl }}
      mapsEmbedKey={process.env.GOOGLE_MAPS_EMBED_API_KEY?.trim() || null}
      languageNames={Object.fromEntries(SUPPORTED_LOCALES.map((language) => [language, languageName(LOCALE_LABEL_KEYS[language])])) as Record<SupportedLocale, string>}
      receptionistToken={pageToken(access, profile.published && Boolean(profile.widgetKey))}
      picker={receptionistPicker(profile)}
      receptionistPage={receptionistPage}
    />
  );
}
