import { createHash, randomBytes, randomUUID } from "node:crypto";

import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import { auditLogs, billingAccounts, businessCancellationRequests, businessMemberships, businesses, enqueueOutbox, phoneNumbers, users, withBusinessTransaction, type DatabaseTransaction } from "@lobbystack/db";
import { brandLinks, type InterfaceLocale } from "@lobbystack/shared";

import { isManagedBillingAccount, lockBillingAccount } from "./billing";
import { subscriptionToEnd, workUnderWay } from "./businessDeletion";
import type { DomainContext } from "./context";
import { lockBusinessNumberClaims } from "./phoneNumbers";
import { isSharedSmsSender } from "./smsSender";
import { lockBusinessTeam } from "./tenancy";

/** How long the emailed link works. */
const LINK_LIFETIME_MS = 24 * 60 * 60_000;

const refusals = {
  forbidden: [403, "Only an owner of the business can cancel it."],
  other_businesses: [403, "You own other businesses. Delete them first, then cancel this one."],
  confirmation_mismatch: [400, "Type the business's name exactly as it's shown to confirm."],
  invalid_link: [404, "This cancellation link isn't valid."],
  expired: [410, "This cancellation link has expired. Ask for a new one on the business's Team page."],
  replaced: [410, "A newer cancellation link was sent. Use the one in the latest email."],
  already_canceled: [409, "This business is already canceled."],
  wrong_account: [403, "Sign in as the owner who asked to cancel the business."],
  number_in_progress: [409, "A phone number for this business is still being set up. Try again in a few minutes."],
  call_in_progress: [409, "A call is in progress on this business. Try again when it ends."],
  checkout_open: [409, "A plan purchase for this business started less than an hour ago. Try again once it has expired."],
} as const satisfies Record<string, readonly [number, string]>;

export type BusinessCancellationRefusal = keyof typeof refusals;

function refusal(reason: BusinessCancellationRefusal): Error {
  const [status, message] = refusals[reason];
  return Object.assign(new Error(message), { status, code: reason });
}

