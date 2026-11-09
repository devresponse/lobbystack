import { createHmac } from "node:crypto";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from "vitest";

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), store: vi.fn(), scope: vi.fn(), where: vi.fn(), catalog: vi.fn(), customer: vi.fn() }));
// storeBillingWebhookEvent's own tests run it against PostgreSQL.
vi.mock("@lobbystack/domain", async importOriginal => ({ ...await importOriginal<typeof import("@lobbystack/domain")>(), readBillingCatalogSnapshot: mocks.catalog, storeBillingWebhookEvent: mocks.store }));
vi.mock("@/lib/api-helpers", () => ({ getDispatcherDatabase: () => ({ db: {} }), getWorkerDatabase: () => ({ db: {} }) }));
vi.mock("@lobbystack/db", async importOriginal => ({
  ...await importOriginal<typeof import("@lobbystack/db")>(),
  withDispatcherTransaction: async (_db: unknown, callback: (tx: unknown) => unknown) => callback({ select: () => ({ from: () => ({ where: (condition: unknown) => { mocks.where(condition); return { limit: mocks.lookup }; } }) }) }),
  withBusinessTransaction: async (_db: unknown, scope: unknown, callback: (tx: unknown) => unknown) => {
    mocks.scope(scope);
    return callback({});
  },
}));
// The admin's Stripe key reads a charge's customer back for its business.
vi.mock("@lobbystack/providers/billing/factory", async importOriginal => {
  const actual = await importOriginal<typeof import("@lobbystack/providers/billing/factory")>();
  return { ...actual, createBillingProvider: () => ({ businessOfCustomer: mocks.customer }) };
});

import { POST } from "./route";
import { POST as POLAR } from "../polar/route";

// Stripe's billing webhook on a Stripe deployment (the Stripe plan's step 12):
// who may deliver, which business an event is for, and Polar's route answering 404.

const businessId = "ed4f1b6f-a237-4c09-8e26-68c3b976b110";
const secret = "whsec_route_test";
let logged: MockInstance<typeof console.error>;
let warned: MockInstance<typeof console.warn>;
const warnings = () => warned.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
const errors = () => logged.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);

function signed(body: string, options: { secrets?: string[]; at?: number } = {}) {
  const at = options.at ?? Math.floor(Date.now() / 1000);
  const signatures = (options.secrets ?? [secret]).map((key) => `v1=${createHmac("sha256", key).update(`${at}.${body}`).digest("hex")}`);
  return new Request("https://app.example.test/api/webhooks/stripe", { method: "POST", body, headers: { "stripe-signature": [`t=${at}`, ...signatures].join(",") } });
}

const subscriptionEvent = (fields: Record<string, unknown> = {}) => JSON.stringify({
  id: "evt_1",
  object: "event",
  type: "customer.subscription.updated",
  created: Math.floor(Date.now() / 1000),
  livemode: false,
  data: { object: { id: "sub_1", object: "subscription", customer: "cus_1", status: "active", items: { data: [] }, discounts: [], schedule: null, cancel_at: null, cancel_at_period_end: false, metadata: { lobbystack_business: businessId } } },
  ...fields,
});

const refundEvent = JSON.stringify({ id: "evt_2", object: "event", type: "charge.refunded", created: Math.floor(Date.now() / 1000), livemode: false, data: { object: { id: "ch_1", object: "charge", customer: "cus_1", payment_intent: "pi_1", amount: 8700, amount_refunded: 8700, currency: "cad", refunded: true, metadata: {} } } });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("BILLING_PROVIDER", "stripe");
  vi.stubEnv("STRIPE_API_KEY", "rk_test_admin123");
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", secret);
  mocks.lookup.mockResolvedValue([{ id: businessId }]);
  mocks.catalog.mockResolvedValue({ plans: [], prices: [] });
  mocks.customer.mockResolvedValue(businessId);
  // The first delivery is new, and Stripe's next one a duplicate.
  mocks.store.mockReset().mockResolvedValueOnce(true).mockResolvedValue(false);
  logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
  warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it("stores a signed event in the business its metadata names, as the worker, and says when Stripe sent it before", async () => {
  expect(await (await POST(signed(subscriptionEvent()))).json()).toEqual({ accepted: true, duplicate: false, eventId: "evt_1" });
  expect(await (await POST(signed(subscriptionEvent()))).json()).toEqual({ accepted: true, duplicate: true, eventId: "evt_1" });
  expect(mocks.scope).toHaveBeenCalledWith({ businessId, actorType: "worker" });
  expect(mocks.store).toHaveBeenCalledWith({}, { provider: "stripe", businessId, providerEventId: "evt_1", eventType: "customer.subscription.updated", payload: expect.objectContaining({ kind: "subscription", subscriptionId: "sub_1", subscriptionState: "active" }) });
  expect(new PgDialect().sqlToQuery(mocks.where.mock.calls[0]![0])).toMatchObject({ sql: '"businesses"."id" = $1', params: [businessId] });
  expect(mocks.customer).not.toHaveBeenCalled();
});

