import { describe, expect, it } from "vitest";

import { CONTROL_ROLE, controlDatabaseUrl, controlPoolConfig, controlPoolMax, roleProblem } from "./db";

describe("the panel's database connection", () => {
  it("uses its own connection string when one is set", () => {
    expect(controlDatabaseUrl({ LOBBYSTACK_CONTROL_DATABASE_URL: " postgres://lobbystack_control:x@db:5432/app ", DATABASE_URL: "postgres://postgres:y@db:5432/app" }))
      .toBe("postgres://lobbystack_control:x@db:5432/app");
  });

  it("signs in to DATABASE_URL's database as lobbystack_control when given its password", () => {
    expect(controlDatabaseUrl({ DATABASE_URL: "postgres://postgres:secret@db.railway.internal:5432/railway", LOBBYSTACK_CONTROL_PASSWORD: "p@ss/word" }))
      .toBe("postgres://lobbystack_control:p%40ss%2Fword@db.railway.internal:5432/railway");
  });

  it("takes DATABASE_URL as it is otherwise, and needs one", () => {
    expect(controlDatabaseUrl({ DATABASE_URL: "postgres://lobbystack_control:x@db:5432/app" })).toBe("postgres://lobbystack_control:x@db:5432/app");
    expect(() => controlDatabaseUrl({})).toThrow(/DATABASE_URL/);
  });

  it("keeps the pool within the role's six connections", () => {
    expect(controlPoolMax({})).toBe(3);
    expect(controlPoolMax({ LOBBYSTACK_CONTROL_POOL_MAX: "6" })).toBe(6);
    for (const value of ["0", "7", "2.5", "many"]) expect(() => controlPoolMax({ LOBBYSTACK_CONTROL_POOL_MAX: value })).toThrow(/1 to 6/);
    expect(controlPoolConfig({ DATABASE_URL: "postgres://lobbystack_control:x@db:5432/app" })).toMatchObject({ max: 3, application_name: "lobbystack:control", options: "-c TimeZone=UTC" });
  });

  it("refuses any connection but an unprivileged, read-only lobbystack_control", () => {
    expect(roleProblem({ role: CONTROL_ROLE, privileged: false, read_only: "on" })).toBeNull();
    expect(roleProblem(undefined)).toMatch(/didn't say/);
    expect(roleProblem({ role: "postgres", privileged: true, read_only: "off" })).toMatch(/signed in as postgres/);
    expect(roleProblem({ role: CONTROL_ROLE, privileged: true, read_only: "on" })).toMatch(/privilege/);
    expect(roleProblem({ role: CONTROL_ROLE, privileged: false, read_only: "off" })).toMatch(/read-only/);
  });
});
