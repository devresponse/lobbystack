import { describe, expect, it } from "vitest";

import { failure, isRecord, isUniqueViolation } from "./requestHelpers";

describe("failure", () => {
  it("is an Error that carries the status and code the admin routes answer with", () => {
    const error = failure("Receptionist not found.", 404, "receptionist_not_found");
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ message: "Receptionist not found.", status: 404, code: "receptionist_not_found" });
  });
});

describe("isRecord", () => {
  it("accepts an object and refuses arrays, null and everything else", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ name: "Front desk" })).toBe(true);
    for (const value of [[], null, undefined, "Front desk", 5, true]) expect(isRecord(value)).toBe(false);
  });
});

describe("isUniqueViolation", () => {
  // What node-postgres throws, and what Drizzle wraps it in.
  const driverError = (constraint: string, code = "23505") => Object.assign(new Error("duplicate key value violates unique constraint"), { code, constraint });
  const wrapped = (cause: unknown) => Object.assign(new Error("Failed query"), { cause });

  it("finds the index named on the driver's error, however deep the wrapping", () => {
    const error = driverError("receptionist_profiles_business_handle_unique");
    for (const thrown of [error, wrapped(error), wrapped(wrapped(error))]) {
      expect(isUniqueViolation(thrown, "receptionist_profiles_business_handle_unique")).toBe(true);
      expect(isUniqueViolation(thrown)).toBe(true);
    }
  });

  it("refuses another index, another error and a value that isn't an error", () => {
    expect(isUniqueViolation(wrapped(driverError("knowledge_website_rules_unique")), "receptionist_profiles_business_handle_unique")).toBe(false);
    expect(isUniqueViolation(wrapped(driverError("receptionist_profiles_business_handle_unique", "23503")))).toBe(false);
    expect(isUniqueViolation(new Error("Failed query"))).toBe(false);
    for (const value of [null, undefined, "23505", 23505]) expect(isUniqueViolation(value)).toBe(false);
  });

  it("stops on a chain of causes that loops back", () => {
    const first = wrapped(undefined);
    const second = wrapped(first);
    first.cause = second;
    expect(isUniqueViolation(first)).toBe(false);
    expect(isUniqueViolation(first, "knowledge_website_rules_unique")).toBe(false);
  });
});
