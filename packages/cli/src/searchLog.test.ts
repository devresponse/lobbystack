import { describe, expect, it } from "vitest";

import { logFileName } from "./searchLog";

describe("logFileName", () => {
  const at = new Date("2026-11-03T18:45:12.345Z");

  it("starts with when the search was asked and ends with the question's words", () => {
    expect(logFileName("Parking fees?", at)).toBe("2026-11-03T18-45-12-345Z-parking-fees.json");
    expect(logFileName("Де можна припаркуватися?", at)).toBe("2026-11-03T18-45-12-345Z-де-можна-припаркуватися.json");
    // A decomposed accent is still one letter.
    expect(logFileName("Cafe\u0301 hours", at)).toBe("2026-11-03T18-45-12-345Z-café-hours.json");
    expect(logFileName("???", at)).toBe("2026-11-03T18-45-12-345Z-search.json");
    expect(logFileName("parking fees", at, 2)).toBe("2026-11-03T18-45-12-345Z-parking-fees_2.json");
  });

  it("uses only characters a file name can hold on Windows, macOS and Linux", () => {
    const name = logFileName(" What's the price of a 2-hour visit / with C:\\ \"tax\" <*|>? \u0007", at);
    expect(name).toBe("2026-11-03T18-45-12-345Z-what-s-the-price-of-a-2-hour-visit-with-c-tax.json");
    expect(name).not.toMatch(/[<>:"/\\|?*\u0000-\u001f]/);
  });

  it("keeps at most 60 characters of the question, never ending on a hyphen", () => {
    expect(logFileName(`${"a".repeat(59)} b`, at)).toBe(`2026-11-03T18-45-12-345Z-${"a".repeat(59)}.json`);
    expect(logFileName("b".repeat(500), at)).toBe(`2026-11-03T18-45-12-345Z-${"b".repeat(60)}.json`);
  });
});
