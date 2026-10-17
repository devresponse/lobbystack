import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ reportServerError: vi.fn() }));

vi.mock("./error-reporting", () => ({
  reportServerError: mocks.reportServerError,
}));
// The proxy names the path on every request.
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-lobbystack-pathname": "/api/onboarding/phone-numbers/claim" }),
}));

import { asApiResponse } from "./api-helpers";

describe("asApiResponse", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns typed validation errors without reporting them as server exceptions", async () => {
    const response = asApiResponse(Object.assign(
      new Error("A mobile phone number is required."),
      { status: 422, code: "phone_number_not_mobile" },
    ));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: "A mobile phone number is required.",
      code: "phone_number_not_mobile",
    });
    expect(mocks.reportServerError).not.toHaveBeenCalled();
  });

  it("logs a server failure with its error ID and route, and hides it from the response", async () => {
    const error = new Error("Failed query: select 1");
    const response = asApiResponse(error);

    expect(response.status).toBe(500);
    const body = await response.json() as { error: string; errorId: string };
    expect(body).toEqual({ error: "Request failed.", errorId: expect.any(String) });
    expect(response.headers.get("x-error-id")).toBe(body.errorId);
    await vi.waitFor(() => expect(mocks.reportServerError).toHaveBeenCalledWith(error, { operation: "api_response", errorId: body.errorId, route: "/api/onboarding/phone-numbers/claim" }));
  });
});
