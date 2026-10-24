import { createHmac } from "node:crypto";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from "vitest";

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), store: vi.fn(), scope: vi.fn(), where: vi.fn(), catalog: vi.fn() }));
// storePolarWebhookEvent's own tests run it against PostgreSQL.
vi.mock("@lobbystack/domain", async importOriginal => ({ ...await importOriginal<typeof import("@lobbystack/domain")>(), readBillingCatalogSnapshot: mocks.catalog, storePolarWebhookEvent: mocks.store }));
vi.mock("@lobbystack/providers", () => import("../../../../../../packages/providers/src/polar/webhook"));
vi.mock("@/lib/api-helpers", () => ({ getDispatcherDatabase: () => ({ db: {} }), getWorkerDatabase: () => ({ db: {} }) }));
vi.mock("@lobbystack/db", async importOriginal => ({
  ...await importOriginal<typeof import("@lobbystack/db")>(),
  withDispatcherTransaction: async (_db: unknown, callback: (tx: unknown) => unknown) => callback({ select: () => ({ from: () => ({ where: (condition: unknown) => { mocks.where(condition); return { limit: mocks.lookup }; } }) }) }),
  withBusinessTransaction: async (_db: unknown, scope: unknown, callback: (tx: unknown) => unknown) => {
    mocks.scope(scope);
    return callback({});
  },
}));

import { POST } from "./route";
const businessId = "ed4f1b6f-a237-4c09-8e26-68c3b976b110";
const secret = Buffer.from("polar-route-test-secret").toString("base64");
let logged: MockInstance<typeof console.error>;
let warned: MockInstance<typeof console.warn>;
const unresolvedLogs = () => logged.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
const refusalLogs = () => warned.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>).map(({ message, reason, webhookId }) => ({ message, reason, webhookId }));

