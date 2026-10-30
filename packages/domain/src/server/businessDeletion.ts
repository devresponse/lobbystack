import { and, eq, gt, inArray, isNull, min, ne, or, sql } from "drizzle-orm";

import { billingAccounts, billingCheckoutRequests, businessMemberships, businesses, calls, enqueueOutbox, feedbackSubmissions, onboardingNumberClaimEvents, outboxMessages, phoneNumbers, productEvents, providerEvents, rlsContextStatement, storageObjects, withBusinessTransaction, type DatabaseTransaction } from "@lobbystack/db";

import { isManagedBillingAccount, lockBillingAccount, MANAGED_BILLING_SOURCE } from "./billing";
import type { DomainContext } from "./context";
import { lockBusinessNumberClaims } from "./phoneNumbers";
import { isSharedSmsSender } from "./smsSender";
import { lockBusinessTeam } from "./tenancy";

/** How many stored files one cleanup job deletes. */
const STORED_FILES_PER_JOB = 500;

/** Subscription states with nothing left for Polar to end. */
const ENDED_SUBSCRIPTION_STATES = ["canceled", "incomplete_expired"];

/** How often a delete that still finds a paid plan asks the worker again to end it. */
const PLAN_END_RETRY_MS = 10 * 60_000;

/** How long a delete waits on the worker to end a paid plan before saying it couldn't. */
const PLAN_END_PATIENCE_MS = 10 * 60_000;

/** A Polar checkout page stays payable for an hour, and a payment after the delete would buy a plan for a business that's gone. */
const OPEN_CHECKOUT_MS = 60 * 60_000;

/** No call runs past its 30-minute limit, so an unended call older than this lost its worker and isn't live. */
const LIVE_CALL_MAX_AGE_MS = 40 * 60_000;

const refusals = {
  forbidden: [403, "Only an owner of the business can delete it."],
  only_business: [403, "This is the only business your account owns, so it can't be deleted."],
  root_business: [403, "This is the first business on your account, so it can't be deleted."],
  other_owner_root: [403, "This is the first business on another owner's account, so it can't be deleted."],
  confirmation_mismatch: [400, "Type the business's name exactly as it's shown to confirm."],
  number_in_progress: [409, "A phone number for this business is still being set up. Try again in a few minutes."],
  call_in_progress: [409, "A call is in progress on this business. Try again when it ends."],
  checkout_open: [409, "A plan purchase for this business started less than an hour ago. Try again once it has expired."],
  managed_plan: [409, "This business's plan is billed outside the app. Contact support to end it, then delete the business."],
  plan_ending: [409, "The business's paid plan is being canceled. Try again in a few seconds."],
  plan_not_ended: [409, "The business's paid plan couldn't be canceled. Contact support, or try again later."],
} as const satisfies Record<string, readonly [number, string]>;

export type BusinessDeletionRefusal = keyof typeof refusals;

function refusal(reason: BusinessDeletionRefusal): Error {
  const [status, message] = refusals[reason];
  // other_owner_root is a root business too, with its own message.
  return Object.assign(new Error(message), { status, code: reason === "other_owner_root" ? "root_business" : reason });
}

/** The refusal migration 0129's guard raised, when an error carries one. */
function guardRefusal(error: unknown): Error | undefined {
  for (let current: unknown = error, depth = 0; current && typeof current === "object" && depth < 4; current = (current as { cause?: unknown }).cause, depth += 1) {
    const constraint = (current as { constraint?: unknown }).constraint;
    if (constraint === "businesses_root_business") return refusal("root_business");
    if (constraint === "businesses_owner_delete") return refusal("forbidden");
  }
  return undefined;
}

export type BusinessDeletion = { releasedNumbers: number; storedFiles: number };

/**
 * Deletes a business and everything in it, for one of its owners: the team,
 * calls and recordings, chats, contacts, appointments, knowledge, settings,
 * billing records and audit log, and the webhook payloads, analytics events
 * and feedback that name it, which would otherwise outlive it unlinked. The
 * owner types its name to confirm. People's accounts stay: only their place
 * on the business goes, and whoever had it open moves to another of theirs.
 *
 * An account's root business is never deleted: the business each owner has
 * owned longest, the first one for a normal sign-up. So an owner needs at
 * least one other business, and a business that's any owner's root stays
 * (migration 0129 refuses it in the database too). A business on a plan the
 * operator bills outside Polar is refused, and so is one with a phone number,
 * a call or a plan checkout under way.
 *
 * A paid Polar plan ends first. The admin's Polar token can't end one, so the
 * delete asks the worker to (billing.revokeSubscription) and refuses with
 * plan_ending until the worker has; asked again once the plan has ended, it
 * goes ahead. Each phone number goes back to Twilio and each stored file is
 * deleted by worker jobs queued here, which outlive the business. Jobs and
 * emails that haven't gone out are dropped.
 */
