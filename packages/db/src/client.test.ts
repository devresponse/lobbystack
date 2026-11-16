import { describe, expect, it, vi } from "vitest";

import { assertDatabaseRole, retryDelayMs, roleDatabaseUrl, withBusinessTransaction, type Database, type DatabaseClient } from "./client";

const DATABASE_URL = "postgresql://postgres:superuser@postgres.internal:5432/lobbystack";

describe("effective database role assertion", () => {
  it.each(["lobbystack_worker", "lobbystack_dispatcher", "lobbystack_app"] as const)("checks %s in production", async (role) => {
    const query = vi.fn().mockResolvedValue({ rows: [{ role, privileged: false }] });
    const client = { role, pool: { query } } as unknown as DatabaseClient;
    await expect(assertDatabaseRole(client, { NODE_ENV: "production" })).resolves.toBeUndefined();
    query.mockResolvedValue({ rows: [{ role: "postgres", privileged: true }] });
    await expect(assertDatabaseRole(client, { NODE_ENV: "production" })).rejects.toThrow("Database role assertion failed");
    query.mockResolvedValue({ rows: [{ role, privileged: true }] });
    await expect(assertDatabaseRole(client, { NODE_ENV: "production" })).rejects.toThrow("Database role assertion failed");
    query.mockResolvedValue({ rows: [{ role: "other", privileged: false }] });
    await expect(assertDatabaseRole(client, { NODE_ENV: "production" })).rejects.toThrow("Database role assertion failed");
  });

  it("allows privileged migrator bootstrap", async () => {
    const query = vi.fn();
    await assertDatabaseRole({ role: "lobbystack_migrator", pool: { query } } as unknown as DatabaseClient, { NODE_ENV: "production" });
    expect(query).not.toHaveBeenCalled();
  });
});

describe("roleDatabaseUrl", () => {
  it("prefers an explicit role URL", () => {
    expect(
      roleDatabaseUrl("lobbystack_app", {
        DATABASE_URL,
        LOBBYSTACK_APP_DATABASE_URL: "postgresql://lobbystack_app:explicit@db:5432/lobbystack",
        LOBBYSTACK_APP_PASSWORD: "ignored",
      }),
    ).toBe("postgresql://lobbystack_app:explicit@db:5432/lobbystack");
  });

  it("builds the role URL from DATABASE_URL and the role password", () => {
    expect(roleDatabaseUrl("lobbystack_worker", { DATABASE_URL, LOBBYSTACK_WORKER_PASSWORD: "w0rker" })).toBe(
      "postgresql://lobbystack_worker:w0rker@postgres.internal:5432/lobbystack",
    );
  });

  it("encodes passwords with reserved characters", () => {
    const url = new URL(roleDatabaseUrl("lobbystack_auth", { DATABASE_URL, LOBBYSTACK_AUTH_PASSWORD: "p@ss/word" }));
    expect(decodeURIComponent(url.password)).toBe("p@ss/word");
  });

  it("falls back to DATABASE_URL when the role has no password", () => {
    expect(roleDatabaseUrl("lobbystack_dispatcher", { DATABASE_URL })).toBe(DATABASE_URL);
  });

  it("never derives the migrator URL from its password", () => {
    expect(roleDatabaseUrl("lobbystack_migrator", { DATABASE_URL, LOBBYSTACK_MIGRATOR_PASSWORD: "m" })).toBe(DATABASE_URL);
  });

  it("requires DATABASE_URL when no explicit role URL is set", () => {
    expect(() => roleDatabaseUrl("lobbystack_app", { LOBBYSTACK_APP_PASSWORD: "a" })).toThrow("DATABASE_URL is required");
  });
});

// AUDIT-016: the loop retried 40001, which READ COMMITTED never raises, and let
// a deadlock through as a 500.
describe("transaction retries", () => {
  const run = async (errors: Array<{ code: string } | undefined>) => {
    let attempt = 0;
    const db = {
      transaction: vi.fn(async (callback: (tx: unknown) => Promise<string>) => {
        const error = errors[attempt];
        attempt += 1;
        if (error) throw Object.assign(new Error(`SQLSTATE ${error.code}`), error);
        return await callback({ execute: vi.fn() });
      }),
    } as unknown as Database;
    const result = await withBusinessTransaction(db, { actorType: "operator" }, async () => "done");
    return { result, attempts: attempt };
  };

  it("runs a deadlocked transaction again", async () => {
    await expect(run([{ code: "40P01" }, undefined])).resolves.toEqual({ result: "done", attempts: 2 });
  });

  it("runs a serialization failure again, for an isolation level that raises it", async () => {
    await expect(run([{ code: "40001" }, undefined])).resolves.toEqual({ result: "done", attempts: 2 });
  });

  it("gives up after three retries and raises the deadlock", async () => {
    await expect(run(Array.from({ length: 5 }, () => ({ code: "40P01" })))).rejects.toThrow("SQLSTATE 40P01");
  });

  it("never runs a failed statement again", async () => {
    await expect(run([{ code: "23505" }])).rejects.toThrow("SQLSTATE 23505");
    await expect(run([undefined])).resolves.toEqual({ result: "done", attempts: 1 });
  });

  it("spreads each wait, so two deadlocked transactions don't come back together", () => {
    expect(retryDelayMs(0, () => 0)).toBe(10);
    expect(retryDelayMs(0, () => 1)).toBe(15);
    expect(retryDelayMs(2, () => 0)).toBe(40);
    expect(retryDelayMs(2, () => 1)).toBe(60);
  });
});
