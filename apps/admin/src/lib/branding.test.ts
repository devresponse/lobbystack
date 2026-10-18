import { afterEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ appBaseUrl: "http://localhost", saved: vi.fn(), canSave: vi.fn() }));
vi.mock("@lobbystack/shared", async (importOriginal) => {
  const shared = await importOriginal<typeof import("@lobbystack/shared")>();
  return { ...shared, currentBrand: () => shared.resolveBrand({ appBaseUrl: fixture.appBaseUrl }) };
});
vi.mock("@lobbystack/domain", () => ({ getSavedBranding: fixture.saved, canSaveInitialBranding: fixture.canSave, forgetCachedDeploymentAppName: () => undefined }));
vi.mock("./api-helpers", () => ({ getAppDatabase: () => ({ db: {} }) }));
vi.mock("./error-reporting", () => ({ reportServerError: async () => undefined }));

import { buildTimeBrandingSnapshot, forgetCachedBranding, loadBranding } from "./branding";
import { asksInitialBranding } from "./onboarding-branding";

afterEach(() => {
  fixture.appBaseUrl = "http://localhost";
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

describe("branding on a deployment no brand file matches", () => {
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