function request(reference = businessId, options: { id?: string; timestamp?: number; body?: string; signature?: string } = {}) {
  const body = options.body ?? JSON.stringify({ type: "subscription.active", data: { customer: { external_id: `business:${reference}` }, id: "sub-1", status: "active" } });
  const id = options.id ?? "delivery-1";
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
  const signature = options.signature ?? `v1,${createHmac("sha256", Buffer.from(secret, "base64")).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
  return new Request("https://app.example.test/api/webhooks/polar", { method: "POST", body, headers: { "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": signature } });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("POLAR_WEBHOOK_SECRET", secret);
  vi.stubEnv("POLAR_ACCEPT_LEGACY_BUSINESS_IDS", "false");
  mocks.lookup.mockResolvedValue([{ id: businessId }]);
  mocks.catalog.mockResolvedValue({ plans: [], prices: [] });
  // The first delivery is new, and Polar's next one a duplicate.
  mocks.store.mockReset().mockResolvedValueOnce(true).mockResolvedValue(false);
  logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
  warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it("stores a signed UUID delivery in its business, as the worker, and says when Polar sent it before", async () => {
  expect(await (await POST(request())).json()).toEqual({ accepted: true, duplicate: false, eventId: "delivery-1" });
  expect(await (await POST(request())).json()).toEqual({ accepted: true, duplicate: true, eventId: "delivery-1" });
  expect(mocks.scope).toHaveBeenCalledWith({ businessId, actorType: "worker" });
  expect(mocks.store).toHaveBeenCalledTimes(2);
  expect(mocks.store).toHaveBeenCalledWith({}, { businessId, providerEventId: "delivery-1", eventType: "subscription.active", payload: expect.any(Object) });
  expect(new PgDialect().sqlToQuery(mocks.where.mock.calls[0]![0])).toMatchObject({ sql: '"businesses"."id" = $1', params: [businessId] });
});

it("names the plan through the catalog's Polar links, read as the worker", async () => {
  mocks.catalog.mockResolvedValue({ plans: [], prices: [{ plan: "pro", tier: "pro", status: "active", period: "annual", currency: "cad", cents: 96_000, per_month: 8_000, polar_id: "prod_pro_year", retired: false }] });
  const body = JSON.stringify({ type: "subscription.updated", data: { id: "sub-1", status: "active", product_id: "prod_pro_year", customer: { external_id: `business:${businessId}` } } });
  expect((await POST(request(businessId, { body }))).status).toBe(200);
  expect(mocks.scope).toHaveBeenCalledWith({ actorType: "worker" });
  expect(mocks.store).toHaveBeenCalledWith({}, expect.objectContaining({ payload: expect.objectContaining({ plan: "pro", billingInterval: "annual" }) }));
});

it("resolves legacy references only with the explicit compatibility flag", async () => {
  expect(await (await POST(request("legacy-business"))).json()).toEqual({ accepted: true, ignored: true });
  expect(mocks.lookup).not.toHaveBeenCalled();
  vi.stubEnv("POLAR_ACCEPT_LEGACY_BUSINESS_IDS", "true");
  expect((await POST(request("legacy-business"))).status).toBe(200);
  expect(mocks.lookup).toHaveBeenCalledTimes(1);
  expect(mocks.store).toHaveBeenCalledTimes(1);
  expect(new PgDialect().sqlToQuery(mocks.where.mock.calls[0]![0])).toMatchObject({ sql: '"businesses"."legacy_convex_id" = $1', params: ["legacy-business"] });
});

it("ignores unknown businesses without persisting or enqueueing", async () => {
  mocks.lookup.mockResolvedValue([]);
  expect(await (await POST(request())).json()).toEqual({ accepted: true, ignored: true });
  expect(mocks.store).not.toHaveBeenCalled();
  expect(unresolvedLogs()).toEqual([{ event: "ops.billing.webhook_unresolved", provider: "polar", eventType: "subscription.active", reason: "unknown_business", businessReference: businessId }]);
});

it("logs ops.billing.webhook_unresolved when no field identifies a business", async () => {
  // A subscription that cannot be attributed is dropped with a 200, so this
  // log line is the only trace that money moved and nothing applied.
  expect(await (await POST(request("kh797h57jgpq83314s4fj8ptmn866hbk"))).json()).toEqual({ accepted: true, ignored: true });
  expect(mocks.lookup).not.toHaveBeenCalled();
  expect(unresolvedLogs()).toEqual([{ event: "ops.billing.webhook_unresolved", provider: "polar", eventType: "subscription.active", reason: "no_reference", businessReference: "kh797h57jgpq83314s4fj8ptmn866hbk" }]);
});

it("resolves a migrated customer from metadata instead of dropping it", async () => {
  // The live failure: Polar reused a customer created before the migration, so
  // external_id still held the Convex id while metadata carried the real one.
  const body = JSON.stringify({
    type: "subscription.active",
    data: {
      id: "sub-1",
      status: "active",
      customer: {
        external_id: "business:kh797h57jgpq83314s4fj8ptmn866hbk",
        metadata: { externalCustomerId: `business:${businessId}` },
      },
    },
  });
  expect(await (await POST(request(businessId, { body }))).json()).toEqual({ accepted: true, duplicate: false, eventId: "delivery-1" });
  expect(mocks.store).toHaveBeenCalledWith({}, expect.objectContaining({ businessId }));
  expect(logged).not.toHaveBeenCalled();
});

it("rejects invalid, stale, missing, and unconfigured signatures before DB access", async () => {
  expect((await POST(request(businessId, { signature: "v1,invalid" }))).status).toBe(401);
  expect((await POST(request(businessId, { timestamp: 1 }))).status).toBe(401);
  const missing = request(); missing.headers.delete("webhook-id");
  expect((await POST(missing)).status).toBe(401);
  const tampered = request(); tampered.headers.set("webhook-id", "other-delivery");
  expect((await POST(tampered)).status).toBe(401);
  vi.stubEnv("POLAR_WEBHOOK_SECRET", "");
  expect((await POST(request())).status).toBe(401);
  expect(mocks.lookup).not.toHaveBeenCalled();
  // Polar turns the endpoint off after 10 refusals in a row, so each one is logged, with Polar's delivery ID and never the body.
  const refused = { message: "ops.billing.webhook_refused" };
  expect(refusalLogs()).toEqual([
    { ...refused, reason: "bad_signature", webhookId: "delivery-1" },
    { ...refused, reason: "bad_signature", webhookId: "delivery-1" },
    { ...refused, reason: "missing_headers", webhookId: undefined },
    { ...refused, reason: "bad_signature", webhookId: "other-delivery" },
    { ...refused, reason: "unconfigured", webhookId: "delivery-1" },
  ]);
});

it("reports a failure with an error ID that Polar's delivery log shows too", async () => {
  mocks.catalog.mockRejectedValue(new Error("connection terminated"));
  const response = await POST(request());
  expect(response.status).toBe(500);
  const { errorId } = await response.json() as { errorId: string };
  expect(response.headers.get("x-error-id")).toBe(errorId);
  await vi.waitFor(() => expect(unresolvedLogs()).toContainEqual(expect.objectContaining({ level: "error", message: expect.stringMatching(/\] exception: connection terminated$/), operation: "billing.webhook", errorId, eventType: "subscription.active", webhookId: "delivery-1" })));
});

it("rejects malformed JSON in the verifier and invalid event envelopes in the route", async () => {
  expect((await POST(request(businessId, { body: "{" }))).status).toBe(401);
  for (const body of ["null", "[]", "{}"])
    expect((await POST(request(businessId, { body }))).status).toBe(400);
  expect(mocks.lookup).not.toHaveBeenCalled();
});
