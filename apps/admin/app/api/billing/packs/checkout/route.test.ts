import { planChangeRefusals } from "@lobbystack/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ create: vi.fn(), read: vi.fn(), limit: vi.fn(async () => undefined), transaction: vi.fn(), configured: vi.fn(() => true) }));
vi.mock("@/lib/api-helpers", () => ({
  asApiResponse: (error: { status?: number; message?: string; code?: string }) => Response.json({ error: error.message, ...(error.code ? { code: error.code } : {}) }, { status: error.status ?? 500 }),
  businessIdFromRequest: () => null,
  readJson: async (request: Request) => await request.json() as unknown,
  requireApiSession: async () => ({ user: { id: "user" } }),
  withOperatorTransaction: fixture.transaction,
}));
vi.mock("@lobbystack/domain", () => ({ createPackCheckoutRequest: fixture.create, readPackCheckoutInTransaction: fixture.read, packCheckoutConfigured: fixture.configured, PACK_CHECKOUT_CLOSED_FOR_PLAN: "A plan started for this business, so this pack's checkout closed." }));
vi.mock("@/lib/domain-context", () => ({ createDomainContext: () => ({}) }));
vi.mock("@/lib/billing-limit", () => ({ assertBillingCallAllowed: fixture.limit }));

import { GET, POST } from "./route";

const post = async (body: unknown) => await POST(new Request("http://localhost:3000/api/billing/packs/checkout", { method: "POST", body: JSON.stringify(body) }));
const get = async (query: string) => await GET(new Request(`http://localhost:3000/api/billing/packs/checkout${query}`));

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  fixture.configured.mockReturnValue(true);
});

describe("buying a pack from the dashboard", () => {
  it("queues the business's checkout for the pack, with a billing email trimmed for its new customer, and answers its ID", async () => {
    fixture.create.mockResolvedValue("checkout");
    const response = await post({ businessId: "business", pack: " minutes_500_90 ", billingEmail: " billing@example.com " });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ checkoutId: "checkout" });
    expect(fixture.create).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ userId: "user", businessId: "business", pack: "minutes_500_90", billingEmail: "billing@example.com" }));
    expect((await post({ businessId: "business", pack: "minutes_500_90" })).status).toBe(202);
    expect(fixture.create.mock.calls[1]![1]).not.toHaveProperty("billingEmail");
  });

  it("counts a new checkout against the checkout limits, and answers the domain's refusals with their status and code", async () => {
    fixture.create.mockResolvedValue("checkout");
    await post({ businessId: "business", pack: "minutes_500_90" });
    // The domain calls it only before it makes a checkout, not for an open one it gives back.
    const { checkLimit } = fixture.create.mock.calls[0]![1] as { checkLimit: (subject: { businessId: string; userId: string }) => Promise<void> };
    await checkLimit({ businessId: "business", userId: "user" });
    expect(fixture.limit).toHaveBeenCalledExactlyOnceWith("checkout", { businessId: "business", userId: "user" });

    fixture.create.mockRejectedValueOnce(Object.assign(new Error("This business pays for a yearly plan. Set it to end at its renewal, and buy a pack once it ends."), { status: 409, code: "pack_yearly_plan" }));
    const yearly = await post({ businessId: "business", pack: "minutes_500_90" });
    expect(yearly.status).toBe(409);
    expect(await yearly.json()).toEqual({ error: "This business pays for a yearly plan. Set it to end at its renewal, and buy a pack once it ends.", code: "pack_yearly_plan" });
    fixture.create.mockRejectedValueOnce(Object.assign(new Error("Too many checkouts started. Try again in 12 minutes."), { status: 429, code: "billing_rate_limited" }));
    expect((await post({ businessId: "business", pack: "minutes_500_90" })).status).toBe(429);
  });

  it("refuses at once, as the plan screens and the API do, when the deployment's provider isn't set up", async () => {
    fixture.configured.mockReturnValue(false);
    const response = await post({ businessId: "business", pack: "minutes_500_90" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Packs can't be bought here right now.", code: "pack_not_on_sale" });
    expect(fixture.create).not.toHaveBeenCalled();
    expect(fixture.limit).not.toHaveBeenCalled();
  });

  it("refuses a request without a pack, or with a billing email that isn't one, and queues nothing", async () => {
    for (const body of [[], null, { pack: "minutes_500_90" }, { businessId: "business" }, { businessId: "business", pack: " " }, { businessId: "business", pack: 7 }, { businessId: "business", pack: "x".repeat(49) }]) {
      expect((await post(body)).status, JSON.stringify(body)).toBe(400);
    }
    for (const billingEmail of ["billing", " ", 7, null, `${"x".repeat(320)}@example.com`]) {
      const response = await post({ businessId: "business", pack: "minutes_500_90", billingEmail });
      expect(response.status, JSON.stringify(billingEmail)).toBe(400);
      expect(await response.json()).toEqual({ error: "billingEmail must be an email address." });
    }
    expect(fixture.create).not.toHaveBeenCalled();
  });
});

