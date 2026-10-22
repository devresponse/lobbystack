import { billingIntervals, billingPlanPrice, hostedCheckoutPlanSlugs, isWidgetKeyIssuanceEnabled, type HostedCheckoutPlanIntervals } from "@lobbystack/shared";
import { NextResponse } from "next/server";
import { and, desc, eq, sql } from "drizzle-orm";

import { billingAccounts, billingTransactions, billingUsageEvents, billingUsageMonths } from "@lobbystack/db";
import { billingAccess, billingPlanList, getKnowledgeStorageUsageBytes, loadBillingCatalog, loadBillingContext, polarCheckoutConfigured, requireBusinessMembership, setOverageSpendingCap } from "@lobbystack/domain";
import { asApiResponse, jsonError, readJson, requireOperatorBusiness, withOperatorTransaction } from "@/lib/api-helpers";
import { createDomainContext } from "@/lib/domain-context";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    return NextResponse.json(await withOperatorTransaction(request, async ({ session, businessId, tx }) => {
      const membership = await requireBusinessMembership(tx, { userId: session.user.id, businessId });
      const periodKey = new Date().toISOString().slice(0, 7);
      const account = await tx.select({ source: billingAccounts.source, customerId: billingAccounts.customerId, subscriptionId: billingAccounts.subscriptionId, plan: billingAccounts.plan, billingKey: billingAccounts.billingKey, billingInterval: billingAccounts.billingInterval, subscriptionState: billingAccounts.subscriptionState, currentPeriodStart: billingAccounts.currentPeriodStart, currentPeriodEnd: billingAccounts.currentPeriodEnd, overageSpendingCapCents: billingAccounts.overageSpendingCapCents }).from(billingAccounts).where(eq(billingAccounts.businessId, businessId)).limit(1);
      const usage = await tx.select({ periodKey: billingUsageEvents.periodKey, usageKind: billingUsageEvents.usageKind, quantity: billingUsageEvents.quantity, isFinal: billingUsageEvents.isFinal, syncStatus: billingUsageEvents.syncStatus }).from(billingUsageEvents).where(and(eq(billingUsageEvents.businessId, businessId), eq(billingUsageEvents.periodKey, periodKey))).orderBy(desc(billingUsageEvents.createdAt)).limit(100);
      const usageMonth = await tx.select({ periodKey: billingUsageMonths.periodKey, voiceSecondsUsed: billingUsageMonths.voiceSecondsUsed, alertSmsSegmentsUsed: billingUsageMonths.alertSmsSegmentsUsed, outboundCallAttemptsUsed: billingUsageMonths.outboundCallAttemptsUsed, voiceBlocked: billingUsageMonths.voiceBlocked, alertSmsBlocked: billingUsageMonths.alertSmsBlocked, outboundCallAttemptsBlocked: billingUsageMonths.outboundCallAttemptsBlocked, overageSpendCents: billingUsageMonths.overageSpendCents }).from(billingUsageMonths).where(and(eq(billingUsageMonths.businessId, businessId), eq(billingUsageMonths.periodKey, periodKey))).limit(1);
      const transactions = await tx.select({ kind: billingTransactions.kind, sourceId: billingTransactions.sourceId, status: billingTransactions.status, amountCents: billingTransactions.amountCents, refundedAmountCents: billingTransactions.refundedAmountCents, currency: billingTransactions.currency, description: billingTransactions.description, invoiceUrl: billingTransactions.invoiceUrl, occurredAt: billingTransactions.occurredAt }).from(billingTransactions).where(eq(billingTransactions.businessId, businessId)).orderBy(desc(billingTransactions.occurredAt)).limit(20);
      const incompleteUsage = await tx.select({ count: sql<number>`count(*)` }).from(billingUsageEvents).where(and(eq(billingUsageEvents.businessId, businessId), eq(billingUsageEvents.periodKey, periodKey), eq(billingUsageEvents.isFinal, false)));
      const knowledgeStorageBytesUsed = await getKnowledgeStorageUsageBytes(tx, businessId);
      // The plan the server enforces: a canceled Pro subscription still stores plan "pro".
      const { plan: effectivePlan } = await loadBillingContext(tx, businessId);
      const month = usageMonth[0];
      const cap = account[0]?.overageSpendingCapCents ?? null;
      const permissions = billingAccess(membership.role, account[0] ?? null, polarCheckoutConfigured(process.env));
      // The plans as the catalog has them, or this build's before an apply. A price can be bought here when a Polar product sells it.
      const { catalog, links } = await loadBillingCatalog(tx, process.env);
      const plans = billingPlanList(catalog, { checkout: permissions.hasCheckoutAccess, links });
      const availableCheckoutIntervals: HostedCheckoutPlanIntervals = { starter: [], pro: [] };
      for (const plan of hostedCheckoutPlanSlugs) {
        for (const interval of billingIntervals) {
          if (billingPlanPrice(plans.plans.find((offer) => offer.slug === plan), interval)?.checkoutAvailable) availableCheckoutIntervals[plan].push(interval);
        }
      }
      const availableCheckoutPlans = hostedCheckoutPlanSlugs.filter(plan => availableCheckoutIntervals[plan].length > 0);
      return { availableCheckoutPlans, availableCheckoutIntervals, plans, account: account[0] ?? null, effectivePlan, knowledgeStorageBytesUsed, permissions, checkoutAvailable: permissions.hasCheckoutAccess, widgetIssuanceEnabled: isWidgetKeyIssuanceEnabled(process.env), usage, usageStatus: month ? { ...month, usageComplete: Number(incompleteUsage[0]?.count ?? 0) === 0, overageSpendingCapCents: cap, overageSpendingCapReached: cap !== null && month.overageSpendCents > 0 && month.overageSpendCents >= cap } : null, transactions: permissions.hasBillingManagementAccess ? transactions : [] };
    }));
  } catch (error) {
    return asApiResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const { session, businessId } = await requireOperatorBusiness(request);
    const body = await readJson(request);
    if (typeof body !== "object" || body === null || !("capCents" in body)) return jsonError("capCents is required.", 400);
    const capCents = (body as { capCents?: unknown }).capCents;
    if (capCents !== null && (typeof capCents !== "number" || !Number.isSafeInteger(capCents) || capCents < 0)) return jsonError("capCents must be a non-negative whole number of cents or null.", 400);
    return NextResponse.json(await setOverageSpendingCap(createDomainContext(), { userId: session.user.id, businessId, capCents: capCents as number | null }));
  } catch (error) {
    return asApiResponse(error);
  }
}
