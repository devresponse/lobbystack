import type { StripeCatalogApi, StripeSnapshot } from "../catalog";
import type { StripeApi } from "../client";
import { fakeCatalog, loadFakeCatalog } from "./catalog";
import { FakeClock } from "./clock";
import { FakeStripeContext, type FakeStripeRequest, type FakeStripeState } from "./context";
import { addFakeCustomer, fakeCustomers } from "./customers";
import { stripeInvoiceObject, stripeScheduleObject, stripeSubscriptionObject, type FakeSubscriptionInput } from "./objects";
import { fakeAccounts, fakeBillingPortal } from "./portal";
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
    customers: fakeCustomers(fake),
    subscriptions: fakeSubscriptions(fake),
    billingPortal: { ...fakeBillingPortal(fake), ...catalog.billingPortal },
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
    loadCatalog: (snapshot) => loadFakeCatalog(fake.state.catalog, snapshot),
    cutAfterWrites: (writes) => {
      fake.state.catalog.writesLeft = writes;
    },
  };
}
