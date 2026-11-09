import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  recordProductEventInTransaction: vi.fn(),
  recordPackPurchaseInTransaction: vi.fn(),
  readPackPlan: vi.fn(),
  enqueueOutbox: vi.fn(),
}));

vi.mock("@lobbystack/db", async (original) => ({
  ...(await original<typeof import("@lobbystack/db")>()),
  enqueueOutbox: mocks.enqueueOutbox,
}));
vi.mock("./productEvents", () => ({ recordProductEventInTransaction: mocks.recordProductEventInTransaction }));
vi.mock("./affiliates", () => ({ recordAffiliateCommissionInTransaction: vi.fn() }));
vi.mock("./receptionists", () => ({ enqueueReceptionistAllowanceCheck: vi.fn() }));
vi.mock("./billingPacks", async (original) => ({
  ...(await original<typeof import("./billingPacks")>()),
  lockBusinessPacks: vi.fn(),
  readLivePacks: vi.fn(async () => []),
  readPackPlan: mocks.readPackPlan,
  recordPackPurchaseInTransaction: mocks.recordPackPurchaseInTransaction,
  clearPackNumberReleaseInTransaction: vi.fn(async () => 0),
  applyPackRefundInTransaction: vi.fn(async () => null),
}));

import { validateTelemetryEvent } from "@lobbystack/telemetry";

import { applyPackEventInTransaction, type PackEventInput } from "./billingPackEvents";

// The pack step's telemetry and its reach, with the ledger stubbed: the
// purchase is reported once, on the reconciling transaction, with every
// property the taxonomy requires, and an event about no pack touches nothing.
// The writes themselves are in billingPackEvents.integration.test.ts.

const businessId = "4f1b6fed-a237-4c09-8e26-68c3b976b110";
const terms = { code: "pack_500_90", voiceSec: 30_000, days: 90, smsSeg: 50, callsOut: 20, chatUnits: 50, kbBytes: 20 * 1_048_576, numbers: 1, receptionists: 1 };

/** A transaction whose selects answer in order and whose writes return a paid order row. */
function transaction(selects: unknown[][]) {
  const chain = (resolved: unknown[]): unknown => new Proxy(function () {}, {
    get(_target, property) {
      if (property === "then") return (resolve: (value: unknown) => unknown) => resolve(resolved);
      return () => chain(resolved);
    },
  });
  return {
    execute: () => chain([]),
    select: () => chain(selects.shift() ?? []),
    insert: () => chain([{ id: "txn_1", status: "paid", amountCents: 10_450, refundedAmountCents: 0, currency: "cad", occurredAt: new Date() }]),
    update: () => chain([]),
  } as never;
}

function stripePackPaid(): PackEventInput {
  return {
    businessId,
    provider: "stripe",
    kind: "checkout",
    eventId: "evt_1",
    eventCreatedAt: new Date(),
    payload: { kind: "checkout", role: "pack", packCode: "pack_500_90", paymentRef: "pi_1", packOutcome: "paid", amountCents: 10_450, currency: "cad", occurredAt: new Date().toISOString() },
    account: { subscriptionId: null, plan: "free_cloud", subscriptionState: null, billingInterval: null, managed: false, replacedSubscriptionId: null },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readPackPlan.mockResolvedValue(terms);
  mocks.recordProductEventInTransaction.mockResolvedValue("event_1");
});

