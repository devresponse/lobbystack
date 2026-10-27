import { forgetCachedDeploymentAppName, getSavedBranding } from "@lobbystack/domain";
import { brandFileMatched, currentBrand, resolveBranding, type Branding } from "@lobbystack/shared";

import { getAppDatabase } from "./api-helpers";
import type { BrandingSnapshot } from "./branding-snapshot";
import { reportServerError } from "./error-reporting";

// Long enough to spare the database a read on every page, short enough that
// another admin instance soon shows what onboarding saved.
const BRANDING_CACHE_MS = 30_000;
const FAILURE_REPORT_INTERVAL_MS = 60_000;

let cached: { promise: Promise<Branding>; expiresAt: number } | undefined;
let lastFailureReportAt = 0;

async function readBranding(): Promise<Branding> {
  const brand = currentBrand();
  // The database can't change what a brand file sets, so skip it then.
  const saved = brandFileMatched(brand) ? null : await getSavedBranding(getAppDatabase().db);
  return resolveBranding({ saved, brand });
}

/**
 * The deployment's name and logo: the brand file the deployment picks by its
 * domain, BRAND_PRESET or as the only brand besides LobbyStack, then what
 * onboarding saved, then LobbyStack. When the database can't be read, pages
 * still render with the brand file's choice.
 */
export async function loadBranding(): Promise<Branding> {
  const now = Date.now();
  if (!cached || cached.expiresAt <= now) cached = { promise: readBranding(), expiresAt: now + BRANDING_CACHE_MS };
  const entry = cached;
  try {
    return await entry.promise;
  } catch (error) {
    if (cached === entry) cached = undefined;
    if (now - lastFailureReportAt >= FAILURE_REPORT_INTERVAL_MS) {
      lastFailureReportAt = now;
      void reportServerError(error, { operation: "load_branding" });
    }
    return resolveBranding({ saved: null, brand: currentBrand() });
  }
}

/** Drops the cached branding, so the next page shows what was just saved. */
export function forgetCachedBranding(): void {
  cached = undefined;
  forgetCachedDeploymentAppName();
}

export function brandingSnapshot(branding: Pick<Branding, "appName" | "logoUrl">): BrandingSnapshot {
  return { appName: branding.appName, logoUrl: branding.logoUrl, final: true };
}

/**
 * What a prerendered page can know when it's built: the build's brand file.
 * It's final when a brand file matched; otherwise the browser asks the server
 * what onboarding saved.
 */
export function buildTimeBrandingSnapshot(): BrandingSnapshot {
  const brand = currentBrand();
  const branding = resolveBranding({ saved: null, brand });
  return { appName: branding.appName, logoUrl: branding.logoUrl, final: brandFileMatched(brand) };
}
