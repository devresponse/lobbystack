import { describe, expect, it } from "vitest";

import { isContactPasscode, isGuessableContactPasscode } from "./receptionist";

describe("isContactPasscode", () => {
  it("takes 4 to 8 digits", () => {
    expect(isContactPasscode("4806")).toBe(true);
    expect(isContactPasscode("48061397")).toBe(true);
  });

  it("refuses other lengths and anything but digits", () => {
    expect(isContactPasscode("480")).toBe(false);
    expect(isContactPasscode("480613971")).toBe(false);
    expect(isContactPasscode("48 06")).toBe(false);
    expect(isContactPasscode("4806#")).toBe(false);
    expect(isContactPasscode("٤٨٠٦")).toBe(false);
    expect(isContactPasscode("")).toBe(false);
  });
});

describe("isGuessableContactPasscode", () => {
  it("catches one digit repeated and digits in a row either way", () => {
    for (const passcode of ["0000", "77777777", "1234", "456789", "4321", "98765"]) expect(isGuessableContactPasscode(passcode)).toBe(true);
  });

  it("allows other PINs", () => {
    for (const passcode of ["2468", "1235", "0001", "480613", "9012", "1212"]) expect(isGuessableContactPasscode(passcode)).toBe(false);
  });
});