describe("the pack step's telemetry", () => {
  it("reports a pack bought on the reconciling transaction, with every property the taxonomy requires", async () => {
    mocks.recordPackPurchaseInTransaction.mockResolvedValue({ packId: "pack_1", created: true });
    const tx = transaction([[], []]);
    await expect(applyPackEventInTransaction(tx, stripePackPaid())).resolves.toBe(true);

    expect(mocks.recordProductEventInTransaction).toHaveBeenCalledTimes(1);
    const [usedTx, event] = mocks.recordProductEventInTransaction.mock.calls[0]! as [unknown, { name: "billing.pack_purchased"; businessId: string; actorType: string; properties: Record<string, string> }];
    expect(usedTx).toBe(tx);
    expect(event).toMatchObject({ name: "billing.pack_purchased", businessId, actorType: "worker", properties: { pack: "pack_500_90", days: "90", provider: "stripe", previousPlan: "free_cloud" } });
    // A null property fails the taxonomy, which outside cloud throws and would roll the payment back.
    expect(validateTelemetryEvent({ name: event.name, deploymentMode: "development", businessId, properties: event.properties }).ok).toBe(true);
  });

  it("names a pack that never ends and a top-up in terms the taxonomy accepts", async () => {
    mocks.readPackPlan.mockResolvedValue({ ...terms, days: null });
    mocks.recordPackPurchaseInTransaction.mockResolvedValue({ packId: "pack_2", created: true });
    const { readLivePacks } = await import("./billingPacks");
    vi.mocked(readLivePacks).mockResolvedValueOnce([{ id: "pack_1" } as never]);
    await applyPackEventInTransaction(transaction([[], []]), stripePackPaid());

    const event = mocks.recordProductEventInTransaction.mock.calls[0]![1] as { properties: Record<string, string> };
    expect(event.properties).toMatchObject({ days: "never", previousPlan: "prepaid" });
  });

  it("reports nothing when the same payment arrives again", async () => {
    mocks.recordPackPurchaseInTransaction.mockResolvedValue({ packId: "pack_1", created: false });
    await applyPackEventInTransaction(transaction([[], []]), stripePackPaid());
    expect(mocks.recordProductEventInTransaction).not.toHaveBeenCalled();
    expect(mocks.enqueueOutbox).not.toHaveBeenCalled();
  });
});

describe("the pack step's reach", () => {
  it("touches nothing for an event about no pack", async () => {
    const plain = (kind: string, provider: string, payload: Record<string, unknown> = {}): PackEventInput => ({ ...stripePackPaid(), kind, provider, payload });
    const tx = transaction([]);
    for (const event of [plain("subscription", "stripe"), plain("checkout", "stripe", { kind: "checkout", checkoutRequestId: "chk_1" }), plain("payment", "polar"), plain("refund", "stripe", { paymentRef: "pi_1" }), plain("dispute", "stripe")]) {
      await expect(applyPackEventInTransaction(tx, event)).resolves.toBe(false);
    }
    expect(mocks.recordPackPurchaseInTransaction).not.toHaveBeenCalled();
    expect(mocks.enqueueOutbox).not.toHaveBeenCalled();
    expect(mocks.recordProductEventInTransaction).not.toHaveBeenCalled();
  });

  it("reads nothing past the pack lookup for a dispute or a Polar order no pack has", async () => {
    const events: PackEventInput[] = [
      { ...stripePackPaid(), kind: "dispute", payload: { id: "dp_1", kind: "dispute", paymentRef: "pi_plan_1", disputeOutcome: "opened" } },
      { ...stripePackPaid(), provider: "polar", kind: "payment", payload: { kind: "payment" }, order: { transactionId: "txn_1", orderId: "order_1", status: "paid", amountCents: 3_000, refundedCents: 0, currency: "usd", occurredAt: new Date(), productId: "0b6c3a51-7e1d-4f2a-9c87-2d5e8f4a6b10", metadata: { lobbystack_pack_checkout: "5d3f4a8e-1b2c-4d6e-8f90-a1b2c3d4e5f6" }, checkoutId: "chk_1" } },
    ];
    for (const event of events) {
      const tx = transaction([]) as unknown as { select: () => unknown };
      const select = tx.select;
      let reads = 0;
      tx.select = () => { reads += 1; return select(); };
      await expect(applyPackEventInTransaction(tx as never, event)).resolves.toBe(false);
      expect(reads).toBe(1);
    }
    expect(mocks.enqueueOutbox).not.toHaveBeenCalled();
  });
});
