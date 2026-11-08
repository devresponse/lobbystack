import { randomUUID } from "node:crypto";

import type { JobEnvelope } from "@lobbystack/contracts";
import { claimBillingUsageSync, confirmBillingUsageSync, loadBillingUsageEvent, loadUsageTotalsWork, recordProductEvent, recordUsageTotalsCheck, type UsageTotalsWork } from "@lobbystack/domain";
import { StripeBilling } from "@lobbystack/providers/stripe/adapter";
import { createFakeStripe, FakeClock, type FakeStripe } from "@lobbystack/providers/stripe/fake";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@lobbystack/shared", async (importOriginal) => (await import("./testing")).mockShared(importOriginal));
vi.mock("@lobbystack/domain", async (importOriginal) => ({
  ...(await (await import("./testing")).mockDomain(importOriginal)),
  loadUsageTotalsWork: vi.fn(),
  recordUsageTotalsCheck: vi.fn(),
  loadUsageGraceHours: vi.fn(async () => 1),
}));

import { handleJob } from "../handlers";
import { polarFake } from "./polarFake";

// Usage as money on Stripe (the Stripe plan's step 16): billing.syncUsage
// sending a priced, dated meter event, and the daily billing.checkUsageTotals,
// on the in-memory Stripe.

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

/** The next check, a day on: the domain makes it wait an hour after the last. */
function nextDay() {
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 24 * 60 * 60_000 });
}

const domain = { db: undefined as never };
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);
const monthStart = () => { const now = new Date(); return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)); };

/** An account with the overage meters and the business's customer, on today's clock. */
function withMeters(): { stripe: FakeStripe; billing: StripeBilling } {
  const stripe = createFakeStripe({ accountId: "acct_1", clock: new FakeClock(Math.floor(Date.now() / 1000)) });
  stripe.addCustomer({ id: "cus_1", businessId: "b1" });
  stripe.loadCatalog({ meters: [["voice", "ls_overage_voice"], ["alert_sms", "ls_overage_sms"], ["transfer", "ls_overage_transfers"]].map(([kind, event]) => ({ id: `mtr_${kind}`, display_name: kind!, event_name: event!, status: "active", default_aggregation: { formula: "sum" }, customer_mapping: { type: "by_id", event_payload_key: "stripe_customer_id" }, value_settings: { event_payload_key: "value" } })) });
  return { stripe, billing: new StripeBilling(stripe, { accountId: "acct_1", env: "sandbox" }) };
}

function job(type: JobEnvelope["type"], businessId: string, payload: Record<string, unknown> = {}): JobEnvelope {
  return { jobId: randomUUID(), type, queue: "critical", businessId, payload, trace: {}, idempotencyKey: `test:${randomUUID()}`, scheduled: false };
}