describe("reading a pack checkout from the dashboard", () => {
  const view = { id: "checkout", pack: "minutes_500_90", status: "ready", packStatus: null, checkoutUrl: "https://checkout.stripe.com/c/pay/cs_1", error: null, expiresAt: new Date("2026-11-09T13:00:00Z"), createdAt: new Date("2026-11-09T12:00:00Z"), updatedAt: new Date("2026-11-09T12:00:05Z") };

  function inBusiness() {
    fixture.transaction.mockImplementation(async (_request: Request, callback: (input: { businessId: string; tx: unknown }) => Promise<unknown>, options: unknown) => {
      expect(options).toEqual({ minimumRole: "business_admin" });
      return await callback({ businessId: "business", tx: "tx" });
    });
  }

  it("answers its page while ready, as the plan checkout's poll does, and synced once billing.reconcile marked it paid", async () => {
    vi.stubEnv("BILLING_PROVIDER", "stripe");
    inBusiness();
    fixture.read.mockResolvedValueOnce(view);
    const ready = await get("?checkoutId=checkout");
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ id: "checkout", pack: "minutes_500_90", status: "ready", checkoutUrl: "https://checkout.stripe.com/c/pay/cs_1", error: null, expiresAt: "2026-11-09T13:00:00.000Z", packStatus: null, synced: false, closedForPlan: false, refusal: null, providerName: "Stripe" });
    expect(fixture.read).toHaveBeenCalledWith("tx", { businessId: "business", checkoutId: "checkout" });

    fixture.read.mockResolvedValueOnce({ ...view, status: "paid", packStatus: "active", checkoutUrl: null });
    expect(await (await get("?checkoutId=checkout")).json()).toMatchObject({ status: "paid", packStatus: "active", checkoutUrl: null, synced: true });
  });

  it("says a paid checkout's pack isn't the business's when a plan started first or the payment went back first", async () => {
    inBusiness();
    for (const packStatus of ["replaced", "refunded"]) {
      fixture.read.mockResolvedValueOnce({ ...view, status: "paid", packStatus, checkoutUrl: null });
      expect(await (await get("?checkoutId=checkout")).json()).toMatchObject({ status: "paid", packStatus, synced: false });
    }
    // Frozen while a dispute holds its payment, the pack is still the business's.
    fixture.read.mockResolvedValueOnce({ ...view, status: "paid", packStatus: "frozen", checkoutUrl: null });
    expect(await (await get("?checkoutId=checkout")).json()).toMatchObject({ synced: true });
  });

  it("says when a plan the business bought closed the checkout", async () => {
    inBusiness();
    fixture.read.mockResolvedValueOnce({ ...view, status: "expired", checkoutUrl: null, error: "A plan started for this business, so this pack's checkout closed." });
    expect(await (await get("?checkoutId=checkout")).json()).toMatchObject({ status: "expired", closedForPlan: true, synced: false });
  });

  it("names the refusal of a checkout whose billing email the provider wouldn't take, so the page asks for another", async () => {
    inBusiness();
    fixture.read.mockResolvedValueOnce({ ...view, status: "failed", checkoutUrl: null, error: planChangeRefusals.billing_email_taken });
    expect(await (await get("?checkoutId=checkout")).json()).toMatchObject({ status: "failed", error: planChangeRefusals.billing_email_taken, synced: false, refusal: "billing_email_taken", providerName: "Polar" });
  });

  it("asks for a checkout ID, and answers 404 for one the business doesn't have", async () => {
    expect((await get("")).status).toBe(400);
    expect(fixture.transaction).not.toHaveBeenCalled();
    inBusiness();
    fixture.read.mockResolvedValueOnce(null);
    const missing = await get("?checkoutId=other");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "Pack checkout not found." });
  });
});
