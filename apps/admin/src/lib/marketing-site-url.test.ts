import { afterEach, describe, expect, it, vi } from "vitest";

import type { ResolvedBrand } from "@lobbystack/shared";

// The links of the deployment's brand: none of its own, unless a test gives some.
const brand = vi.hoisted(() => ({ links: {} as Partial<ResolvedBrand["links"]> }));
vi.mock("@lobbystack/shared", async (importOriginal) => {
  const shared = await importOriginal<typeof import("@lobbystack/shared")>();
  return { ...shared, brandLinks: () => shared.resolveBrandLinks({ siteUrl: null, termsUrl: null, privacyUrl: null, docsUrl: null, contactEmail: null, ...brand.links }) };
});

import { affiliateTermsHref, localizeMarketingHref, privacyHref, termsHref } from "./marketing-site-url";

afterEach(() => {
  brand.links = {};
});

it("points legal links at the translated marketing pages", () => {
  expect(localizeMarketingHref("en", "/terms")).toBe("https://lobbystack.com/terms/");
  expect(localizeMarketingHref("fr", "/terms")).toBe("https://lobbystack.com/fr/terms/");
  expect(localizeMarketingHref("en", "/privacy")).toBe("https://lobbystack.com/privacy/");
  expect(localizeMarketingHref("fr", "/privacy")).toBe("https://lobbystack.com/fr/privacy/");
  expect(termsHref("fr")).toBe("https://lobbystack.com/fr/terms/");
  expect(privacyHref("en")).toBe("https://lobbystack.com/privacy/");
  expect(affiliateTermsHref("fr")).toBe("https://lobbystack.com/fr/terms/#affiliate-program");
});

it("leaves external and untranslated targets alone when the locale is English", () => {
  expect(localizeMarketingHref("en", "mailto:support@lobbystack.com")).toBe("mailto:support@lobbystack.com");
  expect(localizeMarketingHref("en", "#pricing")).toBe("#pricing");
  expect(localizeMarketingHref("en", "/status")).toBe("https://lobbystack.com/status/");
});

describe("a deployment's own site", () => {
  it("keeps each path on the deployment's domain, in every language", () => {
    brand.links = { siteUrl: "https://alloplace.com" };
    expect(localizeMarketingHref("en", "/")).toBe("https://alloplace.com/");
    expect(localizeMarketingHref("fr", "/")).toBe("https://alloplace.com/");
    expect(termsHref("sr")).toBe("https://alloplace.com/terms");
    expect(privacyHref("es")).toBe("https://alloplace.com/privacy");
    expect(affiliateTermsHref("fr")).toBe("https://alloplace.com/terms/#affiliate-program");
  });

  it("keeps the path of a site served under one", () => {
    brand.links = { siteUrl: "https://example.com/receptionist" };
    expect(localizeMarketingHref("fr", "/")).toBe("https://example.com/receptionist/");
    expect(termsHref("en")).toBe("https://example.com/receptionist/terms");
  });

  it("opens the deployment's own terms and privacy pages", () => {
    brand.links = { siteUrl: "https://alloplace.com", termsUrl: "https://alloplace.com/legal/terms", privacyUrl: "https://alloplace.com/legal/privacy" };
    for (const locale of ["en", "fr", "es", "sr"] as const) {
      expect(termsHref(locale)).toBe("https://alloplace.com/legal/terms");
      expect(privacyHref(locale)).toBe("https://alloplace.com/legal/privacy");
      expect(affiliateTermsHref(locale)).toBe("https://alloplace.com/legal/terms");
    }
  });
});
