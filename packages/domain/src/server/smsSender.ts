import { and, asc, desc, eq, sql } from "drizzle-orm";

import { billingAccounts, businesses, phoneNumbers, type DatabaseTransaction } from "@lobbystack/db";

/**
 * LobbyStack's own verified number, which texts for every cloud business
 * that has no number of its own. No business owns it, so inbound texts to it
 * don't resolve to a business.
 */
export function sharedSmsSender(): string | null {
  return process.env.TWILIO_ALERT_SMS_FROM?.trim() || null;
}

/** Whether a number is the shared sender. */
export function isSharedSmsSender(phone: string | null | undefined): boolean {
  const shared = sharedSmsSender();
  return Boolean(shared && phone === shared);
}

/**
 * A business's own number for texts: its newest active SMS-enabled number.
 * A replaced number stays active until its release, so one that isn't being
 * released comes first. Null when the business has none.
 */
export async function businessSmsNumber(tx: DatabaseTransaction, businessId: string): Promise<string | null> {
  return (await tx.select({ e164: phoneNumbers.e164 }).from(phoneNumbers)
    .where(and(eq(phoneNumbers.businessId, businessId), eq(phoneNumbers.status, "active"), eq(phoneNumbers.smsEnabled, true)))
    .orderBy(sql`${phoneNumbers.reclaimScheduledAt} is not null`, desc(phoneNumbers.createdAt), asc(phoneNumbers.id))
    .limit(1))[0]?.e164 ?? null;
}

/**
 * The number a business texts from, for operator alerts and customer texts
 * alike (confirmations, reminders, cancellations and change codes): its own
 * number when it has one, so customers can reply to the business. A cloud
 * business without one texts from the shared sender, TWILIO_ALERT_SMS_FROM; a
 * self-hosted one has no sender. Self-hosted means the self-hosted plan, or,
 * without a billing account, a deployment mode other than cloud. Null when
 * there's no sender.
 */
export async function resolveSmsSender(tx: DatabaseTransaction, businessId: string): Promise<string | null> {
  const own = await businessSmsNumber(tx, businessId);
  if (own) return own;
  const account = (await tx.select({ plan: billingAccounts.plan }).from(billingAccounts).where(eq(billingAccounts.businessId, businessId)).limit(1))[0];
  const business = (await tx.select({ deploymentMode: businesses.deploymentMode }).from(businesses).where(eq(businesses.id, businessId)).limit(1))[0];
  const selfHosted = account?.plan ? account.plan === "self_hosted_standard" : business?.deploymentMode !== "cloud";
  return selfHosted ? null : sharedSmsSender();
}
