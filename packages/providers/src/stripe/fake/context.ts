import type Stripe from "stripe";

import { emptyFakeCatalog, type FakeCatalogState } from "./catalog";
import { FakeClock } from "./clock";
import { idempotencyMismatch } from "./errors";

/** What the fake Stripe holds. */
export type FakeStripeState = {
  accountId: string;
  customers: Map<string, Stripe.Customer | Stripe.DeletedCustomer>;
  subscriptions: Map<string, Stripe.Subscription>;
  schedules: Map<string, Stripe.SubscriptionSchedule>;
  invoices: Map<string, Stripe.Invoice>;
  portalSessions: Stripe.BillingPortal.Session[];
  checkoutSessions: Map<string, Stripe.Checkout.Session>;
  /** Which invoice each payment intent paid, and where its payment stands: succeeded, requires_action or requires_payment_method. */
  invoicePayments: Array<{ invoice: string; paymentIntent: string; status?: string }>;
  /** The pending update on each subscription that has one: the invoice it waits on, and the update it applies once that's paid. */
  pendingUpdates: Map<string, { invoice: string; params: Stripe.SubscriptionUpdateParams }>;
  /** The meter events sent, each with its meter's event name, the customer and its value. */
  meterEvents: Array<{ event_name: string; customer: string; value: number; identifier: string; timestamp: number }>;
  /** Customer balance transactions, newest first. */
  balanceTransactions: Stripe.CustomerBalanceTransaction[];
  /** Products, prices, meters, coupons, portal configurations, endpoints and Stripe Tax: what pnpm billing makes. */
  catalog: FakeCatalogState;
  /** Subscriptions a Managed Payments checkout made, whose card the API can't set. */
  managedPayments: Set<string>;
};

/** One call the adapter made, with its parameters and idempotency key. */
export type FakeStripeRequest = { call: string; params: unknown; idempotencyKey: string | null };

/** The fake's objects, clock and calls, which each kind of object's file works on. */
export class FakeStripeContext {
  readonly state: FakeStripeState;
  readonly requests: FakeStripeRequest[] = [];
  private readonly answered = new Map<string, { params: string; result: unknown }>();
  private counter = 0;

  constructor(readonly clock: FakeClock, accountId: string) {
    this.state = { accountId, customers: new Map(), subscriptions: new Map(), schedules: new Map(), invoices: new Map(), portalSessions: [], checkoutSessions: new Map(), invoicePayments: [], pendingUpdates: new Map(), meterEvents: [], balanceTransactions: [], catalog: emptyFakeCatalog(), managedPayments: new Set() };
  }

  /** A new ID with Stripe's prefix for the kind of object, numbered in the order the fake made them. */
  nextId(prefix: string): string {
    this.counter += 1;
    return `${prefix}_fake${String(this.counter).padStart(4, "0")}`;
  }

  /**
   * Records a call and answers it. With an idempotency key, Stripe answers
   * the same parameters again with its first answer and refuses others, and
   * so does the fake. Answers are copies, so a caller can't change the fake.
   */
  async call<T>(name: string, params: unknown, idempotencyKey: string | null, run: () => T): Promise<T> {
    this.requests.push({ call: name, params, idempotencyKey });
    if (!idempotencyKey) return structuredClone(run());
    const body = JSON.stringify(params);
    const seen = this.answered.get(idempotencyKey);
    if (seen) {
      if (seen.params !== body) throw idempotencyMismatch(idempotencyKey);
      return structuredClone(seen.result) as T;
    }
    const result = run();
    this.answered.set(idempotencyKey, { params: body, result: structuredClone(result) });
    return structuredClone(result);
  }
}

export const idOf = (value: string | { id: string } | null | undefined): string | null => (typeof value === "string" ? value : value?.id ?? null);
