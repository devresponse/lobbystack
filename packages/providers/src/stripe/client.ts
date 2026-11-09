import Stripe from "stripe";

import { STRIPE_API_VERSION, assertCertificationStripeKey, stripeKeyMode } from "@lobbystack/shared";

import type { BillingEnv } from "../billing/types";

// The Stripe SDK as the adapter uses it (ADR 0010, the Stripe plan's step 9).
// Every call the adapter makes is named in StripeApi, which the SDK's client
// and the in-memory fake in fake/ both answer; each later step adds the calls
// its flow needs.

/** The calls the Stripe adapter makes, as the SDK names them. */
export type StripeApi = {
  accounts: Pick<Stripe["accounts"], "retrieveCurrent">;
  customers: Pick<Stripe["customers"], "create" | "retrieve" | "update" | "createBalanceTransaction" | "listBalanceTransactions">;
  billing: { meterEvents: Pick<Stripe["billing"]["meterEvents"], "create">; meters: Pick<Stripe["billing"]["meters"], "list" | "listEventSummaries"> };
  subscriptions: Pick<Stripe["subscriptions"], "retrieve" | "cancel" | "create" | "update" | "list">;
  subscriptionSchedules: Pick<Stripe["subscriptionSchedules"], "create" | "update" | "release">;
  invoices: Pick<Stripe["invoices"], "voidInvoice">;
  prices: Pick<Stripe["prices"], "list">;
  checkout: { sessions: Pick<Stripe["checkout"]["sessions"], "create"> };
  billingPortal: { sessions: Pick<Stripe["billingPortal"]["sessions"], "create"> };
  invoicePayments: Pick<Stripe["invoicePayments"], "list">;
  paymentIntents: Pick<Stripe["paymentIntents"], "retrieve">;
};

// The languages Stripe's checkout and billing portal pages come in, which its
// customers' emails and invoices take too. Serbian isn't one of them.
const stripeLocales = new Set([
  "bg", "cs", "da", "de", "el", "en", "en-AU", "en-CA", "en-GB", "en-IE", "en-IN", "en-NZ", "en-SG", "es", "es-419", "et", "fi", "fil",
  "fr", "fr-CA", "hr", "hu", "id", "it", "ja", "ko", "lt", "lv", "ms", "mt", "nb", "nl", "pl", "pt", "pt-BR", "ro", "ru", "sk",
  "sl", "sv", "th", "tr", "vi", "zh", "zh-HK", "zh-TW",
]);

/**
 * The locale as Stripe takes it: the locale itself, else its language, else
 * null, and the call leaves the locale out so Stripe goes by the browser. A
 * locale Stripe doesn't have would fail the call.
 */
export function stripeLocale(locale: string | null): string | null {
  const [language, region] = (locale ?? "").trim().split(/[-_]/);
  if (!language) return null;
  const base = language.toLowerCase();
  const full = region ? `${base}-${region.toUpperCase()}` : base;
  if (stripeLocales.has(full)) return full;
  return stripeLocales.has(base) ? base : null;
}

/** sandbox for a test key (sk_test_, rk_test_), live for a live one, and null for anything that isn't a secret or restricted key. */
export function stripeKeyEnv(key: string): BillingEnv | null {
  return stripeKeyMode(key);
}

/**
 * The SDK's client: the pinned API version, two network retries, a 15-second
 * timeout as Polar's has, LobbyStack named in the user agent, and no request
 * telemetry. A certification run takes test keys only.
 */
export function createStripeClient(key: string, options: { httpClient?: Stripe.HttpClient } = {}): Stripe {
  assertCertificationStripeKey(key);
  return new Stripe(key.trim(), {
    apiVersion: STRIPE_API_VERSION,
    maxNetworkRetries: 2,
    timeout: 15_000,
    appInfo: { name: "LobbyStack" },
    telemetry: false,
    ...(options.httpClient ? { httpClient: options.httpClient } : {}),
  });
}

/**
 * The check a service makes once at startup: the key's own account must be
 * the deployment's STRIPE_ACCOUNT_ID, and the key's mode the deployment's.
 * Another account's key, or one of the other mode, would bill or look for the
 * wrong customers.
 */
export async function checkStripeAccount(api: Pick<StripeApi, "accounts">, input: { key: string; accountId: string; env: BillingEnv }): Promise<void> {
  const keyEnv = stripeKeyEnv(input.key);
  if (keyEnv !== input.env) {
    throw new Error(keyEnv === null
      ? "STRIPE_API_KEY isn't a Stripe secret or restricted key (sk_ or rk_)."
      : `STRIPE_API_KEY is a ${keyEnv === "sandbox" ? "test" : "live"} key, and this deployment bills ${input.env === "sandbox" ? "in a sandbox" : "live"}. Use a key of the deployment's mode.`);
  }
  const account = await api.accounts.retrieveCurrent();
  if (account.id !== input.accountId) throw new Error(`STRIPE_API_KEY belongs to Stripe account ${account.id}, not STRIPE_ACCOUNT_ID ${input.accountId}. Use a key of the deployment's own account.`);
}
