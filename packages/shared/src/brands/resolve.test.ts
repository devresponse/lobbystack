import { describe, expect, it } from "vitest";

import { brandFileMatched, brandHost, brandImage, brandStartupReport, claimedDomain, resolveBrand, type BrandData } from "./resolve";
import type { BrandDefinition } from "./types";

const links = { siteUrl: null, termsUrl: null, privacyUrl: null, docsUrl: null, contactEmail: null };

function brand(id: string, appName: string, environments: BrandDefinition["environments"] = []): BrandDefinition {
  return { id, appName, logoUrl: `/brand/${id}/logo.svg?v=1`, emailLogo: null, ogImage: null, accentColor: null, links, environments };
}

const data: BrandData = {
  index: { default: "lobbystack", domains: { "alloplace.com": "alloplace", "realinfobot.com": "realinfobot", "realinfobot.co.uk": "realinfobot" } },
  brands: {
    lobbystack: brand("lobbystack", "LobbyStack"),
    alloplace: brand("alloplace", "AlloPlace", [
      { pattern: "dev*", appNameSuffix: " (dev)", indexing: false },
      { pattern: "staging", appNameSuffix: null, indexing: false },
    ]),
    realinfobot: brand("realinfobot", "RealInfoBot"),
  },
};

describe("brandHost", () => {
  it("lowercases the host and drops the port, path and trailing dot", () => {
    expect(brandHost("https://Demo.AlloPlace.com:8443/sign-in")).toBe("demo.alloplace.com");
    expect(brandHost("https://demo.alloplace.com./")).toBe("demo.alloplace.com");
    expect(brandHost("https://bücher.example")).toBe("xn--bcher-kva.example");
  });

  it("is null for anything that isn't a URL", () => {
    expect(brandHost(undefined)).toBeNull();
    expect(brandHost(" ")).toBeNull();
    expect(brandHost("demo.alloplace.com")).toBeNull();
  });
});

describe("claimedDomain", () => {
  it("matches whole labels only", () => {
    expect(claimedDomain("dev01.alloplace.com", data.index.domains)).toBe("alloplace.com");
    expect(claimedDomain("alloplace.com", data.index.domains)).toBe("alloplace.com");
    expect(claimedDomain("dev01.realinfobot.co.uk", data.index.domains)).toBe("realinfobot.co.uk");
    expect(claimedDomain("notalloplace.com", data.index.domains)).toBeNull();
    expect(claimedDomain("alloplace.com.evil.example", data.index.domains)).toBeNull();
  });

  it("claims nothing for a bare suffix, an address or a platform host", () => {
    expect(claimedDomain("com", data.index.domains)).toBeNull();
    expect(claimedDomain("localhost", data.index.domains)).toBeNull();
    expect(claimedDomain("127.0.0.1", data.index.domains)).toBeNull();
    expect(claimedDomain("admin-production.up.railway.app", data.index.domains)).toBeNull();
  });
});

describe("resolveBrand", () => {
  it("picks the brand that claims the apex of APP_BASE_URL", () => {
    expect(resolveBrand({ appBaseUrl: "https://demo.alloplace.com" }, data)).toMatchObject({ id: "alloplace", source: "apex", domain: "alloplace.com", appName: "AlloPlace", indexing: true });
    expect(resolveBrand({ appBaseUrl: "https://test01.realinfobot.com" }, data)).toMatchObject({ id: "realinfobot", source: "apex" });
    expect(brandFileMatched(resolveBrand({ appBaseUrl: "https://alloplace.com" }, data))).toBe(true);
  });

  it("lets the domain win over BRAND_PRESET, and says the preset was ignored", () => {
    expect(resolveBrand({ appBaseUrl: "https://dev01.realinfobot.com", preset: "alloplace" }, data)).toMatchObject({ id: "realinfobot", source: "apex", ignoredPreset: "alloplace", unknownPreset: null });
  });

  it("uses BRAND_PRESET where no brand claims the domain", () => {
    expect(resolveBrand({ appBaseUrl: "http://localhost:3000", preset: " alloplace " }, data)).toMatchObject({ id: "alloplace", source: "preset", ignoredPreset: null });
    expect(resolveBrand({ appBaseUrl: "https://admin-production.up.railway.app", preset: "realinfobot" }, data)).toMatchObject({ id: "realinfobot", source: "preset" });
  });

  it("falls back to the default brand and reports a preset that names no brand", () => {
    const fallback = resolveBrand({ appBaseUrl: "http://localhost", preset: "nope" }, data);
    expect(fallback).toMatchObject({ id: "lobbystack", source: "default", appName: "LobbyStack", unknownPreset: "nope" });
    expect(brandFileMatched(fallback)).toBe(false);
    expect(resolveBrand({}, data)).toMatchObject({ id: "lobbystack", source: "default", host: null });
  });

  it("applies the environment settings of a matching first label", () => {
    expect(resolveBrand({ appBaseUrl: "https://dev01.alloplace.com" }, data)).toMatchObject({ appName: "AlloPlace (dev)", indexing: false });
    expect(resolveBrand({ appBaseUrl: "https://staging.alloplace.com" }, data)).toMatchObject({ appName: "AlloPlace", indexing: false });
    expect(resolveBrand({ appBaseUrl: "https://stagingx.alloplace.com" }, data)).toMatchObject({ appName: "AlloPlace", indexing: true });
    // The apex itself has no first label to match.
    expect(resolveBrand({ appBaseUrl: "https://alloplace.com" }, data)).toMatchObject({ appName: "AlloPlace", indexing: true });
  });

  it("keeps the address's origin for absolute links", () => {
    expect(resolveBrand({ appBaseUrl: "https://demo.alloplace.com/sign-in" }, data).origin).toBe("https://demo.alloplace.com");
    expect(resolveBrand({ appBaseUrl: "http://localhost:3000" }, data).origin).toBe("http://localhost:3000");
    expect(resolveBrand({ appBaseUrl: "mailto:support@alloplace.com" }, data).origin).toBeNull();
    expect(resolveBrand({}, data).origin).toBeNull();
  });

  it("resolves the committed brands", () => {
    expect(resolveBrand({ appBaseUrl: "https://demo.alloplace.com" })).toMatchObject({ id: "alloplace", appName: "AlloPlace", accentColor: "#ffd100", links: { siteUrl: "https://alloplace.com", contactEmail: "support@alloplace.com" } });
    expect(resolveBrand({ appBaseUrl: "http://localhost:3000" })).toMatchObject({ id: "lobbystack", appName: "LobbyStack", logoUrl: null, emailLogo: null, ogImage: null });
  });
});

