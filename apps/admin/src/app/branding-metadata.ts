import type { Metadata } from "next";
import { currentBrand } from "@lobbystack/shared";

import { loadBranding } from "@/lib/branding";
import { brandLogoSrc, type BrandingSnapshot } from "@/lib/branding-snapshot";

/**
 * The title, description and tab icon every page takes from the deployment's
 * name and logo. A dev or test host whose brand file says so keeps search
 * engines away from every page.
 */
export function brandingMetadata(branding: Pick<BrandingSnapshot, "appName" | "logoUrl">): Metadata {
  const icon = brandLogoSrc(branding);
  return {
    title: branding.appName,
    description: "AI receptionist dashboard",
    ...(icon ? { icons: { icon } } : {}),
    ...(currentBrand().indexing ? {} : { robots: { index: false, follow: false } }),
  };
}

/** Metadata for a layout rendered per request, from the deployment's current branding. */
export async function generateBrandingMetadata(): Promise<Metadata> {
  return brandingMetadata(await loadBranding());
}
