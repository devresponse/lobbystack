import { afterEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@/lib/api-helpers", () => ({
  asApiResponse: (error: { status?: number; message?: string }) => Response.json({ error: error.message }, { status: error.status ?? 500 }),
  businessIdFromRequest: () => null,
  readJson: async (request: Request) => await request.json() as unknown,
  requireApiSession: async () => ({ user: { id: "user" } }),
  withOperatorTransaction: vi.fn(),
}));
vi.mock("@lobbystack/domain", () => ({ createBillingCheckoutRequest: fixture.create }));
vi.mock("@/lib/domain-context", () => ({ createDomainContext: () => ({}) }));
vi.mock("@/lib/promo-code-limit", () => ({ checkPromoCodeLimit: vi.fn(), promoCodeLimitResponse: vi.fn() }));
vi.mock("@/lib/trusted-client-ip", () => ({ trustedClientIp: () => null }));

import { POST } from "./route";

const post = async (body: Record<string, unknown>) => await POST(new Request("http://localhost:3000/api/billing/checkout", { method: "POST", body: JSON.stringify(body) }));

afterEach(() => { vi.clearAllMocks(); });

describe("starting a checkout from the dashboard", () => {
  it("passes a billing email on, trimmed, for the business's new Polar customer", async () => {
    fixture.create.mockResolvedValue("request");
    expect((await post({ businessId: "business", target: "pro", billingInterval: "annual", billingEmail: " billing@example.com " })).status).toBe(202);
    expect(fixture.create).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ userId: "user", businessId: "business", target: "pro", billingInterval: "annual", billingEmail: "billing@example.com" }));
    expect((await post({ businessId: "business", target: "pro", billingInterval: "annual" })).status).toBe(202);
    expect(fixture.create.mock.calls[1]![1]).not.toHaveProperty("billingEmail");
  });

  it("refuses a billing email that isn't one, and queues nothing", async () => {
    for (const billingEmail of ["billing", " ", 7, null, `${"x".repeat(320)}@example.com`]) {
      const response = await post({ businessId: "business", target: "pro", billingInterval: "annual", billingEmail });
      expect(response.status, JSON.stringify(billingEmail)).toBe(400);
      expect(await response.json()).toEqual({ error: "billingEmail must be an email address." });
    }
    expect(fixture.create).not.toHaveBeenCalled();
  });
});