describe("billing.syncUsage on Stripe", () => {
  function usageRow(businessId: string, createdAt: Date) {
    vi.mocked(loadBillingUsageEvent).mockResolvedValue({ id: "usage-1", sourceKey: "voice:call-1", isFinal: true, plan: "pro", businessId, usageKind: "voice_seconds", quantity: 90, billableQuantity: null, billingIntervalAtRecordTime: null, createdAt, syncStatus: "pending", billingKey: `business:${businessId}`, customerId: "cus_1" });
  }

  it("sends the row's price at its first claimed rate, dated when the call happened, and confirms it", async () => {
    const { stripe, billing } = withMeters();
    const businessId = randomUUID();
    const createdAt = minutesAgo(10);
    usageRow(businessId, createdAt);
    vi.mocked(claimBillingUsageSync).mockResolvedValue({ externalId: "voice:call-1", quantity: 90, seq: 0, rateCents: 20, sentAt: new Date(), expired: false });
    expect(await handleJob(job("billing.syncUsage", businessId, { usageEventId: "usage-1" }), { domain, billing })).toEqual({ status: "completed", entityId: "usage-1" });
    // A minute and a half at 20 cents.
    expect(stripe.state.meterEvents).toEqual([{ event_name: "ls_overage_voice", customer: "cus_1", value: 0.3, identifier: "voice:call-1", timestamp: Math.floor(createdAt.getTime() / 1000) }]);
    expect(claimBillingUsageSync).toHaveBeenCalledWith(domain, { businessId, usageEventId: "usage-1", resendWithinMs: 20 * 60 * 60_000 });
    expect(confirmBillingUsageSync).toHaveBeenCalledWith(domain, { businessId, usageEventId: "usage-1", seq: 0 });
  });

  it("dates a correction its month's invoice can no longer take now, and confirms without sending an event Stripe forgot or one without a rate", async () => {
    const { stripe, billing } = withMeters();
    const businessId = randomUUID();
    usageRow(businessId, new Date(Date.now() - 50 * 24 * 60 * 60_000));
    vi.mocked(claimBillingUsageSync).mockResolvedValueOnce({ externalId: "voice:call-1:1", quantity: -30, seq: 1, rateCents: 20, sentAt: new Date(), expired: false });
    const before = Math.floor(Date.now() / 1000);
    await handleJob(job("billing.syncUsage", businessId, { usageEventId: "usage-1" }), { domain, billing });
    expect(stripe.state.meterEvents[0]).toMatchObject({ value: -0.1, identifier: "voice:call-1:1" });
    expect(stripe.state.meterEvents[0]!.timestamp).toBeGreaterThanOrEqual(before);
    vi.mocked(claimBillingUsageSync).mockResolvedValueOnce({ externalId: "voice:call-1:2", quantity: 30, seq: 2, rateCents: 20, sentAt: minutesAgo(21 * 60), expired: true });
    vi.mocked(claimBillingUsageSync).mockResolvedValueOnce({ externalId: "voice:call-1:3", quantity: 30, seq: 3, rateCents: null, sentAt: new Date(), expired: false });
    await handleJob(job("billing.syncUsage", businessId, { usageEventId: "usage-1" }), { domain, billing });
    await handleJob(job("billing.syncUsage", businessId, { usageEventId: "usage-1" }), { domain, billing });
    expect(stripe.state.meterEvents).toHaveLength(1);
    expect(vi.mocked(confirmBillingUsageSync).mock.calls.map(([, input]) => input.seq)).toEqual([1, 2, 3]);
  });
});

