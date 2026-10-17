import type { Metadata } from "next";
import { brandImage, currentBrand } from "@lobbystack/shared";

import { loadBranding } from "@/lib/branding";
import { brandLogoSrc, type BrandingSnapshot } from "@/lib/branding-snapshot";

/**
 * The title, description and tab icon every page takes from the deployment's
 * name and logo, and the picture link previews show when the brand file has
 * one. A page with its own preview, such as a business's profile, replaces it.
 * A dev or test host whose brand file says so keeps search engines away from
 * every page.
 */
export function brandingMetadata(branding: Pick<BrandingSnapshot, "appName" | "logoUrl">): Metadata {
  const icon = brandLogoSrc(branding);
  const brand = currentBrand();
  const preview = brandImage(brand, brand.ogImage);
  return {
    title: branding.appName,
    description: "AI receptionist dashboard",
    ...(icon ? { icons: { icon } } : {}),
    ...(preview
      ? {
          openGraph: { siteName: branding.appName, images: [{ url: preview.url, width: preview.width, height: preview.height, alt: branding.appName }] },
          twitter: { card: "summary_large_image", images: [preview.url] },
        }
      : {}),
    ...(brand.indexing ? {} : { robots: { index: false, follow: false } }),
  };
}

/** Metadata for a layout rendered per request, from the deployment's current branding. */
export async function generateBrandingMetadata(): Promise<Metadata> {
  return brandingMetadata(await loadBranding());
}
