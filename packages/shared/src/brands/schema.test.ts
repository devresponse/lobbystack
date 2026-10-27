import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { compileBrands, type BrandSources } from "./schema";

const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>');

// The start of a PNG: its signature and the IHDR chunk that holds its size.
function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

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

  it("compiles the email logo and share image with their sizes", () => {
    const withImages = sources();
    withImages.brands.alloplace!.file = { appName: "AlloPlace", emailLogo: "logo-email.png", ogImage: "og.png" };
    withImages.brands.alloplace!.assets = { "logo-email.png": png(96, 96), "og.png": png(1200, 630) };
    const compiled = compileBrands(withImages);
    expect(compiled.brands.alloplace!.emailLogo).toMatchObject({ width: 96, height: 96, url: expect.stringMatching(/^\/brand\/alloplace\/logo-email\.png\?v=[0-9a-f]{12}$/) });
    expect(compiled.brands.alloplace!.ogImage).toMatchObject({ width: 1200, height: 630, url: expect.stringMatching(/^\/brand\/alloplace\/og\.png\?v=/) });
    expect(Object.keys(compiled.publicAssets).sort()).toEqual(["/brand/alloplace/logo-email.png", "/brand/alloplace/og.png"]);
    expect(compiled.brands.lobbystack).toMatchObject({ emailLogo: null, ogImage: null });
  });

  it("takes only a PNG for the email logo and share image", () => {
    const run = (assets: Record<string, Uint8Array>, file: object) => () => {
      const broken = sources();
      broken.brands.alloplace!.file = { appName: "AlloPlace", ...file };
      broken.brands.alloplace!.assets = assets;
      return compileBrands(broken);
    };
    expect(run({}, { emailLogo: "logo.svg" })).toThrow('emailLogo: a .png file');
    expect(run({ "logo-email.png": svg }, { emailLogo: "logo-email.png" })).toThrow("logo-email.png must be a PNG of 256 KB or less");
    expect(run({ "og.png": png(1200, 630).subarray(0, 20) }, { ogImage: "og.png" })).toThrow("og.png has no readable size");
    expect(run({}, { ogImage: "og.png" })).toThrow("brands/alloplace/og.png does not exist");
  });

  it("checks and hashes a billing.json, naming its file and path in any problem", () => {
    const billing = JSON.parse(readFileSync(new URL("../../../../brands/alloplace/billing.json", import.meta.url), "utf8"));
    const withBilling = sources();
    withBilling.brands.alloplace!.billing = billing;
    const compiled = compileBrands(withBilling);
    expect(Object.keys(compiled.billingHashes)).toEqual(["alloplace"]);
    expect(compiled.billingHashes.alloplace).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(compiled.billingPlans)).toEqual(["alloplace"]);
    // The hash covers the checked file, not its formatting or its $schema.
    withBilling.brands.alloplace!.billing = { ...billing, $schema: "elsewhere.json" };
    expect(compileBrands(withBilling).billingHashes).toEqual(compiled.billingHashes);
    withBilling.brands.alloplace!.billing = { ...billing, currency: "CAD", plans: { ...billing.plans, starter: { ...billing.plans.starter, prices: { annualCents: 1 } }, Promo: {} } };
    const run = () => compileBrands(withBilling);
    expect(run).toThrow("brands/alloplace/billing.json currency: three lowercase letters");
    expect(run).toThrow("brands/alloplace/billing.json plans.Promo.tier");
    expect(compileBrands(sources()).billingHashes).toEqual({});
    expect(compileBrands(sources()).billingPlans).toEqual({});
  });

  it("carries a billing.json's four standard plans as an apply writes them, without its other plans", () => {
    const billing = JSON.parse(readFileSync(new URL("../../../../brands/alloplace/billing.json", import.meta.url), "utf8"));
    const withBilling = sources();
    withBilling.brands.alloplace!.billing = {
      ...billing,
      plans: {
        ...billing.plans,
        starter: { ...billing.plans.starter, prices: { monthlyCents: 3700, annualCents: 37_000 }, included: { ...billing.plans.starter.included, voiceMinutes: 200 } },
        "salons-plus": { tier: "starter", access: "code", sold: true, names: { en: "Salons Plus", fr: "Salons Plus", es: "Salons Plus", sr: "Salons Plus" }, prices: { monthlyCents: 3000 } },
      },
    };
    const plans = compileBrands(withBilling).billingPlans.alloplace!;
    expect(plans.map((plan) => plan.code)).toEqual(["free_cloud", "starter", "pro", "enterprise"]);
    expect(plans[1]).toEqual({
      code: "starter", sold: true, custom: false, overage: true,
      voice_sec: 12_000, sms_seg: billing.plans.starter.included.alertSmsSegments, calls_out: billing.plans.starter.included.outboundCallAttempts, chat_units: billing.plans.starter.included.chatAiUnits,
      kb_bytes: billing.plans.starter.limits.knowledgeStorageMb * 1_048_576, numbers: billing.plans.starter.limits.businessNumbers,
      voice_rate: billing.plans.starter.overageCents.voiceMinute, sms_rate: billing.plans.starter.overageCents.alertSmsSegment, call_rate: billing.plans.starter.overageCents.outboundCallAttempt,
      sort: 20,
      prices: [{ period: "annual", currency: billing.currency, cents: 37_000 }, { period: "monthly", currency: billing.currency, cents: 3700 }],
    });
    expect(plans[3]).toMatchObject({ code: "enterprise", sold: false, custom: true, voice_sec: null, prices: [] });
  });

  it("keeps a name with its environment suffix within the length limit", () => {
    const long = sources();
    long.brands.alloplace!.file = { appName: "x".repeat(38), environments: { "dev*": { appNameSuffix: " (dev)" } } };
    expect(() => compileBrands(long)).toThrow("must stay within 40 visible characters");
  });
});
