import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LOBBYSTACK_CONTACT_EMAILS,
  brandLinks,
  contactEmailFor,
  invalidBrandLinkVariables,
  normalizeEmailAddress,
  normalizePageUrl,
  normalizeSiteUrl,
  resolveBrandLinks,
} from "./brandLinks";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("normalizeSiteUrl", () => {
  it("keeps http and https sites without the trailing slash", () => {
    expect(normalizeSiteUrl(" https://alloplace.com/ ")).toBe("https://alloplace.com");
    expect(normalizeSiteUrl("https://Example.com/docs/")).toBe("https://example.com/docs");
    expect(normalizeSiteUrl("http://localhost:4321")).toBe("http://localhost:4321");
  });

  it("refuses values a path can't be added to", () => {
    expect(normalizeSiteUrl("alloplace.com")).toBeNull();
    expect(normalizeSiteUrl("ftp://alloplace.com")).toBeNull();
    expect(normalizeSiteUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeSiteUrl("https://user:secret@alloplace.com")).toBeNull();
    expect(normalizeSiteUrl("https://alloplace.com/?ref=app")).toBeNull();
    expect(normalizeSiteUrl("https://alloplace.com/#top")).toBeNull();
    expect(normalizeSiteUrl("   ")).toBeNull();
    expect(normalizeSiteUrl(undefined)).toBeNull();
  });
});

describe("normalizePageUrl", () => {
  it("keeps a page's path, query and fragment", () => {
    expect(normalizePageUrl("https://alloplace.com/legal/terms")).toBe("https://alloplace.com/legal/terms");
    expect(normalizePageUrl("https://example.com/legal?doc=terms#top")).toBe("https://example.com/legal?doc=terms#top");
  });

  it("refuses anything but an http or https URL without credentials", () => {
    expect(normalizePageUrl("/legal/terms")).toBeNull();
    expect(normalizePageUrl("javascript:alert(1)")).toBeNull();
    expect(normalizePageUrl("https://user@alloplace.com/legal/terms")).toBeNull();
  });
});

describe("normalizeEmailAddress", () => {
  it("accepts plain addresses", () => {
    expect(normalizeEmailAddress(" support@alloplace.com ")).toBe("support@alloplace.com");
    expect(normalizeEmailAddress("first.last+help@mail.example.co.uk")).toBe("first.last+help@mail.example.co.uk");
  });

  it("refuses values that would break a mailto: link or a text", () => {
    expect(normalizeEmailAddress("support")).toBeNull();
    expect(normalizeEmailAddress("support@alloplace")).toBeNull();
    expect(normalizeEmailAddress("support@alloplace.com?subject=hi")).toBeNull();
    expect(normalizeEmailAddress("Support <support@alloplace.com>")).toBeNull();
    expect(normalizeEmailAddress("a b@alloplace.com")).toBeNull();
    expect(normalizeEmailAddress(42)).toBeNull();
  });
});

describe("resolveBrandLinks", () => {
  it("links to LobbyStack's site, docs and addresses when nothing is set", () => {
    const links = resolveBrandLinks({});
    expect(links).toEqual({ siteUrl: "https://lobbystack.com", termsUrl: null, privacyUrl: null, docsUrl: "https://docs.lobbystack.com", contactEmail: null });
    expect(contactEmailFor(links, "support")).toBe("support@lobbystack.com");
    expect(contactEmailFor(links, "sales")).toBe("hello@lobbystack.ai");
    expect(contactEmailFor(links, "sms")).toBe("hello@lobbystack.com");
  });

  it("uses the deployment's own links and one address for every purpose", () => {
    const links = resolveBrandLinks({
      NEXT_PUBLIC_LANDING_SITE_URL: "https://alloplace.com",
      NEXT_PUBLIC_TERMS_URL: "https://alloplace.com/legal/terms",
      NEXT_PUBLIC_PRIVACY_URL: "https://alloplace.com/legal/privacy",
      NEXT_PUBLIC_DOCS_SITE_URL: "https://alloplace.com",
      NEXT_PUBLIC_CONTACT_EMAIL: "support@alloplace.com",
    });
    expect(links).toEqual({
      siteUrl: "https://alloplace.com",
      termsUrl: "https://alloplace.com/legal/terms",
      privacyUrl: "https://alloplace.com/legal/privacy",
      docsUrl: "https://alloplace.com",
      contactEmail: "support@alloplace.com",
    });
    for (const purpose of Object.keys(LOBBYSTACK_CONTACT_EMAILS) as Array<keyof typeof LOBBYSTACK_CONTACT_EMAILS>) {
      expect(contactEmailFor(links, purpose)).toBe("support@alloplace.com");
    }
  });

  it("falls back to LobbyStack's link for an empty or unusable value, and names the unusable ones", () => {
    const environment = { NEXT_PUBLIC_LANDING_SITE_URL: "alloplace.com", NEXT_PUBLIC_DOCS_SITE_URL: "", NEXT_PUBLIC_CONTACT_EMAIL: "support at alloplace" };
    expect(resolveBrandLinks(environment)).toMatchObject({ siteUrl: "https://lobbystack.com", docsUrl: "https://docs.lobbystack.com", contactEmail: null });
    expect(invalidBrandLinkVariables(environment)).toEqual(["NEXT_PUBLIC_LANDING_SITE_URL", "NEXT_PUBLIC_CONTACT_EMAIL"]);
    expect(invalidBrandLinkVariables({ NEXT_PUBLIC_LANDING_SITE_URL: "https://alloplace.com", NEXT_PUBLIC_TERMS_URL: "  " })).toEqual([]);
  });
});

describe("brandLinks", () => {
  it("reads the deployment's variables from the environment", () => {
    vi.stubEnv("NEXT_PUBLIC_LANDING_SITE_URL", "https://alloplace.com/");
    vi.stubEnv("NEXT_PUBLIC_CONTACT_EMAIL", "support@alloplace.com");
    expect(brandLinks()).toMatchObject({ siteUrl: "https://alloplace.com", docsUrl: "https://docs.lobbystack.com", contactEmail: "support@alloplace.com" });
  });
});
