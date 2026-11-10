import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Reconcile reads the kind the webhook stores beside each event since the
// Stripe plan's step 3, and an event stored before it by its name.

const mocks = vi.hoisted(() => ({
  recordAffiliateCommissionInTransaction: vi.fn(),
  withBusinessTransaction: vi.fn(),
}));

vi.mock("@lobbystack/db", async (original) => ({
  ...(await original<typeof import("@lobbystack/db")>()),
  withBusinessTransaction: mocks.withBusinessTransaction,
}));

vi.mock("./affiliates", () => ({ recordAffiliateCommissionInTransaction: mocks.recordAffiliateCommissionInTransaction }));
vi.mock("./productEvents", () => ({ recordProductEventInTransaction: vi.fn() }));

import { billingAccounts, billingTransactions } from "@lobbystack/db";

import { reconcileBillingProviderEvent } from "./billing";

type Write = { table: unknown; values?: Record<string, unknown>; set?: Record<string, unknown> };

/** Reconciles one stored event and returns what the transaction wrote, by table. */
async function reconcile(eventType: string, payload: Record<string, unknown>) {
  const writes: Write[] = [];
  // Selects in order: the provider event, then the existing account (none).
  const selects: unknown[][] = [[{ id: "evt_1", providerEventId: "polar_1", eventType, status: "pending", payload, createdAt: new Date("2026-11-08T00:00:00.000Z") }], []];
  const chain = (resolved: unknown[], write?: Write): unknown => new Proxy(function () {}, {
    get(_target, property) {
      if (property === "then") return (resolve: (value: unknown) => unknown) => resolve(resolved);
      return (argument: Record<string, unknown>) => {
        if (write && property === "values") write.values = argument;
        if (write && property === "onConflictDoUpdate") write.set = argument.set as Record<string, unknown>;
        return chain(resolved, write);
      };
    },
  });
  const tx = {
    execute: () => chain([]),
    select: () => chain(selects.shift() ?? []),
    insert: (table: unknown) => { const write: Write = { table }; writes.push(write); return chain([{ id: "txn_1" }], write); },
    update: () => chain([]),
  };
  mocks.withBusinessTransaction.mockImplementation(async (_db: unknown, _input: unknown, run: (tx: unknown) => Promise<unknown>) => await run(tx));
  await reconcileBillingProviderEvent({ db: {} as never }, { businessId: "biz_1", providerEventId: "evt_1" });
  return { account: writes.find((write) => write.table === billingAccounts), transaction: writes.find((write) => write.table === billingTransactions) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.recordAffiliateCommissionInTransaction.mockResolvedValue(null);
  // Both reconciles write the same time, so their rows compare equal.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-08T01:00:00.000Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the kind of a stored billing event", () => {
  const subscription = { billingKey: "business:biz_1", customerId: "cus_1", subscriptionId: "sub_1", productId: "prod_pro", plan: "pro", planCode: "pro", billingInterval: "monthly", status: "active", subscriptionModifiedAt: "2026-11-07T00:00:00.000Z" };
  const order = { billingKey: "business:biz_1", id: "order_1", total_amount: 8_700, currency: "cad", created_at: "2026-11-01T00:00:00.000Z", status: "paid" };

  it("reconciles a subscription stored before the kind to the same row as one stored with it", async () => {
    const before = await reconcile("subscription.active", subscription);
    const after = await reconcile("subscription.active", { ...subscription, kind: "subscription", priceRef: "prod_pro" });
    expect(after.account).toEqual(before.account);
    expect(after.account?.values).toMatchObject({ plan: "pro", subscriptionState: "active" });
  });

  it("reconciles an order stored before the kind to the same rows as one stored with it", async () => {
    const before = await reconcile("order.paid", order);
    const after = await reconcile("order.paid", { ...order, kind: "payment" });
    expect(after.transaction).toEqual(before.transaction);
    expect(after.account).toEqual(before.account);
    expect(after.transaction?.values).toMatchObject({ kind: "order", status: "paid", amountCents: 8_700 });
  });

  it("goes by the stored kind over the event's name", async () => {
    // A payment named the way another provider names it still makes a transaction.
    const payment = await reconcile("invoice.paid", { ...order, kind: "payment" });
    expect(payment.transaction?.values).toMatchObject({ kind: "order", status: "paid" });
    // An event its webhook stored as being about something else takes no subscription state from its status.
    const other = await reconcile("subscription.updated", { billingKey: "business:biz_1", status: "past_due", kind: "other" });
    expect(other.account?.values).not.toHaveProperty("subscriptionState");
  });
});
