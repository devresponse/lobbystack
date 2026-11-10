import Stripe from "stripe";

import type { StripeApi } from "../client";
import type { FakeStripeContext } from "./context";
import { invalid, missing } from "./errors";

// Usage as money (the Stripe plan's step 16): meter events, their summaries
// for a customer, and the customer balance's credits. A meter sums its
// events' values, the way the overage meters pnpm billing makes do.

/** A list Stripe pages: awaited for its first page, or walked with autoPagingToArray. */
function paged<T>(fake: FakeStripeContext, name: string, params: unknown, items: () => T[]) {
  let pending: Promise<{ object: "list"; data: T[]; has_more: boolean }> | undefined;
  const page = () => (pending ??= fake.call(name, params, null, () => ({ object: "list" as const, data: items(), has_more: false })));
  return { then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => page().then(resolve, reject), autoPagingToArray: async () => (await page()).data };
}

/** billing.meterEvents.create: an active meter's event, once per identifier. */
export function fakeMeterEvents(fake: FakeStripeContext): StripeApi["billing"]["meterEvents"] {
  return {
    async create(params: Stripe.Billing.MeterEventCreateParams) {
      return await fake.call("billing.meterEvents.create", params, null, () => {
        const meter = fake.state.catalog.meters.find((entry) => entry.event_name === params.event_name && entry.status === "active");
        if (!meter) throw invalid(`No active meter was found matching event_name ${params.event_name}.`, "event_name");
        const customer = params.payload.stripe_customer_id ?? "";
        if (!fake.state.customers.has(customer)) throw missing("customer", customer, "payload[stripe_customer_id]");
        const identifier = params.identifier ?? fake.nextId("mev");
        if (fake.state.meterEvents.some((event) => event.identifier === identifier)) {
          throw new Stripe.errors.StripeInvalidRequestError({ type: "invalid_request_error", code: "resource_already_exists", message: `An event with identifier ${identifier} already exists.`, param: "identifier" });
        }
        const event = { event_name: params.event_name, customer, value: Number(params.payload.value), identifier, timestamp: params.timestamp ?? fake.clock.now() };
        fake.state.meterEvents.push(event);
        return { object: "billing.meter_event", event_name: event.event_name, identifier, payload: params.payload, timestamp: event.timestamp, created: fake.clock.now(), livemode: false } as unknown as Stripe.Billing.MeterEvent;
      });
    },
  } as unknown as StripeApi["billing"]["meterEvents"];
}

/** billing.meters.listEventSummaries: one summary of the customer's events on the meter, from start_time up to end_time. */
export function fakeEventSummaries(fake: FakeStripeContext): Pick<StripeApi["billing"]["meters"], "listEventSummaries"> {
  return {
    listEventSummaries: (meterId: string, params: Stripe.Billing.MeterListEventSummariesParams) => paged(fake, "billing.meters.listEventSummaries", { id: meterId, ...params }, () => {
      const meter = fake.state.catalog.meters.find((entry) => entry.id === meterId);
      if (!meter) throw missing("billing.meter", meterId);
      const value = fake.state.meterEvents
        .filter((event) => event.event_name === meter.event_name && event.customer === params.customer && event.timestamp >= params.start_time && event.timestamp < params.end_time)
        .reduce((sum, event) => sum + event.value, 0);
      return [{ id: fake.nextId("mtrusg"), object: "billing.meter_event_summary", aggregated_value: value, start_time: params.start_time, end_time: params.end_time, meter: meterId, livemode: false }];
    }),
  } as unknown as Pick<StripeApi["billing"]["meters"], "listEventSummaries">;
}

/** customers.createBalanceTransaction and listBalanceTransactions, newest first. */
export function fakeBalanceTransactions(fake: FakeStripeContext): Pick<StripeApi["customers"], "createBalanceTransaction" | "listBalanceTransactions"> {
  return {
    async createBalanceTransaction(customerId: string, params: Stripe.CustomerCreateBalanceTransactionParams, options: Stripe.RequestOptions = {}) {
      return await fake.call("customers.createBalanceTransaction", { id: customerId, ...params }, options.idempotencyKey ?? null, () => {
        if (!fake.state.customers.has(customerId)) throw missing("customer", customerId);
        const transaction = { id: fake.nextId("cbtxn"), object: "customer_balance_transaction", customer: customerId, amount: params.amount, currency: params.currency, description: params.description ?? null, metadata: { ...((params.metadata ?? {}) as Record<string, string>) }, type: "adjustment", created: fake.clock.now() } as unknown as Stripe.CustomerBalanceTransaction;
        fake.state.balanceTransactions.unshift(transaction);
        return transaction;
      });
    },
    listBalanceTransactions: (customerId: string, params: Stripe.CustomerListBalanceTransactionsParams = {}) => paged(fake, "customers.listBalanceTransactions", { id: customerId, ...params }, () => fake.state.balanceTransactions.filter((transaction) => transaction.customer === customerId)),
  } as unknown as Pick<StripeApi["customers"], "createBalanceTransaction" | "listBalanceTransactions">;
}
