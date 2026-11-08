import type Stripe from "stripe";

import type { StripeApi } from "../client";
import type { FakeStripeContext } from "./context";
import { missing } from "./errors";

/** customers.create and customers.retrieve, on the fake's customers. */
export function fakeCustomers(fake: FakeStripeContext): StripeApi["customers"] {
  return {
    async create(params: Stripe.CustomerCreateParams = {}, options: Stripe.RequestOptions = {}) {
      return await fake.call("customers.create", params, options.idempotencyKey ?? null, () => {
        const customer = {
          id: fake.nextId("cus"),
          object: "customer",
          created: fake.clock.now(),
          email: params.email ?? null,
          name: params.name ?? null,
          preferred_locales: params.preferred_locales ?? [],
          metadata: { ...(params.metadata ?? {}) },
          livemode: false,
        } as unknown as Stripe.Customer;
        fake.state.customers.set(customer.id, customer);
        return customer;
      });
    },
    /** Its default card and metadata, which Stripe merges. */
    async update(id: string, params: Stripe.CustomerUpdateParams = {}) {
      return await fake.call("customers.update", { id, ...params }, null, () => {
        const found = fake.state.customers.get(id);
        if (!found || ("deleted" in found && found.deleted)) throw missing("customer", id);
        const customer = found as Stripe.Customer;
        const updated = {
          ...customer,
          ...(params.email !== undefined ? { email: params.email } : {}),
          ...(params.invoice_settings ? { invoice_settings: { ...(customer.invoice_settings ?? {}), ...params.invoice_settings } } : {}),
          metadata: { ...(customer.metadata ?? {}), ...((params.metadata ?? {}) as Record<string, string>) },
        } as Stripe.Customer;
        fake.state.customers.set(id, updated);
        return updated;
      });
    },
    async retrieve(id: string) {
      return await fake.call("customers.retrieve", { id }, null, () => {
        const found = fake.state.customers.get(id);
        if (!found) throw missing("customer", id);
        return found;
      });
    },
  } as unknown as StripeApi["customers"];
}

/** A customer already at Stripe: deleted, or naming a business in its metadata. */
export function addFakeCustomer(fake: FakeStripeContext, input: { id: string; businessId?: string; deleted?: boolean; email?: string }): void {
  fake.state.customers.set(input.id, input.deleted
    ? ({ id: input.id, object: "customer", deleted: true } as Stripe.DeletedCustomer)
    : ({ id: input.id, object: "customer", email: input.email ?? null, metadata: input.businessId ? { lobbystack_business: input.businessId } : {}, livemode: false } as unknown as Stripe.Customer));
}
