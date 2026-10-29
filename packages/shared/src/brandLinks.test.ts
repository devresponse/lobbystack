import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LOBBYSTACK_CONTACT_EMAILS,
  contactEmailFor,
  normalizeEmailAddress,
  normalizePageUrl,
  normalizeSiteUrl,
  normalizeZapierUrl,
  resolveBrandLinks,
} from "./brandLinks";
import { resolveBrand } from "./brands/resolve";

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

describe("normalizeZapierUrl", () => {
  it("keeps an invite link or a directory page on zapier.com", () => {
    expect(normalizeZapierUrl(" https://zapier.com/developer/public-invite/123456/0a1b2c3d4e5f/ ")).toBe("https://zapier.com/developer/public-invite/123456/0a1b2c3d4e5f/");
    expect(normalizeZapierUrl("https://zapier.com/apps/alloplace/integrations")).toBe("https://zapier.com/apps/alloplace/integrations");
    expect(normalizeZapierUrl("https://developer.zapier.com/app/123456")).toBe("https://developer.zapier.com/app/123456");
  });

  it("refuses any other site, plain http and credentials", () => {
    expect(normalizeZapierUrl("http://zapier.com/apps/alloplace/integrations")).toBeNull();
    expect(normalizeZapierUrl("https://notzapier.com/apps/alloplace")).toBeNull();
    expect(normalizeZapierUrl("https://zapier.com.example.com/apps/alloplace")).toBeNull();
    expect(normalizeZapierUrl("https://user@zapier.com/apps/alloplace")).toBeNull();
    expect(normalizeZapierUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeZapierUrl(undefined)).toBeNull();
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
  it("links to LobbyStack's site, docs and addresses without a brand", () => {
    const links = resolveBrandLinks();
    expect(links).toEqual({ siteUrl: "https://lobbystack.com", termsUrl: null, privacyUrl: null, docsUrl: "https://docs.lobbystack.com", contactEmail: null, zapierUrl: null });
    expect(contactEmailFor(links, "support")).toBe("support@lobbystack.com");
    expect(contactEmailFor(links, "sales")).toBe("hello@lobbystack.ai");
    expect(contactEmailFor(links, "sms")).toBe("hello@lobbystack.com");
  });

  it("uses the brand's own links and one address for every purpose", () => {
    const links = resolveBrandLinks(resolveBrand({ appBaseUrl: "https://demo.alloplace.com" }).links);
    expect(links).toEqual({
      siteUrl: "https://alloplace.com",
      termsUrl: "https://alloplace.com/legal/terms",
      privacyUrl: "https://alloplace.com/legal/privacy",
      docsUrl: "https://alloplace.com",
      contactEmail: "support@alloplace.com",
      zapierUrl: "https://zapier.com/developer/public-invite/248757/519757/3b7d782a7813340d4cbcb4f8fa6f3294/",
    });
    for (const purpose of Object.keys(LOBBYSTACK_CONTACT_EMAILS) as Array<keyof typeof LOBBYSTACK_CONTACT_EMAILS>) {
      expect(contactEmailFor(links, purpose)).toBe("support@alloplace.com");
    }
  });

  it("fills in LobbyStack's site and docs where the brand has none, but never a Zapier link", () => {
    expect(resolveBrandLinks({ siteUrl: null, termsUrl: "https://example.com/terms", privacyUrl: null, docsUrl: null, contactEmail: null, zapierUrl: null })).toEqual({
      siteUrl: "https://lobbystack.com",
      termsUrl: "https://example.com/terms",
      privacyUrl: null,
      docsUrl: "https://docs.lobbystack.com",
      contactEmail: null,
      zapierUrl: null,
    });
    expect(resolveBrandLinks({ siteUrl: null, termsUrl: null, privacyUrl: null, docsUrl: null, contactEmail: null, zapierUrl: "https://zapier.com/apps/example/integrations" }).zapierUrl).toBe("https://zapier.com/apps/example/integrations");
  });
});

describe("brandLinks", () => {
  it("follows the brand the deployment's address picks", async () => {
    // The brand is resolved once per process, so this test loads the module afresh.
    vi.resetModules();
    vi.stubEnv("APP_BASE_URL", "https://demo.alloplace.com");
    const fresh = await import("./brandLinks");
    expect(fresh.brandLinks()).toMatchObject({ siteUrl: "https://alloplace.com", docsUrl: "https://alloplace.com", contactEmail: "support@alloplace.com" });
  });
});