export async function deleteBusiness(context: DomainContext, input: { userId: string; businessId: string; confirmName: string }): Promise<BusinessDeletion> {
  const { userId, businessId } = input;
  let outcome: BusinessDeletion | { planEnding: Error };
  try {
    outcome = await withBusinessTransaction(context.db, { userId, businessId, actorType: "operator" }, async (tx): Promise<BusinessDeletion | { planEnding: Error }> => {
      // Number claims, Polar's reconcile and team changes take these before any of the business's rows, so this does too.
      await lockBusinessNumberClaims(tx, businessId);
      await lockBillingAccount(tx, businessId);
      await lockBusinessTeam(tx, businessId);
      const [business] = await tx.select({ name: businesses.name }).from(businesses).where(eq(businesses.id, businessId)).limit(1).for("update");
      const [membership] = await tx.select({ role: businessMemberships.role }).from(businessMemberships).where(and(eq(businessMemberships.businessId, businessId), eq(businessMemberships.userId, userId), eq(businessMemberships.status, "active"))).limit(1);
      if (!business || membership?.role !== "business_owner") throw refusal("forbidden");
      // The businesses the owner's workspace list shows them owning, and which are roots.
      const owned = (await tx.execute<{ business_id: string; is_root: boolean; is_account_root: boolean }>(sql`select business_id, is_root, is_account_root from app.list_user_businesses(${userId}) where role = 'business_owner'`)).rows;
      const target = owned.find((row) => row.business_id === businessId);
      if (!target) throw refusal("forbidden");
      if (owned.length < 2) throw refusal("only_business");
      if (target.is_root) throw refusal(target.is_account_root ? "root_business" : "other_owner_root");
      if (input.confirmName.trim() !== business.name.trim()) throw refusal("confirmation_mismatch");

      // A number bought after the delete would belong to no business, and keep costing.
      const underWay = await workUnderWay(tx, businessId);
      if (underWay) throw refusal(underWay);

      // Nobody should keep paying for a business that's gone.
      const [account] = await tx.select({ source: billingAccounts.source, subscriptionId: billingAccounts.subscriptionId, subscriptionState: billingAccounts.subscriptionState }).from(billingAccounts).where(eq(billingAccounts.businessId, businessId)).limit(1);
      if (isManagedBillingAccount(account)) throw refusal("managed_plan");
      const subscriptionId = subscriptionToEnd(account);
      if (subscriptionId) {
        const revokes = and(eq(outboxMessages.businessId, businessId), eq(outboxMessages.topic, "billing.revokeSubscription"), sql`${outboxMessages.payload}->>'subscriptionId' = ${subscriptionId}`);
        const [asked] = await tx.select({ first: min(outboxMessages.createdAt) }).from(outboxMessages).where(revokes);
        // A failed try is queued again on the next window, so asking later always reaches the worker.
        await enqueueOutbox(tx, { topic: "billing.revokeSubscription", businessId, aggregateType: "billing_account", aggregateId: businessId, dedupeKey: `billing-revoke:${subscriptionId}:${Math.floor(Date.now() / PLAN_END_RETRY_MS)}`, payload: { subscriptionId } });
        const waited = asked?.first ? Date.now() - new Date(asked.first).getTime() : 0;
        // Committed with the job, and raised once the transaction ends.
        return { planEnding: refusal(waited > PLAN_END_PATIENCE_MS ? "plan_not_ended" : "plan_ending") };
      }

      // Every number Twilio still holds for it, a replaced one too. The shared sender texts for every business, so it stays, as a reclaim leaves it.
      const numbers = (await tx.select({ providerPhoneId: phoneNumbers.providerPhoneId, e164: phoneNumbers.e164 }).from(phoneNumbers).where(and(eq(phoneNumbers.businessId, businessId), ne(phoneNumbers.status, "reclaimed"))))
        .filter((number): number is { providerPhoneId: string; e164: string } => Boolean(number.providerPhoneId) && !isSharedSmsSender(number.e164));
      const stored = await tx.select({ objectKey: storageObjects.objectKey }).from(storageObjects).where(and(eq(storageObjects.businessId, businessId), ne(storageObjects.status, "deleted")));

      // These rows outlive the business with it unlinked, and the payloads, events and feedback in them are its data.
      // Jobs and emails that haven't gone out would reach its people with nothing left to act on.
      await tx.delete(outboxMessages).where(eq(outboxMessages.businessId, businessId));
      await tx.delete(providerEvents).where(eq(providerEvents.businessId, businessId));
      await tx.delete(productEvents).where(eq(productEvents.businessId, businessId));
      // An operator sees only their own feedback, so the system actor deletes the team's, then the operator deletes the business.
      await tx.execute(rlsContextStatement({ userId, businessId, actorType: "system" }));
      await tx.delete(feedbackSubmissions).where(eq(feedbackSubmissions.businessId, businessId));
      await tx.execute(rlsContextStatement({ userId, businessId, actorType: "operator" }));

      // Queued in the business, as the outbox's RLS asks; deleting it leaves the jobs belonging to none, so each names it in its payload.
      for (const number of numbers) {
        await enqueueOutbox(tx, { topic: "phoneNumber.releaseDeleted", businessId, aggregateType: "business", aggregateId: businessId, dedupeKey: `business:${businessId}:release-number:${number.providerPhoneId}`, payload: { businessId, providerPhoneId: number.providerPhoneId } });
      }
      for (let start = 0; start < stored.length; start += STORED_FILES_PER_JOB) {
        await enqueueOutbox(tx, { topic: "privacy.deleteStoredObjects", businessId, aggregateType: "business", aggregateId: businessId, dedupeKey: `business:${businessId}:delete-stored-objects:${start}`, payload: { businessId, objectKeys: stored.slice(start, start + STORED_FILES_PER_JOB).map((object) => object.objectKey) } });
      }
      await tx.delete(businesses).where(eq(businesses.id, businessId));
      return { releasedNumbers: numbers.length, storedFiles: stored.length };
    });
  } catch (error) {
    throw guardRefusal(error) ?? error;
  }
  if ("planEnding" in outcome) throw outcome.planEnding;
  return outcome;
}

