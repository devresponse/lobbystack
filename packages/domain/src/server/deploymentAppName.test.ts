import { afterEach, describe, expect, it, vi } from "vitest";

import type { Database } from "@lobbystack/db";
import { resolveBrand, type ResolvedBrand } from "@lobbystack/shared";

import { deploymentAppName, forgetCachedDeploymentAppName } from "./branding";

// An unbranded copy of the code has no brand besides LobbyStack, so onboarding's choice names it.
const unbranded: ResolvedBrand = { ...resolveBrand({ appBaseUrl: "http://localhost", preset: "lobbystack" }), source: "default" };

function databaseSaving(appName: string | null) {
  const limit = vi.fn().mockResolvedValue(appName === null ? [] : [{ appName, logoVersion: null }]);
  return { db: { select: () => ({ from: () => ({ limit }) }) } as unknown as Database, limit };
}

afterEach(() => {
  forgetCachedDeploymentAppName();
});

describe("deploymentAppName", () => {
  it("uses a matched brand file without reading the database", async () => {
    const { db, limit } = databaseSaving("Saved Name");
    expect(await deploymentAppName(db, resolveBrand({ appBaseUrl: "https://dev01.alloplace.com" }))).toBe("AlloPlace (dev)");
    expect(await deploymentAppName(db, resolveBrand({ appBaseUrl: "https://demo.alloplace.com" }))).toBe("AlloPlace");
    expect(limit).not.toHaveBeenCalled();
  });

  it("uses the only brand besides LobbyStack without reading the database", async () => {
    const { db, limit } = databaseSaving("Saved Name");
    expect(await deploymentAppName(db, resolveBrand({ appBaseUrl: "http://localhost:13000" }))).toBe("AlloPlace");
    expect(limit).not.toHaveBeenCalled();
  });

  it("falls back to what onboarding saved, cached, then LobbyStack", async () => {
    const saved = databaseSaving("Saved Name");
    expect(await deploymentAppName(saved.db, unbranded)).toBe("Saved Name");
    expect(await deploymentAppName(saved.db, unbranded)).toBe("Saved Name");
    expect(saved.limit).toHaveBeenCalledOnce();
    forgetCachedDeploymentAppName();
    expect(await deploymentAppName(databaseSaving(null).db, unbranded)).toBe("LobbyStack");
  });

  it("says LobbyStack when the database can't be read, and asks again next time", async () => {
    const limit = vi.fn().mockRejectedValueOnce(new Error("down")).mockResolvedValueOnce([{ appName: "Back Up", logoVersion: null }]);
    const db = { select: () => ({ from: () => ({ limit }) }) } as unknown as Database;
    expect(await deploymentAppName(db, unbranded)).toBe("LobbyStack");
    expect(await deploymentAppName(db, unbranded)).toBe("Back Up");
  });
});
