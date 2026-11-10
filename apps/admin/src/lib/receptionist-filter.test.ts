import { describe, expect, it } from "vitest";

import { receptionistIdFromRequest } from "./receptionist-filter";

const kitsilanoId = "00000000-0000-4000-8000-0000000000a2";
const request = (query: string) => new Request(`http://localhost:3000/api/calls${query}`);

describe("receptionistIdFromRequest", () => {
  it("reads the receptionist a page's address names, in lower case", () => {
    expect(receptionistIdFromRequest(request(`?receptionist=${kitsilanoId}`))).toBe(kitsilanoId);
    expect(receptionistIdFromRequest(request(`?receptionist=%20${kitsilanoId.toUpperCase()}%20`))).toBe(kitsilanoId);
    expect(receptionistIdFromRequest(request(`?answeredBy=${kitsilanoId}`), "answeredBy")).toBe(kitsilanoId);
  });

  it("is null when the address names none", () => {
    expect(receptionistIdFromRequest(request(""))).toBeNull();
    expect(receptionistIdFromRequest(request("?receptionist="))).toBeNull();
    expect(receptionistIdFromRequest(request("?receptionist=%20"))).toBeNull();
  });

  it("answers 400 for something that can't be a receptionist", async () => {
    let refused: unknown;
    try { receptionistIdFromRequest(request("?receptionist=kitsilano")); } catch (error) { refused = error; }
    expect(refused).toBeInstanceOf(Response);
    expect((refused as Response).status).toBe(400);
    expect(await (refused as Response).json()).toMatchObject({ code: "invalid_receptionist", error: "receptionist must be a receptionist id." });
  });
});
