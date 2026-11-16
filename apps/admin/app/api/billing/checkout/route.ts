import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { billingAccounts, billingCheckoutRequests } from "@lobbystack/db";
import { billingSubscriptionChangeShown, createBillingCheckoutRequest, isBillingSubscriptionAction, type BillingCheckoutTarget, type BillingInterval } from "@lobbystack/domain";
import { billingProviderNames, billingProviderOf, planChangeRefusalOf } from "@lobbystack/shared";
import { asApiResponse, businessIdFromRequest, requireApiSession, withOperatorTransaction } from "@/lib/api-helpers";
import { assertBillingCallAllowed } from "@/lib/billing-limit";
import { createDomainContext } from "@/lib/domain-context";
import { checkPromoCodeLimit, promoCodeLimitResponse } from "@/lib/promo-code-limit";
import { jsonError, parseBody, parseQuery } from "@/lib/request-input";
import { trustedClientIp } from "@/lib/trusted-client-ip";

export const dynamic = "force-dynamic";

const targets = ["starter", "pro"] as const satisfies readonly BillingCheckoutTarget[];
const intervals = ["monthly", "annual"] as const satisfies readonly BillingInterval[];

// The one refusal a person can meet: the onboarding plan page shows it under the billing email they typed.
const billingEmailMessage = "Give an email address, such as billing@example.com.";

// A caller's mistake answers 400 with the field's name, never a 500 and an error report (AUDIT-007).
const checkoutLookup = z.object({
  // Any id PostgreSQL would take, so a request that exists is never refused here; anything else never reaches it.
  requestId: z.guid({ error: (issue) => (issue.input === undefined ? "requestId is required." : "requestId is the id a checkout request answered with.") }),
});
const checkoutStart = z.object({
  // Without one, the business the request names in its address or its header.
  businessId: z.string("businessId is text.").nullish(),
  target: z.enum(targets, "target is starter or pro."),
  billingInterval: z.enum(intervals, "billingInterval is monthly or annual."),
  promoCode: z.string("promoCode is text.").optional(),
  // The email the business's new Polar customer gets when Polar already has the person's own for another business.
  billingEmail: z.string(billingEmailMessage).trim().pipe(z.email(billingEmailMessage).max(320, billingEmailMessage)).optional(),
}, "A checkout request is a JSON object.");

export async function GET(request: Request) {
  try {
    const { requestId } = parseQuery(request, checkoutLookup);
    return NextResponse.json(await withOperatorTransaction(request, async ({ businessId, tx }) => {
      const row = (await tx.select({ id: billingCheckoutRequests.id, status: billingCheckoutRequests.status, checkoutId: billingCheckoutRequests.checkoutId, checkoutUrl: billingCheckoutRequests.checkoutUrl, error: billingCheckoutRequests.error, target: billingCheckoutRequests.target, billingInterval: billingCheckoutRequests.billingInterval, planCode: billingCheckoutRequests.planCode }).from(billingCheckoutRequests).where(and(eq(billingCheckoutRequests.id, requestId), eq(billingCheckoutRequests.businessId, businessId))).limit(1))[0];
      if (!row) throw jsonError("Checkout request not found.", 404, "not_found");
      const account = (await tx.select({ plan: billingAccounts.plan, interval: billingAccounts.billingInterval, state: billingAccounts.subscriptionState, planCode: billingAccounts.planCode, cancelAt: billingAccounts.cancelAt, nextPlanCode: billingAccounts.nextPlanCode }).from(billingAccounts).where(eq(billingAccounts.businessId, businessId)).limit(1))[0];
      // A cancel, resume or keep once the provider's webhook shows it; a checkout someone paid, or a plan change the
      // provider made, once its webhook has put the business on the plan: a promo code's plan, or the target's standard one.
      const synced = isBillingSubscriptionAction(row.target)
        ? row.status === "changed" && billingSubscriptionChangeShown(account, row.target)
        : ["ready", "changed"].includes(row.status) && account?.plan === row.target && account.interval === row.billingInterval && account.planCode === row.planCode && ["active", "trialing"].includes(account.state ?? "");
      return { ...row, synced, refusal: planChangeRefusalOf(row.error), providerName: billingProviderNames[billingProviderOf(process.env)] };
    }, { minimumRole: "business_admin" }));
  } catch (error) {
    return asApiResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireApiSession(request);
    const input = await parseBody(request, checkoutStart);
    const businessId = input.businessId ?? businessIdFromRequest(request);
    if (!businessId) throw jsonError("A businessId is required.", 400, "invalid_request");
    // A code sells the plan it unlocks, whatever the target; each try counts as a guess.
    const promoCode = input.promoCode?.trim() ? input.promoCode : undefined;
    const checkPromoCode = async () => {
      const limit = await checkPromoCodeLimit({ businessId, userId: session.user.id, ip: trustedClientIp(request) });
      if (!limit.allowed) throw promoCodeLimitResponse(limit.status);
    };
    // Each new request is a call to Polar; the person's open one for the same checkout comes back without one.
    const checkLimit = (subject: { businessId: string; userId: string }) => assertBillingCallAllowed("checkout", subject);
    const requestId = await createBillingCheckoutRequest(createDomainContext(), { userId: session.user.id, businessId, target: input.target, billingInterval: input.billingInterval, promoCode, ...(input.billingEmail !== undefined ? { billingEmail: input.billingEmail } : {}), checkPromoCode, checkLimit });
    return NextResponse.json({ requestId }, { status: 202 });
  } catch (error) {
    return asApiResponse(error);
  }
}
