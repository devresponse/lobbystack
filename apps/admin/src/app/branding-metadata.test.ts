import { afterEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ appBaseUrl: "http://localhost", preset: null as string | null }));
vi.mock("@lobbystack/shared", async (importOriginal) => {
  const shared = await importOriginal<typeof import("@lobbystack/shared")>();
  return { ...shared, currentBrand: () => shared.resolveBrand({ appBaseUrl: fixture.appBaseUrl, preset: fixture.preset }) };
});
vi.mock("@/lib/branding", () => ({ loadBranding: vi.fn() }));

import { brandingMetadata } from "./branding-metadata";

const branding = { appName: "AlloPlace", logoUrl: "/brand/alloplace/logo.svg?v=1" };

afterEach(() => {
  fixture.appBaseUrl = "http://localhost";
  fixture.preset = null;
});

describe("brandingMetadata", () => {
  it("gives link previews the brand's share image under the deployment's address", () => {
    fixture.appBaseUrl = "https://demo.alloplace.com";
    const metadata = brandingMetadata(branding);
    expect(metadata.openGraph).toEqual({
      siteName: "AlloPlace",
      images: [{ url: expect.stringMatching(/^https:\/\/demo\.alloplace\.com\/brand\/alloplace\/og\.png\?v=[0-9a-f]{12}$/), width: 1200, height: 630, alt: "AlloPlace" }],
    });
    expect(metadata.twitter).toMatchObject({ card: "summary_large_image" });
    expect(metadata.robots).toBeUndefined();
  });

  it("keeps search engines off a dev host", () => {
    fixture.appBaseUrl = "https://dev01.alloplace.com";
    expect(brandingMetadata(branding).robots).toEqual({ index: false, follow: false });
  });

  it("gives an address no brand claims the preview of the brand BRAND_PRESET names", () => {
    fixture.preset = "realinfobot";
    expect(brandingMetadata({ appName: "RealInfoBot", logoUrl: null }).openGraph).toMatchObject({ siteName: "RealInfoBot", images: [{ url: expect.stringMatching(/^http:\/\/localhost\/brand\/realinfobot\/og\.png\?v=/), alt: "RealInfoBot" }] });
  });

  it("adds no preview on an address no brand claims without BRAND_PRESET, since LobbyStack stands in", () => {
    expect(brandingMetadata({ appName: "LobbyStack", logoUrl: null })).not.toHaveProperty("openGraph");
  });

  it("adds no preview for a brand without a share image", () => {
    fixture.preset = "lobbystack";
    expect(brandingMetadata({ appName: "LobbyStack", logoUrl: null })).not.toHaveProperty("openGraph");
  });
});
