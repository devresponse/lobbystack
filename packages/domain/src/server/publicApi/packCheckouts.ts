import type { DatabaseTransaction } from "@lobbystack/db";
import { billingProviderNames, billingProviderOf, type ApiPackCheckout, type ApiPackCheckoutCreate, type ApiTopUpCheckout, type ApiTopUpCheckoutCreate } from "@lobbystack/shared";

import type { BillingCheckoutLimit } from "../billing";
import { createPackCheckoutRequestInTransaction, createTopUpCheckoutRequestInTransaction, readPackCheckoutInTransaction } from "../billingPackCheckout";
import type { DomainContext } from "../context";
import { conflict, notFound } from "./errors";
import { apiErrorFromDomain, audit, checkoutPayerId, inBusiness, type ApiCaller } from "./operations";

// The v1 billing checkouts paid once: a prepaid pack's and a top-up's on sale.
// Both are billing_pack_checkouts rows, which the dashboard's Settings > Plan
// makes too, and billing.reconcile marks paid once the payment arrives.

/** A prepaid pack's checkout as the API shows it; paid once billing.reconcile recorded its payment, and pack_status says what became of the pack. A top-up's checkout is no pack's. */
async function loadPackCheckout(tx: DatabaseTransaction, businessId: string, checkoutId: string): Promise<ApiPackCheckout> {
  const checkout = await readPackCheckoutInTransaction(tx, { businessId, checkoutId });
  if (!checkout || checkout.kind !== "pack") throw notFound("Pack checkout");
  return {
    id: checkout.id,
    pack: checkout.pack,
    status: checkout.status,
    pack_status: checkout.packStatus,
    checkout_url: checkout.checkoutUrl,
    error: checkout.error,
    paid: checkout.status === "paid",
    expires_at: checkout.expiresAt.toISOString(),
    created_at: checkout.createdAt.toISOString(),
    updated_at: checkout.updatedAt.toISOString(),
  };
}

/**
 * Asks the deployment's billing provider for a page where the customer pays
 * once for a prepaid pack, as Settings > Plan does, with the dashboard's
 * refusals as the API's 409. Callers say whether this deployment sells packs
 * through its provider. Made out to the person the key acts for, or the owner
 * for a platform key. The payer's open checkout for the same pack comes back
 * instead of a new one; checkLimit runs only before a new one is made.
 */
export async function createPackCheckoutForApi(context: DomainContext, caller: ApiCaller, input: ApiPackCheckoutCreate, options: { available: boolean; checkLimit?: BillingCheckoutLimit }): Promise<ApiPackCheckout> {
  if (!options.available) throw conflict(`This deployment doesn't sell packs through ${billingProviderNames[billingProviderOf(process.env)]}.`);
  const userId = await checkoutPayerId(context, caller, "a pack");
  return await inBusiness(context, caller, async (tx) => {
    let checkout: { id: string; created: boolean };
    try {
      checkout = await createPackCheckoutRequestInTransaction(tx, { userId, businessId: caller.businessId, pack: input.pack, billingEmail: input.billing_email, checkLimit: options.checkLimit });
    } catch (error) {
      throw apiErrorFromDomain(error, "Pack checkout");
    }
    if (checkout.created) await audit(tx, caller, { eventType: "api.billing.pack_checkout_started", entityType: "billing_pack_checkout", entityId: checkout.id, payload: { pack: input.pack, payerUserId: userId } });
    return await loadPackCheckout(tx, caller.businessId, checkout.id);
  });
}

export async function getPackCheckoutForApi(context: DomainContext, caller: ApiCaller, checkoutId: string): Promise<ApiPackCheckout> {
  return await inBusiness(context, caller, async (tx) => await loadPackCheckout(tx, caller.businessId, checkoutId));
}

/** A top-up's checkout as the API shows it; paid once billing.reconcile recorded its payment, and top_up_status says what became of the top-up. A pack's checkout is no top-up's. */
async function loadTopUpCheckout(tx: DatabaseTransaction, businessId: string, checkoutId: string): Promise<ApiTopUpCheckout> {
  const checkout = await readPackCheckoutInTransaction(tx, { businessId, checkoutId });
  if (!checkout || checkout.kind !== "top_up") throw notFound("Top-up checkout");
  return {
    id: checkout.id,
    top_up: checkout.pack,
    status: checkout.status,
    top_up_id: checkout.topUpId,
    top_up_status: checkout.topUpStatus,
    checkout_url: checkout.checkoutUrl,
    error: checkout.error,
    paid: checkout.status === "paid",
    expires_at: checkout.expiresAt.toISOString(),
    created_at: checkout.createdAt.toISOString(),
    updated_at: checkout.updatedAt.toISOString(),
  };
}

/**
 * Asks the deployment's billing provider for a page where the customer pays
 * once for a top-up on sale, as Settings > Plan does, with the dashboard's
 * refusals as the API's 409. Callers say whether this deployment sells
 * through its provider. Made out to the person the key acts for, or the
 * owner for a platform key. The payer's open checkout for the same top-up
 * comes back instead of a new one; checkLimit runs only before a new one is
 * made.
 */
export async function createTopUpCheckoutForApi(context: DomainContext, caller: ApiCaller, input: ApiTopUpCheckoutCreate, options: { available: boolean; checkLimit?: BillingCheckoutLimit }): Promise<ApiTopUpCheckout> {
  if (!options.available) throw conflict(`This deployment doesn't sell top-ups through ${billingProviderNames[billingProviderOf(process.env)]}.`);
  const userId = await checkoutPayerId(context, caller, "a top-up");
  return await inBusiness(context, caller, async (tx) => {
    let checkout: { id: string; created: boolean };
    try {
      checkout = await createTopUpCheckoutRequestInTransaction(tx, { userId, businessId: caller.businessId, topUp: input.top_up, billingEmail: input.billing_email, checkLimit: options.checkLimit });
    } catch (error) {
      throw apiErrorFromDomain(error, "Top-up checkout");
    }
    if (checkout.created) await audit(tx, caller, { eventType: "api.billing.top_up_checkout_started", entityType: "billing_pack_checkout", entityId: checkout.id, payload: { topUp: input.top_up, payerUserId: userId } });
    return await loadTopUpCheckout(tx, caller.businessId, checkout.id);
  });
}

export async function getTopUpCheckoutForApi(context: DomainContext, caller: ApiCaller, checkoutId: string): Promise<ApiTopUpCheckout> {
  return await inBusiness(context, caller, async (tx) => await loadTopUpCheckout(tx, caller.businessId, checkoutId));
}
