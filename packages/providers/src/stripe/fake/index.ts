import type Stripe from "stripe";

import type { StripeCatalogApi, StripeSnapshot } from "../catalog";
import type { StripeApi } from "../client";
import { fakeCatalog, loadFakeCatalog } from "./catalog";
import { completeFakeCheckout, fakeCheckout } from "./checkout";
import { FakeClock } from "./clock";
import { FakeStripeContext, type FakeStripeRequest, type FakeStripeState } from "./context";
import { addFakeCustomer, fakeCustomers } from "./customers";
import { stripeInvoiceObject, stripeScheduleObject, stripeSubscriptionObject, type FakeSubscriptionInput } from "./objects";
import { fakeBalanceTransactions, fakeEventSummaries, fakeMeterEvents } from "./meterEvents";
import { dropFakePendingUpdate, fakeInvoices, payFakeInvoice } from "./pendingUpdates";
import { fakeAccounts, fakeBillingPortal } from "./portal";
import { enterFakeSchedulePhase, fakeSchedules } from "./schedules";
import { fakeSubscriptions } from "./subscriptions";

// An in-memory Stripe for the adapter's and the catalog client's tests (the
// Stripe plan's steps 9 and 11): the calls StripeApi and StripeCatalogApi
// name, on objects in maps, answered with Stripe's own error classes and
// idempotency. A file per kind of object several flows use; an
// object only one flow uses arrives with that flow, in a file of its own.

export { chargeFakeCard, fakeCardOutcomes, type FakeCard } from "./cards";
export { emptyFakeCatalog, loadFakeCatalog, type FakeCatalogState } from "./catalog";
export { FakeClock } from "./clock";
export { stripeInvoiceObject, stripePriceObject, stripeScheduleObject, stripeSubscriptionObject, type FakeSubscriptionInput } from "./objects";

export type FakeStripe = StripeApi & StripeCatalogApi & {
  state: FakeStripeState;
  requests: FakeStripeRequest[];
  clock: FakeClock;
  addCustomer(input: { id: string; businessId?: string; deleted?: boolean; email?: string }): void;
  addSubscription(input: FakeSubscriptionInput): void;
  addSchedule(input: { id: string; subscription: string; phases: Array<{ start: number; end: number | null; price: string }> }): void;
  addInvoice(input: { id: string; customer: string; subscription: string | null; hostedInvoiceUrl?: string | null }): void;
  /** Pays a checkout session with a card, making its subscription. */
  completeCheckout(sessionId: string, input?: { card?: string }): Stripe.Subscription;
  /** Pays an open invoice, as the customer does on its page, applying the pending update it carries. */
  payInvoice(invoiceId: string): Stripe.Invoice;
  /** A pending update's expiry: its invoice voided and the update dropped. */
  expirePendingUpdate(subscriptionId: string): void;
  /** The renewal under a schedule: the subscription takes its next phase. */
  enterSchedulePhase(subscriptionId: string): Stripe.Subscription;
  /** A payment intent that paid an invoice. */
  addInvoicePayment(input: { invoice: string; paymentIntent: string }): void;
  /** Puts a snapshot's catalog objects into the account. */
  loadCatalog(snapshot: Partial<Pick<StripeSnapshot, "products" | "prices" | "meters" | "coupons" | "portalConfigurations" | "webhooks" | "eventDestinations" | "tax">>): void;
  /** Lets this many catalog writes through, then drops the connection on each one after, as for a run cut off halfway. Null lets every one through. */
  cutAfterWrites(writes: number | null): void;
};

export function createFakeStripe(options: { accountId?: string; clock?: FakeClock } = {}): FakeStripe {
  const fake = new FakeStripeContext(options.clock ?? new FakeClock(), options.accountId ?? "acct_fake");
  const catalog = fakeCatalog(fake, fake.state.catalog);
  return {
    ...catalog,
    accounts: fakeAccounts(fake),
    customers: { ...fakeCustomers(fake), ...fakeBalanceTransactions(fake) },
    billing: { ...catalog.billing, meters: { ...catalog.billing.meters, ...fakeEventSummaries(fake) }, meterEvents: fakeMeterEvents(fake) },
    subscriptions: fakeSubscriptions(fake),
    subscriptionSchedules: fakeSchedules(fake),
    invoices: fakeInvoices(fake),
    billingPortal: { ...fakeBillingPortal(fake), ...catalog.billingPortal },
    checkout: fakeCheckout(fake),
    invoicePayments: {
      // By the payment intent, or by the invoice with each payment intent's status when expanded.
      list: async (params: { payment?: { payment_intent?: string }; invoice?: string; expand?: string[] }) => await fake.call("invoicePayments.list", params, null, () => ({
        object: "list",
        data: fake.state.invoicePayments.filter((entry) => (params.invoice ? entry.invoice === params.invoice : entry.paymentIntent === params.payment?.payment_intent)).map((entry) => ({ object: "invoice_payment", invoice: entry.invoice, payment: { type: "payment_intent", payment_intent: params.expand?.includes("data.payment.payment_intent") ? { id: entry.paymentIntent, object: "payment_intent", status: entry.status ?? "succeeded" } : entry.paymentIntent } })),
        has_more: false,
      })),
    } as unknown as FakeStripe["invoicePayments"],
    state: fake.state,
    requests: fake.requests,
    clock: fake.clock,
    addCustomer: (input) => addFakeCustomer(fake, input),
    addSubscription: (input) => {
      fake.state.subscriptions.set(input.id, stripeSubscriptionObject(input, fake.clock.now()));
    },
    addSchedule: (input) => {
      fake.state.schedules.set(input.id, stripeScheduleObject(input));
    },
    addInvoice: (input) => {
      fake.state.invoices.set(input.id, stripeInvoiceObject(input));
    },
    completeCheckout: (sessionId, input) => completeFakeCheckout(fake, sessionId, input),
    payInvoice: (invoiceId) => payFakeInvoice(fake, invoiceId),
    expirePendingUpdate: (subscriptionId) => {
      dropFakePendingUpdate(fake, subscriptionId);
    },
    enterSchedulePhase: (subscriptionId) => enterFakeSchedulePhase(fake, subscriptionId),
    addInvoicePayment: (input) => {
      fake.state.invoicePayments.push({ ...input });
    },
    loadCatalog: (snapshot) => loadFakeCatalog(fake.state.catalog, snapshot),
    cutAfterWrites: (writes) => {
      fake.state.catalog.writesLeft = writes;
    },
  };
}
