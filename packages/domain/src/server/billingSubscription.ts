import { and, desc, eq, gte, inArray } from "drizzle-orm";

import { billingAccounts, billingCheckoutRequests, enqueueOutbox, withBusinessTransaction, type DatabaseTransaction } from "@lobbystack/db";
import { billingProviderNames, billingSubscriptionActions, inAppPlanActions, type BillingSubscriptionAction } from "@lobbystack/shared";

import { requireBusinessAdmin } from "../authz";
import { BILLING_CHECKOUT_EXPIRES_MS, isLiveSubscriptionState, isManagedBillingAccount, lockBillingAccount, type BillingCheckoutLimit } from "./billing";
import { readBillingDeployment } from "./billingProvider";
import type { DomainContext } from "./context";

// Cancelling at the renewal, resuming and keeping the plan (the Stripe plan's
// step 15). Each is a request of its own in billing_checkout_requests, with
// target cancel, resume or keep, so it shares the checkout's poll, its
// one-change-at-a-time rule and its per-business limits. The
// billing.changeSubscription job asks the provider.

export function isBillingSubscriptionAction(value: string | null | undefined): value is BillingSubscriptionAction {
  return (billingSubscriptionActions as readonly (string | null | undefined)[]).includes(value);
}

const refused = (status: 404 | 409, code: string, message: string) => Object.assign(new Error(message), { status, code });

/** The account's state a change needs: a live subscription, ending or not, or with a change waiting. */
type ChangeableAccount = { subscriptionId: string | null; subscriptionState: string | null; cancelAt: Date | null; nextPlanCode: string | null; billingInterval: string | null };

/**
 * Queues a change to the business's subscription in the name of the person
 * asking. Refused with 409 where the deployment's provider leaves it to its
 * billing portal (Polar), on a managed plan, when the subscription has
 * nothing to change (cancel one already ending, resume one that renews, keep
 * a plan with no change waiting), and while another change or checkout of the
 * business is open; with 404 without a live subscription. The person's open
 * request for the same change comes back instead of a new one. checkLimit
 * runs only before a new request is made.
 */
export async function createBillingSubscriptionRequestInTransaction(
  tx: DatabaseTransaction,
  input: { userId: string; businessId: string; action: BillingSubscriptionAction; checkLimit?: BillingCheckoutLimit | undefined },
  env: Record<string, string | undefined> = process.env,
): Promise<{ id: string; created: boolean }> {
  const provider = readBillingDeployment(env, { withSecret: false }).provider;
  if (!inAppPlanActions(provider)) throw refused(409, "conflict", `Plans are cancelled and resumed in ${billingProviderNames[provider]}'s billing portal on this deployment.`);
  await lockBillingAccount(tx, input.businessId);
  const [account] = await tx.select({ source: billingAccounts.source, subscriptionId: billingAccounts.subscriptionId, subscriptionState: billingAccounts.subscriptionState, cancelAt: billingAccounts.cancelAt, nextPlanCode: billingAccounts.nextPlanCode, billingInterval: billingAccounts.billingInterval })
    .from(billingAccounts).where(eq(billingAccounts.businessId, input.businessId)).limit(1);
  if (isManagedBillingAccount(account)) throw refused(409, "conflict", "This business is on a managed plan, billed directly by the operator.");
  if (!account?.subscriptionId || !isLiveSubscriptionState(account.subscriptionState)) throw refused(404, "not_found", "This business has no live subscription.");
  const nothing = nothingToChange(account, input.action);
  if (nothing) throw refused(409, "conflict", nothing);
  // Under the lock, so two clicks at once make one request.
  const open = await tx.select({ id: billingCheckoutRequests.id, target: billingCheckoutRequests.target, requestedByUserId: billingCheckoutRequests.requestedByUserId }).from(billingCheckoutRequests).where(and(
    eq(billingCheckoutRequests.businessId, input.businessId),
    inArray(billingCheckoutRequests.status, ["pending", "processing"]),
    gte(billingCheckoutRequests.createdAt, new Date(Date.now() - BILLING_CHECKOUT_EXPIRES_MS)),
  )).orderBy(desc(billingCheckoutRequests.createdAt));
  const same = open.find((request) => request.target === input.action && request.requestedByUserId === input.userId);
  if (same) return { id: same.id, created: false };
  if (open.length) throw refused(409, "plan_change_pending", "Another plan change for this business is in progress. Try again in a minute.");
  await input.checkLimit?.({ businessId: input.businessId, userId: input.userId });
  const [request] = await tx.insert(billingCheckoutRequests).values({
    businessId: input.businessId,
    requestedByUserId: input.userId,
    target: input.action,
    // The subscription's own interval; the request changes none.
    billingInterval: account.billingInterval === "annual" ? "annual" : "monthly",
    status: "pending",
  }).returning({ id: billingCheckoutRequests.id });
  if (!request) throw new Error("Billing subscription request could not be created.");
  await enqueueOutbox(tx, { topic: "billing.changeSubscription", businessId: input.businessId, aggregateType: "billing_checkout_request", aggregateId: request.id, dedupeKey: `billing-subscription:${request.id}`, payload: { requestId: request.id } });
  return { id: request.id, created: true };
}

