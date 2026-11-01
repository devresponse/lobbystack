import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ appBaseUrl: "http://localhost", preset: null as string | null, unbranded: false, oneBrand: false, saved: vi.fn(), canSave: vi.fn() }));
vi.mock("@lobbystack/shared", async (importOriginal) => {
  const shared = await importOriginal<typeof import("@lobbystack/shared")>();
  return {
    ...shared,
    currentBrand: () => {
      // An unbranded copy of the code has no brand besides LobbyStack, so nothing picks a brand file.
      if (fixture.unbranded) return { ...shared.resolveBrand({ appBaseUrl: fixture.appBaseUrl, preset: "lobbystack" }), source: "default" };
      // A copy with one brand besides LobbyStack shows it on every address.
      if (fixture.oneBrand) return { ...shared.resolveBrand({ appBaseUrl: fixture.appBaseUrl, preset: "alloplace" }), source: "only" };
      return shared.resolveBrand({ appBaseUrl: fixture.appBaseUrl, preset: fixture.preset });
    },
  };
});
vi.mock("@lobbystack/domain", () => ({ getSavedBranding: fixture.saved, canSaveInitialBranding: fixture.canSave, forgetCachedDeploymentAppName: () => undefined }));
vi.mock("./api-helpers", () => ({ getAppDatabase: () => ({ db: {} }) }));
vi.mock("./error-reporting", () => ({ reportServerError: async () => undefined }));

import { buildTimeBrandingSnapshot, forgetCachedBranding, loadBranding } from "./branding";
import { asksInitialBranding } from "./onboarding-branding";

afterEach(() => {
  fixture.appBaseUrl = "http://localhost";
  fixture.preset = null;
  fixture.unbranded = false;
  fixture.oneBrand = false;
  forgetCachedBranding();
  vi.clearAllMocks();
});

describe("branding on a deployment a brand file matches", () => {
  it("shows the brand file's name and logo without reading the database", async () => {
    fixture.appBaseUrl = "https://demo.alloplace.com";
    const branding = await loadBranding();
    expect(branding).toMatchObject({ appName: "AlloPlace", sources: { appName: "file", logoUrl: "file" } });
    expect(branding.logoUrl).toMatch(/^\/brand\/alloplace\/logo\.svg\?v=/);
    expect(fixture.saved).not.toHaveBeenCalled();
  });

  it("prerenders the brand as final, so the browser needn't ask", () => {
    fixture.appBaseUrl = "https://demo.alloplace.com";
    expect(buildTimeBrandingSnapshot()).toMatchObject({ appName: "AlloPlace", final: true });
  });

  it("skips the onboarding brand step", async () => {
    fixture.appBaseUrl = "https://demo.alloplace.com";
    fixture.canSave.mockResolvedValue(true);
    expect(await asksInitialBranding("owner")).toBe(false);
    expect(fixture.canSave).not.toHaveBeenCalled();
  });
});

describe("branding on an address no brand claims, with one brand besides LobbyStack", () => {
  beforeEach(() => {
    fixture.oneBrand = true;
  });

  it("shows that brand without reading the database", async () => {
    expect(await loadBranding()).toMatchObject({ appName: "AlloPlace", sources: { appName: "file", logoUrl: "file" } });
    expect(fixture.saved).not.toHaveBeenCalled();
  });

  it("prerenders it as final", () => {
    expect(buildTimeBrandingSnapshot()).toMatchObject({ appName: "AlloPlace", final: true });
  });

  it("skips the onboarding brand step", async () => {
    fixture.canSave.mockResolvedValue(true);
    expect(await asksInitialBranding("owner")).toBe(false);
    expect(fixture.canSave).not.toHaveBeenCalled();
  });
});

describe("branding on an address no brand claims, with AlloPlace and RealInfoBot besides LobbyStack", () => {
  it("shows the brand BRAND_PRESET names without reading the database", async () => {
    fixture.preset = "realinfobot";
    const branding = await loadBranding();
    expect(branding).toMatchObject({ appName: "RealInfoBot", sources: { appName: "file", logoUrl: "file" } });
    expect(branding.logoUrl).toMatch(/^\/brand\/realinfobot\/logo\.svg\?v=/);
    expect(buildTimeBrandingSnapshot()).toMatchObject({ appName: "RealInfoBot", final: true });
    expect(fixture.saved).not.toHaveBeenCalled();
  });

  it("shows what onboarding saved and keeps its brand step open without BRAND_PRESET", async () => {
    fixture.saved.mockResolvedValue({ appName: "Acme Desk", logoVersion: null });
    fixture.canSave.mockResolvedValue(true);
    expect(await loadBranding()).toMatchObject({ appName: "Acme Desk", sources: { appName: "database" } });
    expect(await asksInitialBranding("owner")).toBe(true);
  });
});

describe("branding in a copy of the code with no brand besides LobbyStack", () => {
  beforeEach(() => {
    fixture.unbranded = true;
  });

  it("shows what onboarding saved", async () => {
    fixture.saved.mockResolvedValue({ appName: "Acme Desk", logoVersion: null });
    expect(await loadBranding()).toMatchObject({ appName: "Acme Desk", sources: { appName: "database" } });
  });

  it("prerenders LobbyStack for now and lets the browser ask the server", () => {
    expect(buildTimeBrandingSnapshot()).toEqual({ appName: "LobbyStack", logoUrl: null, final: false });
  });

  it("keeps the onboarding brand step open", async () => {
    fixture.canSave.mockResolvedValue(true);
    expect(await asksInitialBranding("owner")).toBe(true);
  });
});
