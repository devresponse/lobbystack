import { describe, expect, it } from "vitest";

import { trimEndWhere } from "./index";

describe("trimEndWhere", () => {
  const dash = (character: string) => character === "-";

  it("removes every character at the end that it's told to, and keeps the rest", () => {
    expect(trimEndWhere("kitsilano--", dash)).toBe("kitsilano");
    expect(trimEndWhere("a-b", dash)).toBe("a-b");
    expect(trimEndWhere("---", dash)).toBe("");
    expect(trimEndWhere("", dash)).toBe("");
    expect(trimEndWhere("Bookings. ;\t", (character) => character.trim() === "" || ".;:,".includes(character))).toBe("Bookings");
  });

  it("goes through a long run in linear time, whether or not the run ends the text", () => {
    const run = "\t".repeat(200_000);
    const blank = (character: string) => character.trim() === "";
    expect(trimEndWhere(`x${run}y`, blank)).toBe(`x${run}y`);
    expect(trimEndWhere(`x${run}`, blank)).toBe("x");
  });
});
