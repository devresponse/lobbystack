import { describe, expect, it } from "vitest";

import { searchPattern } from "./search-pattern";

describe("searchPattern", () => {
  it("matches the term anywhere in the value", () => {
    expect(searchPattern("dana")).toBe("%dana%");
  });

  it("escapes the two wildcards, so a typed % or _ means itself", () => {
    expect(searchPattern("50%")).toBe("%50\\%%");
    expect(searchPattern("o_t")).toBe("%o\\_t%");
  });

  it("escapes the escape character, so a trailing backslash is a backslash", () => {
    expect(searchPattern("c:\\")).toBe("%c:\\\\%");
  });

  it("escapes the backslash before the wildcards, never after", () => {
    // "\\%" the user typed is a backslash and a percent sign, not an escaped percent sign.
    expect(searchPattern("\\%")).toBe("%\\\\\\%%");
  });

  it("leaves ordinary text alone", () => {
    expect(searchPattern("+1 416 555 0100")).toBe("%+1 416 555 0100%");
  });
});