/**
 * What's under way on a business that deleting or canceling it would cut
 * off: a phone number being bought, a call, or a plan checkout someone could
 * still pay. A number bought afterwards would belong to no open business and
 * keep costing; a payment would buy a plan for it.
 */
export async function workUnderWay(tx: DatabaseTransaction, businessId: string): Promise<"number_in_progress" | "call_in_progress" | "checkout_open" | null> {
  const [claiming] = await tx.select({ id: onboardingNumberClaimEvents.id }).from(onboardingNumberClaimEvents).where(and(
    eq(onboardingNumberClaimEvents.businessId, businessId),
    or(
      and(eq(onboardingNumberClaimEvents.status, "reserved"), gt(onboardingNumberClaimEvents.reservedAt, sql`now() - interval '15 minutes'`)),
      and(eq(onboardingNumberClaimEvents.status, "provisioning"), gt(onboardingNumberClaimEvents.updatedAt, sql`now() - interval '30 minutes'`)),
    ),
  )).limit(1);
  const [provisioning] = await tx.select({ id: phoneNumbers.id }).from(phoneNumbers).where(and(eq(phoneNumbers.businessId, businessId), eq(phoneNumbers.status, "provisioning"))).limit(1);
  if (claiming || provisioning) return "number_in_progress";
  const [liveCall] = await tx.select({ id: calls.id }).from(calls).where(and(eq(calls.businessId, businessId), isNull(calls.endedAt), gt(calls.startedAt, new Date(Date.now() - LIVE_CALL_MAX_AGE_MS)))).limit(1);
  if (liveCall) return "call_in_progress";
  const [checkout] = await tx.select({ id: billingCheckoutRequests.id }).from(billingCheckoutRequests).where(and(
    eq(billingCheckoutRequests.businessId, businessId),
    inArray(billingCheckoutRequests.status, ["pending", "processing", "ready"]),
    gt(billingCheckoutRequests.updatedAt, new Date(Date.now() - OPEN_CHECKOUT_MS)),
  )).limit(1);
  return checkout ? "checkout_open" : null;
}

/** The Polar subscription a business still pays through, which deleting or canceling it ends: none for an ended one, or a plan the operator bills outside Polar. */
export function subscriptionToEnd(account: { source: string | null; subscriptionId: string | null; subscriptionState: string | null } | undefined): string | null {
  return account?.subscriptionId && account.source !== MANAGED_BILLING_SOURCE && !ENDED_SUBSCRIPTION_STATES.includes(account.subscriptionState ?? "") ? account.subscriptionId : null;
}

/**
 * Whether a business is gone, for the jobs a delete leaves behind: they act
 * only once their business no longer exists, so a job naming a business that
 * does can't release its number or delete its files.
 */
export async function isBusinessDeleted(context: DomainContext, businessId: string): Promise<boolean> {
  return await withBusinessTransaction(context.db, { businessId, actorType: "worker" }, async (tx) => (await tx.select({ id: businesses.id }).from(businesses).where(eq(businesses.id, businessId)).limit(1)).length === 0);
}

/**
 * Records that the worker ended a business's Polar subscription for its
 * delete, so the delete can go ahead without waiting for Polar's webhook,
 * which says the same. False when the account has moved to another subscription.
 */
export async function recordDeletedBusinessPlanEnded(context: DomainContext, input: { businessId: string; subscriptionId: string }): Promise<boolean> {
  return await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, async (tx) => {
    await lockBillingAccount(tx, input.businessId);
    const now = new Date();
    const ended = await tx.update(billingAccounts).set({ subscriptionState: "canceled", currentPeriodEnd: now, updatedAt: now }).where(and(eq(billingAccounts.businessId, input.businessId), eq(billingAccounts.subscriptionId, input.subscriptionId))).returning({ id: billingAccounts.id });
    return ended.length > 0;
  });
}
