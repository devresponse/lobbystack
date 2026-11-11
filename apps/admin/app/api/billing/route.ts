import { billingIntervals, billingPlanPrice, billingProviderNames, billingProviderOf, hostedCheckoutPlanSlugs, inAppPlanActions, isWidgetKeyIssuanceEnabled, type HostedCheckoutPlanIntervals } from "@lobbystack/shared";
import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";

import { billingAccounts, billingPlans, billingTransactions, billingUsageEvents } from "@lobbystack/db";
import { billingAccess, billingPlanList, isLiveSubscriptionState, isReplacedSubscription, deploymentBrandCatalog, deploymentPlanDisplay, getKnowledgeStorageUsageBytes, loadBillingCatalog, loadBusinessPacks, loadBusinessPlanLimits, loadBusinessPromoPlan, loadPackOffers, loadPlanChangePayment, packCheckoutConfigured, packCheckoutEligibility, polarCheckoutConfigured, readUsageStatusInTransaction, requireBusinessMembership, setOverageSpendingCap, type PackCheckoutEligibility } from "@lobbystack/domain";
import { asApiResponse, jsonError, readJson, requireOperatorBusiness, withOperatorTransaction } from "@/lib/api-helpers";
import { createDomainContext } from "@/lib/domain-context";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    return NextResponse.json(await withOperatorTransaction(request, async ({ session, businessId, tx }) => {
      const membership = await requireBusinessMembership(tx, { userId: session.user.id, businessId });
      const periodKey = new Date().toISOString().slice(0, 7);
      const [own] = await tx.select({ source: billingAccounts.source, customerId: billingAccounts.customerId, subscriptionId: billingAccounts.subscriptionId, plan: billingAccounts.plan, billingKey: billingAccounts.billingKey, billingInterval: billingAccounts.billingInterval, subscriptionState: billingAccounts.subscriptionState, currentPeriodStart: billingAccounts.currentPeriodStart, currentPeriodEnd: billingAccounts.currentPeriodEnd, overageSpendingCapCents: billingAccounts.overageSpendingCapCents, cancelAt: billingAccounts.cancelAt, nextPlanCode: billingAccounts.nextPlanCode, nextInterval: billingAccounts.nextInterval, nextChangeAt: billingAccounts.nextChangeAt, planCode: billingAccounts.planCode, replacedSubscriptionId: billingAccounts.replacedSubscriptionId }).from(billingAccounts).where(eq(billingAccounts.businessId, businessId)).limit(1);
      // The account as the screens read it; the promo code and the replaced subscription are for the reads below.
      const account = own ? [shownAccount(own)] : [];
      const usage = await tx.select({ periodKey: billingUsageEvents.periodKey, usageKind: billingUsageEvents.usageKind, quantity: billingUsageEvents.quantity, isFinal: billingUsageEvents.isFinal, syncStatus: billingUsageEvents.syncStatus }).from(billingUsageEvents).where(and(eq(billingUsageEvents.businessId, businessId), eq(billingUsageEvents.periodKey, periodKey))).orderBy(desc(billingUsageEvents.createdAt)).limit(100);
      // Counted now from the month's usage and the limits in force, so an upgrade or a new rate shows at once.
      const usageStatus = await readUsageStatusInTransaction(tx, { businessId, periodKey });
      const transactions = await tx.select({ kind: billingTransactions.kind, sourceId: billingTransactions.sourceId, status: billingTransactions.status, amountCents: billingTransactions.amountCents, refundedAmountCents: billingTransactions.refundedAmountCents, currency: billingTransactions.currency, description: billingTransactions.description, invoiceUrl: billingTransactions.invoiceUrl, occurredAt: billingTransactions.occurredAt }).from(billingTransactions).where(eq(billingTransactions.businessId, businessId)).orderBy(desc(billingTransactions.occurredAt)).limit(20);
      const knowledgeStorageBytesUsed = await getKnowledgeStorageUsageBytes(tx, businessId);
      // The plan the server enforces, and its limits: a canceled Pro subscription still stores plan "pro".
      const { plan: effectivePlan, limits } = await loadBusinessPlanLimits(tx, businessId);
      const permissions = billingAccess(membership.role, account[0] ?? null, polarCheckoutConfigured(process.env));
      // Prepaid packs: those on sale, those the business holds, and whether it may buy one now, which also says
      // when a pack would end its subscription. With neither there is nothing to show or buy, so a business on a
      // deployment that sells no packs costs these two small reads.
      const onSale = await loadPackOffers(tx, { checkout: true });
      const packs = await loadBusinessPacks(tx, businessId);
      const packCheckout: PackCheckoutEligibility = onSale.length > 0 || packs.length > 0 ? await packCheckoutEligibility(tx, { businessId, plan: effectivePlan, account: own ?? null }) : { refusal: null, endsSubscription: null };
      // A pack can be bought here by those who manage billing, through a provider set up for it, when nothing refuses.
      const packBuying = permissions.hasBillingManagementAccess && packCheckoutConfigured(process.env) && packCheckout.refusal === null;
      const packOffers = packBuying ? onSale : onSale.map((offer) => ({ ...offer, checkoutAvailable: false }));
      // The plans as the catalog has them, or before an apply as the brand's billing.json sets them in this build. A price can be bought here when a Polar product sells it.
      const { catalog, links } = await loadBillingCatalog(tx, process.env);
      const plans = billingPlanList(catalog, { checkout: permissions.hasCheckoutAccess, links, brandCatalog: deploymentBrandCatalog() });
      // The plan screens' words and layout from the brand's billing.json, which the build carries; null keeps the built-in ones.
      const planDisplay = deploymentPlanDisplay();
      const availableCheckoutIntervals: HostedCheckoutPlanIntervals = { starter: [], pro: [] };
      for (const plan of hostedCheckoutPlanSlugs) {
        for (const interval of billingIntervals) {
          if (billingPlanPrice(plans.plans.find((offer) => offer.slug === plan), interval)?.checkoutAvailable) availableCheckoutIntervals[plan].push(interval);
        }
      }
      const availableCheckoutPlans = hostedCheckoutPlanSlugs.filter(plan => availableCheckoutIntervals[plan].length > 0);
      // A promo plan the business took with a code, shown by its own name and price.
      const promoPlan = await loadBusinessPromoPlan(tx, businessId);
      // When a live plan ends unless resumed, or a change waiting for its renewal, with the plan's names; a
      // plan this business can't read, such as another's promo plan, shows its code. A subscription a pack
      // replaced counts as ended while the provider confirms it (decision 6), so neither shows under the pack.
      const replaced = isReplacedSubscription(own);
      const cancelsAt = !replaced && own?.cancelAt && isLiveSubscriptionState(own.subscriptionState) ? own.cancelAt : null;
      const [nextPlan] = !replaced && own?.nextPlanCode ? await tx.select({ tier: billingPlans.tier, names: billingPlans.names }).from(billingPlans).where(eq(billingPlans.code, own.nextPlanCode)).limit(1) : [];
      const nextChange = !replaced && own?.nextPlanCode && own.nextInterval && own.nextChangeAt ? { plan: own.nextPlanCode, tier: nextPlan?.tier ?? null, names: nextPlan?.names ?? null, interval: own.nextInterval, at: own.nextChangeAt } : null;
      // An upgrade waiting for the customer to confirm its payment, for those who can buy plans; none for a subscription a pack replaced.
      const paymentActionUrl = permissions.hasCheckoutAccess && !replaced ? await loadPlanChangePayment(tx, { businessId, subscriptionId: own?.subscriptionId ?? null }) : null;
      // The deployment's billing provider, which the plan screens name.
      const provider = billingProviderOf(process.env);
      // Cancel plan, Resume and Keep my plan, where the provider lets the app do them, for those who can buy plans.
      const planActions = permissions.hasCheckoutAccess && inAppPlanActions(provider);
      return { provider, providerName: billingProviderNames[provider], planActions, cancelsAt, nextChange, paymentActionUrl, availableCheckoutPlans, availableCheckoutIntervals, plans, planDisplay, promoPlan, account: account[0] ?? null, effectivePlan, limits, knowledgeStorageBytesUsed, permissions, checkoutAvailable: permissions.hasCheckoutAccess, widgetIssuanceEnabled: isWidgetKeyIssuanceEnabled(process.env), usage, usageStatus, transactions: permissions.hasBillingManagementAccess ? transactions : [], packOffers, packs, packCheckout };
    }));
  } catch (error) {
    return asApiResponse(error);
  }
}

/** The billing account without the fields only the server reads. */
function shownAccount<T extends { planCode: string | null; replacedSubscriptionId: string | null }>(row: T): Omit<T, "planCode" | "replacedSubscriptionId"> {
  const { planCode: _planCode, replacedSubscriptionId: _replacedSubscriptionId, ...shown } = row;
  return shown;
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
