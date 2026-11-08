import type Stripe from "stripe";

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
    this.state = { accountId, customers: new Map(), subscriptions: new Map(), schedules: new Map(), invoices: new Map(), portalSessions: [] };
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
