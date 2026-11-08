import { vi } from "vitest";

import { PolarBilling } from "../../polar/adapter";
import { PolarBillingProvider } from "../../polar/polarBilling";
import { StripeBilling } from "../../stripe/adapter";
import { createFakeStripe, type FakeStripe } from "../../stripe/fake";
import type { BillingProvider } from "../types";

// The contract suite runs each flow's file against every adapter. Polar runs
// against a stub of fetch that records what Polar would receive; the Stripe
// adapter joins each file with its in-memory fake (Stripe plan, step 9).

export type RecordedRequest = { method: string; path: string; body: unknown };

export type PolarHarness = {
  billing: BillingProvider;
  requests: RecordedRequest[];
  /** Polar answers this method and path with this body and status; anything else gets 200 and {}. */
  answer(method: string, path: string, body: unknown, status?: number): void;
};

/** The Polar adapter over the real client, with fetch stubbed. Call vi.unstubAllGlobals() after each test. */
export function polarHarness(): PolarHarness {
  const requests: RecordedRequest[] = [];
  const answers: Array<{ method: string; path: string; body: unknown; status: number }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
    const { pathname } = new URL(String(url));
    const method = init?.method ?? "GET";
    requests.push({ method, path: pathname, body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
    const found = [...answers].reverse().find((candidate) => candidate.method === method && candidate.path === pathname);
    return new Response(JSON.stringify(found?.body ?? {}), { status: found?.status ?? 200, headers: { "content-type": "application/json" } });
  }));
  const client = new PolarBillingProvider({ accessToken: "polar-token", organizationId: "org-1", baseUrl: "https://polar.test" });
  return {
    billing: new PolarBilling(client, { organizationId: "org-1", env: "sandbox" }),
    requests,
    answer(method, path, body, status = 200) {
      answers.push({ method, path, body, status });
    },
  };
}

export type StripeHarness = { billing: StripeBilling; stripe: FakeStripe };

/** The Stripe adapter over the in-memory fake, on a sandbox account. */
export function stripeHarness(options: { portalConfiguration?: string } = {}): StripeHarness {
  const stripe = createFakeStripe({ accountId: "acct_1" });
  return { stripe, billing: new StripeBilling(stripe, { accountId: "acct_1", env: "sandbox", deployment: "https://app.example", ...(options.portalConfiguration ? { portalConfiguration: options.portalConfiguration } : {}) }) };
}

/** A Polar subscription body, active on a standard product, with a period ending in 2099. */
export function polarSubscriptionBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: "sub-1", status: "active", product_id: "product-starter-monthly", cancel_at_period_end: false, ended_at: null, pending_update: null, discount_id: null, current_period_end: "2099-12-01T00:00:00Z", ...extra };
}
