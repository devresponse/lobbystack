import { afterEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ create: vi.fn(), limit: vi.fn(async () => undefined) }));
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
vi.mock("@/lib/billing-limit", () => ({ assertBillingCallAllowed: fixture.limit }));
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

  it("counts a new request against the checkout limits, and answers a refusal with its 429", async () => {
    fixture.create.mockResolvedValue("request");
    await post({ businessId: "business", target: "pro", billingInterval: "monthly" });
    // The domain calls it only before it makes a request, not for an open one it gives back.
    const { checkLimit } = fixture.create.mock.calls[0]![1] as { checkLimit: (subject: { businessId: string; userId: string }) => Promise<void> };
    await checkLimit({ businessId: "business", userId: "user" });
    expect(fixture.limit).toHaveBeenCalledExactlyOnceWith("checkout", { businessId: "business", userId: "user" });
    fixture.create.mockRejectedValueOnce(Object.assign(new Error("Too many checkouts started. Try again in 12 minutes."), { status: 429, code: "billing_rate_limited" }));
    const refused = await post({ businessId: "business", target: "pro", billingInterval: "monthly" });
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: "Too many checkouts started. Try again in 12 minutes." });
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
