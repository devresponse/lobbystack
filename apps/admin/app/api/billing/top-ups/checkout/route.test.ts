import { planChangeRefusals } from "@lobbystack/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

// The dashboard's checkout for a top-up on sale, with the domain stubbed: what
// POST queues and refuses, and what GET answers while the page waits.

const fixture = vi.hoisted(() => ({ create: vi.fn(), read: vi.fn(), limit: vi.fn(async () => undefined), transaction: vi.fn(), configured: vi.fn(() => true) }));
vi.mock("@/lib/api-helpers", () => ({
  asApiResponse: (error: { status?: number; message?: string; code?: string }) => Response.json({ error: error.message, ...(error.code ? { code: error.code } : {}) }, { status: error.status ?? 500 }),
  businessIdFromRequest: () => null,
  readJson: async (request: Request) => await request.json() as unknown,
  requireApiSession: async () => ({ user: { id: "user" } }),
  withOperatorTransaction: fixture.transaction,
}));
vi.mock("@lobbystack/domain", () => ({ createTopUpCheckoutRequest: fixture.create, readPackCheckoutInTransaction: fixture.read, packCheckoutConfigured: fixture.configured }));
vi.mock("@/lib/domain-context", () => ({ createDomainContext: () => ({}) }));
vi.mock("@/lib/billing-limit", () => ({ assertBillingCallAllowed: fixture.limit }));

import { GET, POST } from "./route";

const post = async (body: unknown) => await POST(new Request("http://localhost:3000/api/billing/top-ups/checkout", { method: "POST", body: JSON.stringify(body) }));
const get = async (query: string) => await GET(new Request(`http://localhost:3000/api/billing/top-ups/checkout${query}`));

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  fixture.configured.mockReturnValue(true);
});

describe("buying a top-up from the dashboard", () => {
  it("queues the business's checkout for the top-up, with a billing email trimmed for its new customer, and answers its ID", async () => {
    fixture.create.mockResolvedValue("checkout");
    const response = await post({ businessId: "business", topUp: " topup_100_90 ", billingEmail: " billing@example.com " });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ checkoutId: "checkout" });
    expect(fixture.create).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ userId: "user", businessId: "business", topUp: "topup_100_90", billingEmail: "billing@example.com" }));
    expect((await post({ businessId: "business", topUp: "topup_100_90" })).status).toBe(202);
    expect(fixture.create.mock.calls[1]![1]).not.toHaveProperty("billingEmail");
  });

  it("counts a new checkout against the checkout limits, and answers the domain's refusals with their status and code", async () => {
    fixture.create.mockResolvedValue("checkout");
    await post({ businessId: "business", topUp: "topup_100_90" });
    const { checkLimit } = fixture.create.mock.calls[0]![1] as { checkLimit: (subject: { businessId: string; userId: string }) => Promise<void> };
    await checkLimit({ businessId: "business", userId: "user" });
    expect(fixture.limit).toHaveBeenCalledExactlyOnceWith("checkout", { businessId: "business", userId: "user" });

    const sentence = "Top-ups are sold on Free and on prepaid packs. On Starter and Pro, use past the plan's allowance goes on and is billed with the plan.";
    fixture.create.mockRejectedValueOnce(Object.assign(new Error(sentence), { status: 409, code: "top_up_not_sold_on_plan" }));
    const starter = await post({ businessId: "business", topUp: "topup_100_90" });
    expect(starter.status).toBe(409);
    expect(await starter.json()).toEqual({ error: sentence, code: "top_up_not_sold_on_plan" });
  });

  it("refuses at once when the deployment's provider isn't set up, and a request without a top-up or with a billing email that isn't one", async () => {
    fixture.configured.mockReturnValue(false);
    const response = await post({ businessId: "business", topUp: "topup_100_90" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Top-ups can't be bought here right now.", code: "top_up_not_on_sale" });
    fixture.configured.mockReturnValue(true);
    for (const body of [[], null, { topUp: "topup_100_90" }, { businessId: "business" }, { businessId: "business", topUp: " " }, { businessId: "business", topUp: 7 }, { businessId: "business", topUp: "x".repeat(49) }]) {
      expect((await post(body)).status, JSON.stringify(body)).toBe(400);
    }
    for (const billingEmail of ["billing", " ", 7, null]) {
      expect((await post({ businessId: "business", topUp: "topup_100_90", billingEmail })).status, JSON.stringify(billingEmail)).toBe(400);
    }
    expect(fixture.create).not.toHaveBeenCalled();
    expect(fixture.limit).not.toHaveBeenCalled();
  });
});

