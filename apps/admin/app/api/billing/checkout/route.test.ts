import { afterEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ create: vi.fn(), limit: vi.fn(async () => undefined), transaction: vi.fn(), rows: [] as unknown[][] }));
vi.mock("@/lib/api-helpers", () => ({
  // As the real one: a response a route threw is the answer, and a plain error is a 500.
  asApiResponse: (error: { status?: number; message?: string }) => error instanceof Response ? error : Response.json({ error: error.message }, { status: error.status ?? 500 }),
  businessIdFromRequest: (request: Request) => new URL(request.url).searchParams.get("businessId"),
  requireApiSession: async () => ({ user: { id: "user" } }),
  withOperatorTransaction: fixture.transaction,
}));
vi.mock("@lobbystack/domain", () => ({
  createBillingCheckoutRequest: fixture.create,
  // A plan checkout, never a cancel, resume or keep, in these tests.
  isBillingSubscriptionAction: () => false,
  billingSubscriptionChangeShown: () => false,
}));
vi.mock("@/lib/domain-context", () => ({ createDomainContext: () => ({}) }));
vi.mock("@/lib/promo-code-limit", () => ({ checkPromoCodeLimit: vi.fn(), promoCodeLimitResponse: vi.fn() }));
vi.mock("@/lib/billing-limit", () => ({ assertBillingCallAllowed: fixture.limit }));
vi.mock("@/lib/trusted-client-ip", () => ({ trustedClientIp: () => null }));

import { GET, POST } from "./route";

const post = async (body: unknown, address = "http://localhost:3000/api/billing/checkout") => await POST(new Request(address, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }));
const get = async (query: string) => await GET(new Request(`http://localhost:3000/api/billing/checkout${query}`));
/** What a refused field answers: 400, the field first in `error`, and every field in `details`. */
const refusal = (path: string, message: string) => ({ error: path === "(body)" ? message : `${path}: ${message}`, code: "invalid_request", details: [{ path, message }] });

afterEach(() => { vi.clearAllMocks(); fixture.rows.length = 0; });

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
      expect(await response.json()).toEqual(refusal("billingEmail", "Give an email address, such as billing@example.com."));
    }
    expect(fixture.create).not.toHaveBeenCalled();
  });

  // AUDIT-007: each of these threw a plain Error, so it answered 500 "Request failed." and was reported as a server fault.
  it("answers a caller's mistake with 400 and the field, and queues nothing", async () => {
    const valid = { businessId: "business", target: "pro", billingInterval: "annual" };
    const cases: Array<[unknown, { path: string; message: string }]> = [
      [{ ...valid, target: "enterprise" }, { path: "target", message: "target is starter or pro." }],
      [{ businessId: "business", billingInterval: "annual" }, { path: "target", message: "target is starter or pro." }],
      [{ ...valid, billingInterval: "weekly" }, { path: "billingInterval", message: "billingInterval is monthly or annual." }],
      [{ ...valid, promoCode: 7 }, { path: "promoCode", message: "promoCode is text." }],
      [{ ...valid, businessId: 7 }, { path: "businessId", message: "businessId is text." }],
      [[valid], { path: "(body)", message: "A checkout request is a JSON object." }],
      [null, { path: "(body)", message: "A checkout request is a JSON object." }],
    ];
    for (const [body, { path, message }] of cases) {
      const response = await post(body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await response.json(), JSON.stringify(body)).toEqual(refusal(path, message));
    }
    const notJson = await post("{");
    expect(notJson.status).toBe(400);
    expect(await notJson.json()).toEqual({ error: "Invalid JSON body.", code: "invalid_json" });
    expect(fixture.create).not.toHaveBeenCalled();
  });

  it("takes the business from the request's address when the body names none, and asks for one otherwise", async () => {
    fixture.create.mockResolvedValue("request");
    expect((await post({ target: "starter", billingInterval: "monthly" }, "http://localhost:3000/api/billing/checkout?businessId=from-address")).status).toBe(202);
    expect(fixture.create).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.objectContaining({ businessId: "from-address", target: "starter", billingInterval: "monthly" }));
    const missing = await post({ businessId: null, target: "starter", billingInterval: "monthly" });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: "A businessId is required.", code: "invalid_request" });
    expect(fixture.create).toHaveBeenCalledOnce();
  });

  it("keeps a promo code as typed, and drops a blank one", async () => {
    fixture.create.mockResolvedValue("request");
    await post({ businessId: "business", target: "pro", billingInterval: "annual", promoCode: " LAUNCH " });
    await post({ businessId: "business", target: "pro", billingInterval: "annual", promoCode: "  " });
    expect(fixture.create.mock.calls[0]![1]).toMatchObject({ promoCode: " LAUNCH " });
    expect((fixture.create.mock.calls[1]![1] as { promoCode?: string }).promoCode).toBeUndefined();
  });
});

describe("reading a checkout request from the dashboard", () => {
  const requestId = "0b0e7c2c-6f0e-4c53-9a59-3d0c1b0a7f11";
  /** A transaction whose selects answer `fixture.rows` in turn: the request, then the billing account. */
  const transaction = () => fixture.transaction.mockImplementation(async (_request: Request, run: (scope: { businessId: string; tx: unknown }) => Promise<unknown>) => {
    const select = () => ({ from: () => ({ where: () => ({ limit: async () => fixture.rows.shift() ?? [] }) }) });
    return await run({ businessId: "business", tx: { select } });
  });

  // AUDIT-007: both were a 500, and a requestId that is no UUID reached PostgreSQL, which refused it.
  it("answers 400 for a missing requestId or one that is no id, before any query", async () => {
    transaction();
    const missing = await get("?businessId=business");
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual(refusal("requestId", "requestId is required."));
    const wrong = await get("?requestId=latest");
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toEqual(refusal("requestId", "requestId is the id a checkout request answered with."));
    expect(fixture.transaction).not.toHaveBeenCalled();
  });

  it("answers 404 for a request this business doesn't have", async () => {
    transaction();
    // The second is an id PostgreSQL takes though no UUID version made it: it is looked up, not refused.
    for (const id of [requestId, "11111111-1111-1111-1111-111111111111"]) {
      const response = await get(`?requestId=${id}`);
      expect(response.status, id).toBe(404);
      expect(await response.json()).toEqual({ error: "Checkout request not found.", code: "not_found" });
    }
    expect(fixture.transaction).toHaveBeenCalledTimes(2);
  });

  it("answers a request with whether the business is on its plan yet", async () => {
    transaction();
    fixture.rows.push(
      [{ id: requestId, status: "ready", checkoutId: "checkout", checkoutUrl: "https://pay.example/checkout", error: null, target: "pro", billingInterval: "annual", planCode: "pro" }],
      [{ plan: "pro", interval: "annual", state: "active", planCode: "pro", cancelAt: null, nextPlanCode: null }],
    );
    const response = await get(`?businessId=business&requestId=${requestId}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: requestId, status: "ready", synced: true, refusal: null });
  });
});
