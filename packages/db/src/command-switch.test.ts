import { describe, expect, it } from "vitest";
import { switchOn } from "./command-switch";

describe("a switch of the database command line", () => {
  it("is on for every way of writing true", () => {
    for (const value of ["true", "TRUE", " True ", "1", "yes", "on", "ON"]) expect(switchOn(value), value).toBe(true);
  });

  it("is off when unset, empty, false, or a word it does not know", () => {
    for (const value of [undefined, "", "  ", "false", "0", "no", "off", "enabled"]) expect(switchOn(value), String(value)).toBe(false);
  });
});
