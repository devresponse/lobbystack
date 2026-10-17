import { describe, expect, it } from "vitest";

import { compileBrands, type BrandSources } from "./schema";

const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>');

function sources(overrides: { index?: unknown; brands?: BrandSources["brands"] } = {}): BrandSources {
  return {
    index: overrides.index ?? { default: "lobbystack", domains: { "alloplace.com": "alloplace" } },
    brands: overrides.brands ?? {
      lobbystack: { file: { appName: "LobbyStack" }, assets: {} },
      alloplace: { file: { appName: "AlloPlace", logo: "logo.svg", accentColor: "#FD0", links: { site: "https://alloplace.com/" }, contactEmail: "support@alloplace.com" }, assets: { "logo.svg": svg } },
    },
  };
}

describe("compileBrands", () => {
  it("normalizes each brand and versions its logo by content", () => {
    const compiled = compileBrands(sources());
    expect(compiled.brands.alloplace).toMatchObject({
      appName: "AlloPlace",
      accentColor: "#ffdd00",
      links: { siteUrl: "https://alloplace.com", termsUrl: null, contactEmail: "support@alloplace.com" },
      environments: [],
    });
    expect(compiled.brands.alloplace!.logoUrl).toMatch(/^\/brand\/alloplace\/logo\.svg\?v=[0-9a-f]{12}$/);
    expect(Object.keys(compiled.publicAssets)).toEqual(["/brand/alloplace/logo.svg"]);
    expect(compiled.brands.lobbystack!.logoUrl).toBeNull();
  });

  it("lists every problem at once", () => {
    const run = () => compileBrands(sources({
      index: { default: "missing", domains: { "Alloplace.com": "alloplace", "dev.alloplace.com": "ghost" } },
      brands: {
        alloplace: { file: { appName: "x".repeat(41), logo: "logo.svg", accentColor: "yellow", links: { site: "ftp://x" }, colour: "#fff" }, assets: {} },
      },
    }));
    expect(run).toThrow(/brands\/index\.json domains/);
    expect(run).toThrow(/brands\/alloplace\/brand\.json appName/);
    expect(run).toThrow(/accentColor/);
    expect(run).toThrow(/links\.site/);
  });

  it("refuses a missing or unsafe logo", () => {
    const missing = sources();
    missing.brands.alloplace!.assets = {};
    expect(() => compileBrands(missing)).toThrow("brands/alloplace/logo.svg does not exist");
    const unsafe = sources();
    unsafe.brands.alloplace!.assets = { "logo.svg": new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>') };
    expect(() => compileBrands(unsafe)).toThrow("must be a PNG, JPEG, WebP or a plain SVG");
  });

  it("refuses a missing default, a claim with no folder and overlapping claims", () => {
    expect(() => compileBrands(sources({ index: { default: "nobody", domains: {} } }))).toThrow("default: no folder brands/nobody");
    expect(() => compileBrands(sources({ index: { default: "lobbystack", domains: { "realinfobot.com": "realinfobot" } } }))).toThrow("no folder brands/realinfobot");
    expect(() => compileBrands(sources({ index: { default: "lobbystack", domains: { "alloplace.com": "alloplace", "dev.alloplace.com": "lobbystack" } } }))).toThrow("already covered by alloplace.com");
  });

  it("keeps a name with its environment suffix within the length limit", () => {
    const long = sources();
    long.brands.alloplace!.file = { appName: "x".repeat(38), environments: { "dev*": { appNameSuffix: " (dev)" } } };
    expect(() => compileBrands(long)).toThrow("must stay within 40 visible characters");
  });
});