describe("billing.checkUsageTotals", () => {
  const work = (fields: Partial<UsageTotalsWork>): UsageTotalsWork => ({ customerId: "cus_1", since: new Date(monthStart().getTime() - 40 * 24 * 60 * 60_000), confirmed: { voice: 0, alert_sms: 0, transfer: 0 }, periodKey: new Date().toISOString().slice(0, 7), fixSeq: 0, currency: "cad", ...fields });
  const send = async (billing: StripeBilling, kind: "voice" | "alert_sms" | "transfer", cents: number, occurredAt = minutesAgo(5)) => await billing.reportUsage({ customer: { id: "cus_1", billingKey: "business:b1" }, businessId: "b1", kind, units: 1, amountCents: cents, occurredAt, identifier: randomUUID() });

  it("leaves a business whose meters hold what it sent, and keeps what the open month holds", async () => {
    const { stripe, billing } = withMeters();
    const businessId = randomUUID();
    await send(billing, "voice", 30);
    await send(billing, "alert_sms", 12);
    vi.mocked(loadUsageTotalsWork).mockResolvedValue(work({ confirmed: { voice: 30, alert_sms: 12, transfer: 0 } }));
    expect(await handleJob(job("billing.checkUsageTotals", businessId), { domain, billing })).toEqual({ status: "completed", entityId: businessId });
    expect(stripe.state.meterEvents).toHaveLength(2);
    expect(recordUsageTotalsCheck).toHaveBeenCalledWith(domain, { businessId, periodKey: work({}).periodKey, providerOverageCents: 42, fixSeq: 0, checkedAt: expect.any(Date) });
  });

  it("sends an event Stripe never had into the open month, once, and reports the gap", async () => {
    const { stripe, billing } = withMeters();
    const businessId = randomUUID();
    await send(billing, "voice", 30);
    // A call's 20 cents never reached Stripe.
    vi.mocked(loadUsageTotalsWork).mockResolvedValue(work({ confirmed: { voice: 50, alert_sms: 0, transfer: 0 } }));
    await handleJob(job("billing.checkUsageTotals", businessId), { domain, billing });
    expect(stripe.state.meterEvents.at(-1)).toMatchObject({ event_name: "ls_overage_voice", value: 0.2, identifier: `fix:${businessId}:${work({}).periodKey}:voice:0` });
    expect(recordProductEvent).toHaveBeenCalledWith(domain, expect.objectContaining({ name: "ops.billing.usage_totals_mismatch", businessId, properties: { provider: "stripe", kind: "voice", gapCents: 20, periodKey: work({}).periodKey } }));
    expect(recordUsageTotalsCheck).toHaveBeenLastCalledWith(domain, expect.objectContaining({ providerOverageCents: 50, fixSeq: 1 }));
    // The next day the meters hold it, and nothing more goes out.
    nextDay();
    vi.mocked(loadUsageTotalsWork).mockResolvedValue(work({ confirmed: { voice: 50, alert_sms: 0, transfer: 0 }, fixSeq: 1 }));
    await handleJob(job("billing.checkUsageTotals", businessId), { domain, billing });
    expect(stripe.state.meterEvents).toHaveLength(2);
  });

  it("takes back what Stripe counted twice, and credits the balance for what the open month can't take", async () => {
    const { stripe, billing } = withMeters();
    const businessId = randomUUID();
    // Last month's transfer went out twice, and this month holds 10 cents of it.
    await send(billing, "transfer", 100, new Date(monthStart().getTime() - 24 * 60 * 60_000));
    await send(billing, "transfer", 100, new Date(monthStart().getTime() - 24 * 60 * 60_000));
    await send(billing, "transfer", 10);
    vi.mocked(loadUsageTotalsWork).mockResolvedValue(work({ confirmed: { voice: 0, alert_sms: 0, transfer: 110 } }));
    await handleJob(job("billing.checkUsageTotals", businessId), { domain, billing });
    // The open month goes to zero, and the other 90 cents become a credit.
    expect(stripe.state.meterEvents.at(-1)).toMatchObject({ event_name: "ls_overage_transfers", value: -0.1 });
    expect(stripe.state.balanceTransactions).toMatchObject([{ amount: -90, currency: "cad", metadata: { lobbystack_role: "usage_credit", lobbystack_overage: "transfer" } }]);
    // The next day the meters and the credit together match what was sent.
    nextDay();
    vi.mocked(loadUsageTotalsWork).mockResolvedValue(work({ confirmed: { voice: 0, alert_sms: 0, transfer: 110 }, fixSeq: 1 }));
    await handleJob(job("billing.checkUsageTotals", businessId), { domain, billing });
    expect(stripe.state.meterEvents).toHaveLength(4);
    expect(stripe.state.balanceTransactions).toHaveLength(1);
  });

  it("waits an hour while an event is in flight, skips a business with nothing priced, and leaves Polar alone", async () => {
    const { billing } = withMeters();
    vi.mocked(loadUsageTotalsWork).mockResolvedValueOnce({ wait: "in_flight" });
    expect(await handleJob(job("billing.checkUsageTotals", "b1"), { domain, billing })).toMatchObject({ status: "deferred", retryAt: expect.any(Date) });
    vi.mocked(loadUsageTotalsWork).mockResolvedValueOnce({ wait: "nothing" });
    expect(await handleJob(job("billing.checkUsageTotals", "b1"), { domain, billing })).toMatchObject({ status: "skipped" });
    expect(await handleJob(job("billing.checkUsageTotals", "b1"), { domain, billing: polarFake({}) })).toMatchObject({ status: "skipped" });
    expect(loadUsageTotalsWork).toHaveBeenCalledTimes(2);
  });
});