/** The refusal app.cancel_business raised (migration 0130), when an error carries one. */
function guardRefusal(error: unknown): Error | undefined {
  for (let current: unknown = error, depth = 0; current && typeof current === "object" && depth < 4; current = (current as { cause?: unknown }).cause, depth += 1) {
    const constraint = (current as { constraint?: unknown }).constraint;
    if (constraint === "businesses_owner_cancel" || constraint === "businesses_status_change") return refusal("forbidden");
    if (constraint === "businesses_already_canceled") return refusal("already_canceled");
    if (constraint === "businesses_cancel_other_owned") return refusal("other_businesses");
  }
  return undefined;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Where the owner's email sends them to confirm. The page negotiates their language, as the invitation page does. */
export function cancellationUrl(token: string): string {
  return `${process.env.APP_BASE_URL ?? "http://localhost"}/cancel-account?token=${encodeURIComponent(token)}`;
}

/**
 * The inbox told about each request and cancellation: the brand's own contact
 * address, else FEEDBACK_TO_EMAIL. Never LobbyStack's, which a brand without
 * an address would otherwise fall back to.
 */
export function cancellationInbox(): string | undefined {
  return brandLinks().contactEmail ?? (process.env.FEEDBACK_TO_EMAIL?.trim() || undefined);
}

/** Whether the person may ask to cancel: an active owner whose account root it is, and the only business they own. */
async function checkOwnerMayCancel(tx: DatabaseTransaction, input: { userId: string; businessId: string }): Promise<void> {
  const [membership] = await tx.select({ role: businessMemberships.role }).from(businessMemberships).where(and(eq(businessMemberships.businessId, input.businessId), eq(businessMemberships.userId, input.userId), eq(businessMemberships.status, "active"))).limit(1);
  if (membership?.role !== "business_owner") throw refusal("forbidden");
  // The businesses the owner's workspace list shows them owning, as deleting counts them.
  const owned = (await tx.execute<{ business_id: string; is_account_root: boolean }>(sql`select business_id, is_account_root from app.list_user_businesses(${input.userId}) where role = 'business_owner'`)).rows;
  const target = owned.find((row) => row.business_id === input.businessId);
  if (!target) throw refusal("forbidden");
  if (owned.length !== 1 || !target.is_account_root) throw refusal("other_businesses");
}

/** A moment the inbox's emails show, in UTC. */
function utc(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** What the inbox's emails say about the business: who's on it, what it pays and which numbers it has. Read as one of its owners. */
async function businessDetails(tx: DatabaseTransaction, businessId: string): Promise<Record<string, string>> {
  const [business] = await tx.select({ name: businesses.name, slug: businesses.slug, businessType: businesses.businessType, timezone: businesses.timezone, websiteUrl: businesses.websiteUrl, createdAt: businesses.createdAt }).from(businesses).where(eq(businesses.id, businessId)).limit(1);
  // RLS shows the app role only its own users row, so the team comes through this function.
  const members = (await tx.execute<{ name: string | null; email: string; role: string }>(sql`select name, email, role from app.list_business_members(${businessId}::uuid)`)).rows;
  const [account] = await tx.select({ source: billingAccounts.source, plan: billingAccounts.plan, planCode: billingAccounts.planCode, billingInterval: billingAccounts.billingInterval, subscriptionId: billingAccounts.subscriptionId, subscriptionState: billingAccounts.subscriptionState }).from(billingAccounts).where(eq(billingAccounts.businessId, businessId)).limit(1);
  const numbers = await tx.select({ e164: phoneNumbers.e164 }).from(phoneNumbers).where(and(eq(phoneNumbers.businessId, businessId), eq(phoneNumbers.status, "active")));
  const planName = account?.planCode ?? account?.plan ?? "paid";
  const plan = isManagedBillingAccount(account)
    ? `${planName} plan, billed outside the app`
    : subscriptionToEnd(account)
      ? `${planName} plan${account?.billingInterval ? ` (${account.billingInterval})` : ""}, paid through Polar (${account?.subscriptionState ?? "unknown"})`
      : "Free plan";
  const owners = members.filter((member) => member.role === "business_owner").map((member) => member.name ? `${member.name} <${member.email}>` : member.email);
  return {
    businessId,
    businessName: business?.name ?? "",
    businessSlug: business?.slug ?? "",
    businessType: business?.businessType ?? "",
    timeZone: business?.timezone ?? "",
    websiteUrl: business?.websiteUrl ?? "",
    createdAt: business ? utc(business.createdAt) : "",
    owners: owners.join(", "),
    teamSize: String(members.length),
    plan,
    phoneNumbers: numbers.map((number) => number.e164).join(", "),
    ...(process.env.APP_BASE_URL ? { appUrl: process.env.APP_BASE_URL } : {}),
  };
}

export type BusinessCancellationRequest = { email: string; expiresAt: Date; inboxNotified: boolean };

/**
 * Asks to cancel an account's root business, for its owner, once it's the
 * only business they own (an owner with others deletes them first). The owner
 * types its name, and gets an email with a link that works for 24 hours; the
 * deployment's inbox (cancellationInbox) gets the business's details. Nothing
 * changes until the owner opens the link signed in and confirms with their
 * password (confirmBusinessCancellation). Asking again replaces the link.
 * `locale` is the owner's dashboard language, which their email is written in.
 */
export async function requestBusinessCancellation(context: DomainContext, input: { userId: string; businessId: string; confirmName: string; locale?: InterfaceLocale | undefined }): Promise<BusinessCancellationRequest> {
  const { userId, businessId } = input;
  const inbox = cancellationInbox();
  return await withBusinessTransaction(context.db, { userId, businessId, actorType: "operator" }, async (tx) => {
    // Team changes take this first, so an owner can't be added or leave while this checks who owns what.
    await lockBusinessTeam(tx, businessId);
    const [business] = await tx.select({ name: businesses.name }).from(businesses).where(eq(businesses.id, businessId)).limit(1).for("update");
    if (!business) throw refusal("forbidden");
    await checkOwnerMayCancel(tx, { userId, businessId });
    if (input.confirmName.trim() !== business.name.trim()) throw refusal("confirmation_mismatch");
    const [owner] = await tx.select({ email: users.email, name: users.name }).from(users).where(eq(users.id, userId)).limit(1);
    if (!owner?.email) throw refusal("forbidden");

    const now = new Date();
    await tx.update(businessCancellationRequests).set({ status: "replaced", updatedAt: now }).where(and(eq(businessCancellationRequests.businessId, businessId), eq(businessCancellationRequests.status, "pending")));
    const token = randomBytes(32).toString("base64url");
    const requestId = randomUUID();
    const expiresAt = new Date(now.getTime() + LINK_LIFETIME_MS);
    await tx.insert(businessCancellationRequests).values({ id: requestId, businessId, requestedByUserId: userId, email: owner.email, tokenHash: hashToken(token), expiresAt });
    const url = cancellationUrl(token);
    await enqueueOutbox(tx, {
      topic: "email.send",
      businessId,
      aggregateType: "business_cancellation_request",
      aggregateId: requestId,
      dedupeKey: `business-cancellation:${requestId}:confirm`,
      payload: { template: "cancellation_confirm", email: owner.email, token, url, variables: { url, businessName: business.name, ...(input.locale ? { locale: input.locale } : {}) } },
    });
    if (inbox) {
      await enqueueOutbox(tx, {
        topic: "email.send",
        businessId,
        aggregateType: "business_cancellation_request",
        aggregateId: requestId,
        dedupeKey: `business-cancellation:${requestId}:inbox`,
        payload: { template: "cancellation_request", to: inbox, variables: { ...await businessDetails(tx, businessId), requesterName: owner.name ?? "", requesterEmail: owner.email, requestedAt: utc(now), expiresAt: utc(expiresAt) } },
      });
    }
    await tx.insert(auditLogs).values({ businessId, actorUserId: userId, eventType: "business.cancellation_requested", entityType: "business", entityId: businessId, payload: { requestId, expiresAt: expiresAt.toISOString() } });
    return { email: owner.email, expiresAt, inboxNotified: Boolean(inbox) };
  });
}

export type BusinessCancellationLinkState = "pending" | "expired" | "replaced" | "canceled";

/** A cancellation link's request, read as the system: once the business is canceled, its owner can't see it. */
async function readRequest(context: DomainContext, tokenHash: string): Promise<{ businessId: string; businessName: string; email: string; expiresAt: Date; requestedByUserId: string; state: BusinessCancellationLinkState } | null> {
  const resolved = await context.db.execute<{ business_id: string | null }>(sql`select app.resolve_business_by_cancellation(${tokenHash}) as business_id`);
  const businessId = resolved.rows[0]?.business_id;
  if (!businessId) return null;
  return await withBusinessTransaction(context.db, { actorType: "system", businessId }, async (tx) => {
    const [row] = await tx.select({ businessName: businesses.name, businessStatus: businesses.status, email: businessCancellationRequests.email, expiresAt: businessCancellationRequests.expiresAt, status: businessCancellationRequests.status, requestedByUserId: businessCancellationRequests.requestedByUserId })
      .from(businessCancellationRequests).innerJoin(businesses, eq(businesses.id, businessCancellationRequests.businessId))
      .where(and(eq(businessCancellationRequests.tokenHash, tokenHash), eq(businessCancellationRequests.businessId, businessId))).limit(1);
    if (!row) return null;
    const state: BusinessCancellationLinkState = row.businessStatus !== "active" || row.status === "confirmed" ? "canceled" : row.status === "replaced" ? "replaced" : row.expiresAt <= new Date() ? "expired" : "pending";
    return { businessId, businessName: row.businessName, email: row.email, expiresAt: row.expiresAt, requestedByUserId: row.requestedByUserId, state };
  });
}

/** What the confirmation page shows for a link: the business, where the link went, until when it works, and whether it still does. Null for a link that was never sent. */
export async function previewBusinessCancellation(context: DomainContext, input: { tokenHash: string }): Promise<{ businessName: string; email: string; expiresAt: string; state: BusinessCancellationLinkState } | null> {
  const request = await readRequest(context, input.tokenHash);
  return request ? { businessName: request.businessName, email: request.email, expiresAt: request.expiresAt.toISOString(), state: request.state } : null;
}

export type BusinessCancellation = { businessId: string; businessName: string; numbersReleasedOn: Date | null; endsPlan: boolean };

/**
 * Cancels a business from its owner's emailed link, once they've signed in
 * as the owner who asked and given their password (the route checks it).
 * Nothing is deleted: the business is marked canceled, which closes it to
 * everyone on its team at once (migration 0130), its numbers stop answering
 * and go back to Twilio after 30 days, and a paid Polar plan ends now (the
 * worker ends it: billing.revokeSubscription). Whoever had it open moves to
 * another business of theirs, or to none, which starts onboarding again. The
 * inbox is told. An operator can bring it back with app.reactivate_business.
 *
 * Refused as when asking, and while a number is being bought, a call is in
 * progress or a plan checkout is open, as deleting is.
 */
export async function confirmBusinessCancellation(context: DomainContext, input: { userId: string; tokenHash: string }): Promise<BusinessCancellation> {
  const { userId, tokenHash } = input;
  // Why a link stopped working is read first: the owner can't see a canceled business.
  const request = await readRequest(context, tokenHash);
  if (!request) throw refusal("invalid_link");
  if (request.state === "canceled") throw refusal("already_canceled");
  if (request.state === "replaced") throw refusal("replaced");
  if (request.state === "expired") throw refusal("expired");
  if (request.requestedByUserId !== userId) throw refusal("wrong_account");
  const { businessId } = request;
  const inbox = cancellationInbox();
  try {
    return await withBusinessTransaction(context.db, { userId, businessId, actorType: "operator" }, async (tx): Promise<BusinessCancellation> => {
      // Number claims, Polar's reconcile and team changes take these before any of the business's rows, so this does too.
      await lockBusinessNumberClaims(tx, businessId);
      await lockBillingAccount(tx, businessId);
      await lockBusinessTeam(tx, businessId);
      const [business] = await tx.select({ name: businesses.name }).from(businesses).where(eq(businesses.id, businessId)).limit(1).for("update");
      if (!business) throw refusal("forbidden");
      await checkOwnerMayCancel(tx, { userId, businessId });
      // Asked again since this link was read, or confirmed by another tab.
      const [current] = await tx.select({ id: businessCancellationRequests.id, status: businessCancellationRequests.status, expiresAt: businessCancellationRequests.expiresAt }).from(businessCancellationRequests).where(and(eq(businessCancellationRequests.tokenHash, tokenHash), eq(businessCancellationRequests.businessId, businessId))).limit(1).for("update");
      if (!current) throw refusal("invalid_link");
      if (current.status === "confirmed") throw refusal("already_canceled");
      if (current.status === "replaced") throw refusal("replaced");
      if (current.expiresAt <= new Date()) throw refusal("expired");
      const underWay = await workUnderWay(tx, businessId);
      if (underWay) throw refusal(underWay);
      // Read before the cancel, which closes the business's rows to this owner.
      const details = inbox ? await businessDetails(tx, businessId) : undefined;
      const [owner] = await tx.select({ email: users.email, name: users.name }).from(users).where(eq(users.id, userId)).limit(1);

      // The numbers answer nothing from now on (resolve_business_by_phone), and go back to Twilio
      // after 30 days unless the business is brought back. One already set to go keeps its own date.
      // The shared sender texts for every business, so it stays, as a reclaim leaves it.
      const numbers = (await tx.select({ id: phoneNumbers.id, e164: phoneNumbers.e164 }).from(phoneNumbers).where(and(eq(phoneNumbers.businessId, businessId), eq(phoneNumbers.status, "active"), isNull(phoneNumbers.reclaimScheduledAt))))
        .filter((number) => !isSharedSmsSender(number.e164));
      const scheduled = numbers.length
        ? await tx.update(phoneNumbers).set({ reclaimScheduledAt: sql`now() + interval '30 days'`, reclaimReason: "cancellation", updatedAt: new Date() }).where(and(eq(phoneNumbers.businessId, businessId), inArray(phoneNumbers.id, numbers.map((number) => number.id)))).returning({ at: phoneNumbers.reclaimScheduledAt })
        : [];
      const numbersReleasedOn = scheduled[0]?.at ?? null;

      // Nobody should keep paying for a business they can't use. The admin's
      // Polar token can't end a plan, so the worker does; a plan the operator
      // bills outside Polar is theirs to end, and the inbox's email says so.
      const [account] = await tx.select({ source: billingAccounts.source, subscriptionId: billingAccounts.subscriptionId, subscriptionState: billingAccounts.subscriptionState }).from(billingAccounts).where(eq(billingAccounts.businessId, businessId)).limit(1);
      const subscriptionId = subscriptionToEnd(account);
      if (subscriptionId) {
        await enqueueOutbox(tx, { topic: "billing.revokeSubscription", businessId, aggregateType: "billing_account", aggregateId: businessId, dedupeKey: `billing-revoke:${subscriptionId}:cancellation`, payload: { subscriptionId } });
      }

      const now = new Date();
      await tx.update(businessCancellationRequests).set({ status: "confirmed", confirmedAt: now, updatedAt: now }).where(eq(businessCancellationRequests.id, current.id));
      await tx.insert(auditLogs).values({ businessId, actorUserId: userId, eventType: "business.canceled", entityType: "business", entityId: businessId, payload: { requestId: current.id, numbers: numbers.length, endsPlan: Boolean(subscriptionId) } });
      if (inbox && details) {
        await enqueueOutbox(tx, {
          topic: "email.send",
          businessId,
          aggregateType: "business_cancellation_request",
          aggregateId: current.id,
          dedupeKey: `business-cancellation:${current.id}:canceled`,
          payload: {
            template: "cancellation_completed",
            to: inbox,
            variables: {
              ...details,
              requesterName: owner?.name ?? "",
              requesterEmail: owner?.email ?? request.email,
              canceledAt: utc(now),
              planOutcome: subscriptionId ? "polar" : isManagedBillingAccount(account) ? "managed" : "free",
              ...(numbersReleasedOn ? { numbersReleasedOn: utc(numbersReleasedOn).slice(0, 10) } : {}),
            },
          },
        });
      }
      // Last: from here on, row-level security closes the business to its whole team, this owner too.
      await tx.execute(sql`select app.cancel_business(${businessId}::uuid)`);
      return { businessId, businessName: business.name, numbersReleasedOn, endsPlan: Boolean(subscriptionId) };
    });
  } catch (error) {
    throw guardRefusal(error) ?? error;
  }
}