describe("reading a top-up checkout from the dashboard", () => {
  const view = { id: "checkout", pack: "topup_100_90", kind: "top_up", status: "ready", packStatus: null, topUpId: null, topUpStatus: null, checkoutUrl: "https://checkout.stripe.com/c/pay/cs_1", error: null, expiresAt: new Date("2026-11-26T13:00:00Z"), createdAt: new Date("2026-11-26T12:00:00Z"), updatedAt: new Date("2026-11-26T12:00:05Z") };

  function inBusiness() {
    fixture.transaction.mockImplementation(async (_request: Request, callback: (input: { businessId: string; tx: unknown }) => Promise<unknown>, options: unknown) => {
      expect(options).toEqual({ minimumRole: "business_admin" });
      return await callback({ businessId: "business", tx: "tx" });
    });
  }

  it("answers its page while ready, and synced once the payment added the top-up, also while a dispute holds it", async () => {
    vi.stubEnv("BILLING_PROVIDER", "stripe");
    inBusiness();
    fixture.read.mockResolvedValueOnce(view);
    const ready = await get("?checkoutId=checkout");
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ id: "checkout", topUp: "topup_100_90", status: "ready", checkoutUrl: "https://checkout.stripe.com/c/pay/cs_1", error: null, expiresAt: "2026-11-26T13:00:00.000Z", topUpStatus: null, synced: false, refusal: null, providerName: "Stripe" });
    expect(fixture.read).toHaveBeenCalledWith("tx", { businessId: "business", checkoutId: "checkout" });

    for (const topUpStatus of ["active", "frozen", "used_up"]) {
      fixture.read.mockResolvedValueOnce({ ...view, status: "paid", topUpId: "top-up", topUpStatus, checkoutUrl: null });
      expect(await (await get("?checkoutId=checkout")).json()).toMatchObject({ status: "paid", topUpStatus, checkoutUrl: null, synced: true });
    }
    // Paid, but the payment went back before it arrived.
    fixture.read.mockResolvedValueOnce({ ...view, status: "paid", topUpId: "top-up", topUpStatus: "refunded", checkoutUrl: null });
    expect(await (await get("?checkoutId=checkout")).json()).toMatchObject({ topUpStatus: "refunded", synced: false });
  });

  it("names the refusal of a checkout whose billing email the provider wouldn't take, so the page asks for another", async () => {
    inBusiness();
    fixture.read.mockResolvedValueOnce({ ...view, status: "failed", checkoutUrl: null, error: planChangeRefusals.billing_email_taken });
    expect(await (await get("?checkoutId=checkout")).json()).toMatchObject({ status: "failed", synced: false, refusal: "billing_email_taken" });
  });

  it("asks for a checkout ID, and answers 404 for one the business doesn't have or a pack's", async () => {
    expect((await get("")).status).toBe(400);
    expect(fixture.transaction).not.toHaveBeenCalled();
    inBusiness();
    fixture.read.mockResolvedValueOnce(null);
    const missing = await get("?checkoutId=other");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "Top-up checkout not found." });
    fixture.read.mockResolvedValueOnce({ ...view, kind: "pack" });
    expect((await get("?checkoutId=checkout")).status).toBe(404);
  });
});
