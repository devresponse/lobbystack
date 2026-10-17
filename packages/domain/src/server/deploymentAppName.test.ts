import { afterEach, describe, expect, it, vi } from "vitest";

import type { Database } from "@lobbystack/db";
import { resolveBrand } from "@lobbystack/shared";

import { deploymentAppName, forgetCachedDeploymentAppName } from "./branding";

function databaseSaving(appName: string | null) {
  const limit = vi.fn().mockResolvedValue(appName === null ? [] : [{ appName, logoVersion: null }]);
  return { db: { select: () => ({ from: () => ({ limit }) }) } as unknown as Database, limit };
}

afterEach(() => {
  forgetCachedDeploymentAppName();
});

describe("deploymentAppName", () => {
  it("uses BRAND_APP_NAME without reading the database", async () => {
    const { db, limit } = databaseSaving("Saved Name");
    expect(await deploymentAppName(db, { BRAND_APP_NAME: "  RealInfoBot " })).toBe("RealInfoBot");
    expect(limit).not.toHaveBeenCalled();
  });

  it("uses a matched brand file without reading the database", async () => {
    const { db, limit } = databaseSaving("Saved Name");
    expect(await deploymentAppName(db, {}, resolveBrand({ appBaseUrl: "https://dev01.alloplace.com" }))).toBe("AlloPlace (dev)");
    expect(await deploymentAppName(db, { BRAND_APP_NAME: "Override" }, resolveBrand({ appBaseUrl: "https://demo.alloplace.com" }))).toBe("Override");
    expect(limit).not.toHaveBeenCalled();
  });

  it("falls back to what onboarding saved, cached, then LobbyStack", async () => {
    const saved = databaseSaving("Saved Name");
    expect(await deploymentAppName(saved.db, {})).toBe("Saved Name");
    expect(await deploymentAppName(saved.db, {})).toBe("Saved Name");
    expect(saved.limit).toHaveBeenCalledOnce();
    forgetCachedDeploymentAppName();
    expect(await deploymentAppName(databaseSaving(null).db, {})).toBe("LobbyStack");
  });

  it("says LobbyStack when the database can't be read, and asks again next time", async () => {
    const limit = vi.fn().mockRejectedValueOnce(new Error("down")).mockResolvedValueOnce([{ appName: "Back Up", logoVersion: null }]);
    const db = { select: () => ({ from: () => ({ limit }) }) } as unknown as Database;
    expect(await deploymentAppName(db, {})).toBe("LobbyStack");
    expect(await deploymentAppName(db, {})).toBe("Back Up");
  });
});
