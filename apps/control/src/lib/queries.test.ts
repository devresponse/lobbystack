import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { containsPattern, currentMonth, isMonth, isUuid, recentMonths } from "./queries";

describe("the panel's queries", () => {
  it("never build SQL from what a request sent: every value is a parameter", () => {
    const source = readFileSync(fileURLToPath(new URL("./queries.ts", import.meta.url)), "utf8");
    const statements = [...source.matchAll(/`\s*(?:select|with)\b[^`]*`/gi)].map((match) => match[0]);
    expect(statements.length).toBeGreaterThan(20);
    const interpolated = statements.flatMap((statement) => [...statement.matchAll(/\$\{([^}]*)\}/g)].map((match) => match[1]));
    // The one thing written into the SQL itself is a constant expression.
    expect(new Set(interpolated)).toEqual(new Set(["CALL_SECONDS"]));
  });

  it("search for the text typed, with its own % and _ taken literally", () => {
    expect(containsPattern("ann")).toBe("%ann%");
    expect(containsPattern("50%_off\\")).toBe("%50\\%\\_off\\\\%");
  });

  it("accept only real IDs and months", () => {
    expect(isUuid("00000000-0000-4000-8000-000000000000")).toBe(true);
    expect(isUuid("1; drop")).toBe(false);
    expect(isMonth("2026-11")).toBe(true);
    expect(isMonth("2026-13")).toBe(false);
    expect(isMonth("2026-11'")).toBe(false);
  });

  it("count months in UTC", () => {
    expect(currentMonth(new Date("2026-11-30T23:30:00-05:00"))).toBe("2026-12");
    expect(recentMonths(3, new Date("2026-01-15T00:00:00Z"))).toEqual(["2025-11", "2025-12", "2026-01"]);
    expect(recentMonths(12, new Date("2026-11-18T00:00:00Z"))).toHaveLength(12);
    expect(recentMonths(0)).toEqual([]);
  });
});