it("reads a charge's customer back for its business, and drops it when the customer names none", async () => {
  expect((await POST(signed(refundEvent))).status).toBe(200);
  expect(mocks.customer).toHaveBeenCalledWith("cus_1");
  expect(mocks.store).toHaveBeenCalledWith({}, expect.objectContaining({ businessId, eventType: "charge.refunded", payload: expect.objectContaining({ kind: "refund", paymentRef: "pi_1" }) }));
  mocks.customer.mockResolvedValue(null);
  expect(await (await POST(signed(refundEvent))).json()).toEqual({ accepted: true, ignored: true });
  expect(errors()).toEqual([{ event: "ops.billing.webhook_unresolved", provider: "stripe", eventType: "charge.refunded", reason: "no_reference" }]);
});

it("refuses a bad, old or missing signature, another secret, the other mode and no secret, and takes either secret during a rotation", async () => {
  const at = Math.floor(Date.now() / 1000);
  expect((await POST(signed(subscriptionEvent(), { secrets: ["whsec_other"] }))).status).toBe(401);
  expect((await POST(signed(subscriptionEvent(), { at: at - 600 }))).status).toBe(401);
  expect((await POST(new Request("https://app.example.test/api/webhooks/stripe", { method: "POST", body: subscriptionEvent() }))).status).toBe(401);
  expect((await POST(signed(subscriptionEvent({ livemode: true })))).status).toBe(401);
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", `whsec_next,${secret}`);
  expect((await POST(signed(subscriptionEvent()))).status).toBe(200);
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", "");
  expect((await POST(signed(subscriptionEvent()))).status).toBe(401);
  expect(warnings().filter((line) => line.message === "ops.billing.webhook_refused").map((line) => [line.provider, line.reason])).toEqual([
    ["stripe", "bad_signature"],
    ["stripe", "too_old"],
    ["stripe", "missing_headers"],
    ["stripe", "wrong_mode"],
    ["stripe", "unconfigured"],
  ]);
  const notAnEvent = JSON.stringify({ hello: "world" });
  expect((await POST(signed(notAnEvent, { secrets: [] }))).status).toBe(401);
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", secret);
  expect((await POST(signed(notAnEvent))).status).toBe(400);
});

it("answers 404 on the other provider's route, logging it at most once a minute", async () => {
  vi.useFakeTimers({ now: new Date("2026-11-08T12:00:00Z") });
  try {
    expect((await POLAR(new Request("https://app.example.test/api/webhooks/polar", { method: "POST", body: "{}" }))).status).toBe(404);
    expect((await POLAR(new Request("https://app.example.test/api/webhooks/polar", { method: "POST", body: "{}" }))).status).toBe(404);
    expect(warnings().filter((line) => line.message === "ops.billing.webhook_wrong_provider")).toEqual([expect.objectContaining({ provider: "polar", route: "/api/webhooks/polar" })]);
    vi.setSystemTime(new Date("2026-11-08T12:01:01Z"));
    vi.unstubAllEnvs();
    // Stripe's route on a Polar deployment.
    expect((await POST(signed(subscriptionEvent()))).status).toBe(404);
    expect(warnings().filter((line) => line.message === "ops.billing.webhook_wrong_provider").map((line) => line.route)).toEqual(["/api/webhooks/polar", "/api/webhooks/stripe"]);
    expect(mocks.store).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});