/** The dashboard's request, from one of the business's admins. */
export async function createBillingSubscriptionRequest(context: DomainContext, input: { userId: string; businessId: string; action: BillingSubscriptionAction; checkLimit?: BillingCheckoutLimit | undefined }): Promise<string> {
  return await withBusinessTransaction(context.db, { userId: input.userId, businessId: input.businessId, actorType: "operator" }, async (tx) => {
    await requireBusinessAdmin(tx, { userId: input.userId, businessId: input.businessId });
    return (await createBillingSubscriptionRequestInTransaction(tx, input)).id;
  });
}

/** Why the subscription has nothing for the action to change, or null when it has. */
function nothingToChange(account: ChangeableAccount, action: BillingSubscriptionAction): string | null {
  if (action === "cancel") return account.cancelAt ? "The plan already ends at its renewal." : null;
  if (action === "resume") return account.cancelAt ? null : "The plan isn't set to end, so there's nothing to resume.";
  return account.nextPlanCode ? null : "No plan change waits for the renewal.";
}

/** Whether the account shows a change the provider made: an end set for cancel, none for resume, no change waiting for keep. */
export function billingSubscriptionChangeShown(account: Pick<ChangeableAccount, "cancelAt" | "nextPlanCode"> | null | undefined, action: BillingSubscriptionAction): boolean {
  if (!account) return false;
  if (action === "cancel") return account.cancelAt !== null;
  if (action === "resume") return account.cancelAt === null;
  return account.nextPlanCode === null;
}

/** What billing.changeSubscription reads: the request's action and the subscription it changes. */
export type BillingSubscriptionWork = { action: BillingSubscriptionAction; status: string; subscriptionId: string | null; source: string | null };

export async function loadBillingSubscriptionRequest(context: DomainContext, input: { businessId: string; requestId: string }): Promise<BillingSubscriptionWork | null> {
  return await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, async (tx) => {
    const [row] = await tx.select({ target: billingCheckoutRequests.target, status: billingCheckoutRequests.status, subscriptionId: billingAccounts.subscriptionId, source: billingAccounts.source })
      .from(billingCheckoutRequests)
      .leftJoin(billingAccounts, eq(billingAccounts.businessId, billingCheckoutRequests.businessId))
      .where(and(eq(billingCheckoutRequests.id, input.requestId), eq(billingCheckoutRequests.businessId, input.businessId)))
      .limit(1);
    if (!row || !isBillingSubscriptionAction(row.target)) return null;
    return { action: row.target, status: row.status, subscriptionId: row.subscriptionId ?? null, source: row.source ?? null };
  }, { accessMode: "read only" });
}
