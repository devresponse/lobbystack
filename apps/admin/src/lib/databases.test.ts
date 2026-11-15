import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createDatabaseClient: vi.fn((role: string) => ({ role, db: {}, pool: { end: vi.fn(async () => undefined) } })),
}));
vi.mock("@lobbystack/db", () => ({ createDatabaseClient: mocks.createDatabaseClient }));

import { closeDatabases, getDatabase } from "./databases";

afterEach(async () => {
  await closeDatabases();
  vi.clearAllMocks();
});

describe("the admin's database pools", () => {
  it("keeps one pool for each role", () => {
    const app = getDatabase("lobbystack_app");
    expect(getDatabase("lobbystack_app")).toBe(app);
    expect(getDatabase("lobbystack_auth")).not.toBe(app);
    expect(mocks.createDatabaseClient.mock.calls.map(([role]) => role)).toEqual(["lobbystack_app", "lobbystack_auth"]);
  });

  it("ends the pools it made and makes a new one at the next use", async () => {
    const app = getDatabase("lobbystack_app");
    const auth = getDatabase("lobbystack_auth");

    await closeDatabases();
    expect(app.pool.end).toHaveBeenCalledTimes(1);
    expect(auth.pool.end).toHaveBeenCalledTimes(1);

    // Nothing left to end a second time, and a pool that ended is never handed out again.
    await closeDatabases();
    expect(app.pool.end).toHaveBeenCalledTimes(1);
    const again = getDatabase("lobbystack_app");
    expect(again).not.toBe(app);
    expect(mocks.createDatabaseClient).toHaveBeenCalledTimes(3);
  });
});
