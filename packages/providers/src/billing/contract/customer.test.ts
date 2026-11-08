import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@lobbystack/telemetry/node", async (importOriginal) => ({ ...await importOriginal<typeof import("@lobbystack/telemetry/node")>(), reportWarning: vi.fn() }));

import { reportWarning } from "@lobbystack/telemetry/node";
import { polarHarness } from "./harness";

const input = { customer: { id: null, billingKey: "business:b1" }, businessId: "b1", email: "owner@example.com", name: "Allo Salon", locale: null, requestId: "request-1" };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("the billing provider contract: the customer", () => {
  describe("on Polar", () => {
    it("finds the business's customer by its billing key", async () => {
      const polar = polarHarness();
      polar.answer("GET", "/v1/customers/external/business%3Ab1", { id: "cus-1", external_id: "business:b1" });
      await expect(polar.billing.findOrCreateCustomer(input)).resolves.toEqual({ id: "cus-1", created: false });
      expect(polar.requests.map((request) => request.method)).toEqual(["GET"]);
    });

    it("makes one with the email and name when Polar has none", async () => {
      const polar = polarHarness();
      polar.answer("GET", "/v1/customers/external/business%3Ab1", { detail: "Not found" }, 404);
      polar.answer("POST", "/v1/customers/", { id: "cus-2", external_id: "business:b1" }, 201);
      await expect(polar.billing.findOrCreateCustomer(input)).resolves.toEqual({ id: "cus-2", created: true });
      expect(polar.requests[1]).toEqual({ method: "POST", path: "/v1/customers/", body: { external_id: "business:b1", email: "owner@example.com", name: "Allo Salon" } });
    });

    it("finds the one another run made first", async () => {
      const polar = polarHarness();
      // Polar has none at the first read, refuses the new one's billing key, then has the race's winner.
      let reads = 0;
      vi.stubGlobal("fetch", vi.fn(async (_url: string | URL, init?: RequestInit) => {
        if ((init?.method ?? "GET") !== "GET") return new Response(JSON.stringify({ detail: [{ loc: ["body", "external_id"], msg: "taken" }] }), { status: 422 });
        reads += 1;
        return reads === 1 ? new Response(JSON.stringify({ detail: "Not found" }), { status: 404 }) : new Response(JSON.stringify({ id: "cus-3", external_id: "business:b1" }), { status: 200 });
      }));
      await expect(polar.billing.findOrCreateCustomer(input)).resolves.toEqual({ id: "cus-3", created: false });
      expect(reads).toBe(2);
    });

    it("leaves the customer to checkout, with a warning, when the token can't read customers", async () => {
      const polar = polarHarness();
      polar.answer("GET", "/v1/customers/external/business%3Ab1", { error: "insufficient_scope" }, 403);
      await expect(polar.billing.findOrCreateCustomer(input)).resolves.toBeNull();
      expect(vi.mocked(reportWarning).mock.calls.map(([error]) => (error as Error).message)).toEqual([expect.stringContaining("customers:write")]);
    });

    it("refuses an email another customer has, and one Polar doesn't take as an email", async () => {
      const taken = polarHarness();
      taken.answer("GET", "/v1/customers/external/business%3Ab1", { detail: "Not found" }, 404);
      taken.answer("POST", "/v1/customers/", { error: "PolarRequestValidationError", detail: [{ loc: ["body", "email"], msg: "taken" }] }, 422);
      const takenError = await taken.billing.findOrCreateCustomer(input).catch((error: unknown) => error);
      expect(taken.billing.refusalFor(takenError)).toBe("billing_email_taken");

      const invalid = polarHarness();
      invalid.answer("GET", "/v1/customers/external/business%3Ab1", { detail: "Not found" }, 404);
      invalid.answer("POST", "/v1/customers/", { error: "RequestValidationError", detail: [{ loc: ["body", "email"], msg: "invalid" }] }, 422);
      const invalidError = await invalid.billing.findOrCreateCustomer(input).catch((error: unknown) => error);
      expect(invalid.billing.refusalFor(invalidError)).toBe("billing_email_invalid");
    });
  });
});
