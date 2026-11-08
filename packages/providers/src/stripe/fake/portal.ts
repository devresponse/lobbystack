import type Stripe from "stripe";

import type { StripeApi } from "../client";
import type { FakeStripeContext } from "./context";
import { missing } from "./errors";

/** billingPortal.sessions.create: a session for a customer the fake has. */
export function fakeBillingPortal(fake: FakeStripeContext): StripeApi["billingPortal"] {
  return {
    sessions: {
      async create(params: Stripe.BillingPortal.SessionCreateParams) {
        return await fake.call("billingPortal.sessions.create", params, null, () => {
          if (!params.customer || !fake.state.customers.has(params.customer)) throw missing("customer", params.customer ?? "", "customer");
          const id = fake.nextId("bps");
          const session = {
            id,
            object: "billing_portal.session",
            customer: params.customer,
            return_url: params.return_url ?? null,
            configuration: params.configuration ?? "bpc_default",
            locale: params.locale ?? null,
            url: `https://billing.stripe.com/p/session/test_${id}`,
            livemode: false,
          } as unknown as Stripe.BillingPortal.Session;
          fake.state.portalSessions.push(session);
          return session;
        });
      },
    } as unknown as StripeApi["billingPortal"]["sessions"],
  };
}

/** accounts.retrieveCurrent: the account the key belongs to. */
export function fakeAccounts(fake: FakeStripeContext): StripeApi["accounts"] {
  return {
    async retrieveCurrent() {
      return await fake.call("accounts.retrieveCurrent", {}, null, () => ({ id: fake.state.accountId, object: "account" }) as unknown as Stripe.Account);
    },
  } as unknown as StripeApi["accounts"];
}