describe("brandImage", () => {
  const logo = { url: "/brand/alloplace/logo-email.png?v=1", width: 96, height: 96 };

  it("puts an image under the deployment's address", () => {
    expect(brandImage(resolveBrand({ appBaseUrl: "https://demo.alloplace.com/" }, data), logo)).toEqual({ ...logo, url: "https://demo.alloplace.com/brand/alloplace/logo-email.png?v=1" });
  });

  it("is null without an image or an address", () => {
    expect(brandImage(resolveBrand({ appBaseUrl: "https://demo.alloplace.com" }, data), null)).toBeNull();
    expect(brandImage(resolveBrand({}, data), logo)).toBeNull();
  });
});

describe("brandStartupReport", () => {
  it("warns about ignored and unknown presets", () => {
    expect(brandStartupReport(resolveBrand({ appBaseUrl: "https://demo.alloplace.com", preset: "realinfobot" }, data), {}).warnings).toEqual([
      "[brand] brand.preset_ignored: BRAND_PRESET=realinfobot has no effect, because alloplace.com belongs to the alloplace brand.",
    ]);
    expect(brandStartupReport(resolveBrand({ appBaseUrl: "http://localhost", preset: "nope" }, data), {}).warnings[0]).toContain("brand.preset_unknown");
  });

  it("warns in production when no brand claims the address", () => {
    const unmatched = resolveBrand({ appBaseUrl: "https://app.example.com" }, data);
    expect(brandStartupReport(unmatched, { NODE_ENV: "production" }).warnings).toEqual(["[brand] brand.unmatched: no brand in brands/index.json claims app.example.com, so the default lobbystack brand stands in."]);
    expect(brandStartupReport(unmatched, { NODE_ENV: "development" }).warnings).toEqual([]);
  });

  it("refuses to start under BRAND_REQUIRED=true only when no brand file matched", () => {
    expect(brandStartupReport(resolveBrand({ appBaseUrl: "https://app.example.com" }, data), { BRAND_REQUIRED: "true" }).error).toContain("BRAND_REQUIRED=true");
    expect(brandStartupReport(resolveBrand({ appBaseUrl: "https://demo.alloplace.com" }, data), { BRAND_REQUIRED: "true" }).error).toBeNull();
    expect(brandStartupReport(resolveBrand({ appBaseUrl: "http://localhost", preset: "alloplace" }, data), { BRAND_REQUIRED: "true" }).error).toBeNull();
  });

  it("warns while a variable that will go away is still set", () => {
    const brand = resolveBrand({ appBaseUrl: "https://demo.alloplace.com" }, data);
    expect(brandStartupReport(brand, { BRAND_APP_NAME: "AlloPlace", NEXT_PUBLIC_TERMS_URL: "https://alloplace.com/legal/terms", BRAND_LOGO_URL: " " }).warnings).toEqual([
      "[brand] brand.deprecated_variables: BRAND_APP_NAME, NEXT_PUBLIC_TERMS_URL still override the brand file, but will be removed in a later release. Put the values in a folder under brands/ instead.",
    ]);
    expect(brandStartupReport(brand, {}).warnings).toEqual([]);
  });

  it("names the brand and how it was chosen", () => {
    expect(brandStartupReport(resolveBrand({ appBaseUrl: "https://dev01.alloplace.com" }, data), {}).info).toBe("[brand] alloplace (apex alloplace.com), shown as AlloPlace (dev)");
  });
});
