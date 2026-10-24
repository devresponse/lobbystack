import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { billingAccounts, billingCheckoutRequests } from "@lobbystack/db";
import { createBillingCheckoutRequest, type BillingCheckoutTarget, type BillingInterval } from "@lobbystack/domain";
import { planChangeRefusalOf } from "@lobbystack/shared";
import { asApiResponse, businessIdFromRequest, readJson, requireApiSession, withOperatorTransaction } from "@/lib/api-helpers";
import { assertBillingCallAllowed } from "@/lib/billing-limit";
import { createDomainContext } from "@/lib/domain-context";
import { checkPromoCodeLimit, promoCodeLimitResponse } from "@/lib/promo-code-limit";
import { trustedClientIp } from "@/lib/trusted-client-ip";

export const dynamic = "force-dynamic";

const targets = ["starter", "pro"] as const;
const intervals = ["monthly", "annual"] as const;
const billingEmailSchema = z.email().max(320);

export async function GET(request: Request) {
  try {
    const requestId = new URL(request.url).searchParams.get("requestId");
    if (!requestId) throw new Error("A requestId is required.");
    return NextResponse.json(await withOperatorTransaction(request, async ({ businessId, tx }) => {
      const row = (await tx.select({ id: billingCheckoutRequests.id, status: billingCheckoutRequests.status, checkoutId: billingCheckoutRequests.checkoutId, checkoutUrl: billingCheckoutRequests.checkoutUrl, error: billingCheckoutRequests.error, target: billingCheckoutRequests.target, billingInterval: billingCheckoutRequests.billingInterval, planCode: billingCheckoutRequests.planCode }).from(billingCheckoutRequests).where(and(eq(billingCheckoutRequests.id, requestId), eq(billingCheckoutRequests.businessId, businessId))).limit(1))[0];
      if (!row) throw new Error("Checkout request not found.");
      const account = (await tx.select({ plan: billingAccounts.plan, interval: billingAccounts.billingInterval, state: billingAccounts.subscriptionState, planCode: billingAccounts.planCode }).from(billingAccounts).where(eq(billingAccounts.businessId, businessId)).limit(1))[0];
      // A checkout someone paid, or a plan change Polar made, once Polar's webhook has put the business on the plan: a promo code's plan, or the target's standard one.
      const synced = ["ready", "changed"].includes(row.status) && account?.plan === row.target && account.interval === row.billingInterval && account.planCode === row.planCode && ["active", "trialing"].includes(account.state ?? "");
      return { ...row, synced, refusal: planChangeRefusalOf(row.error) };
    }, { minimumRole: "business_admin" }));
  } catch (error) {
    return asApiResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireApiSession(request);
    const body = await readJson(request);
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error("A checkout request is required.");
    const input = body as Record<string, unknown>;
    const businessId = typeof input.businessId === "string" ? input.businessId : businessIdFromRequest(request);
    if (!businessId) throw new Error("A businessId is required.");
    if (typeof input.target !== "string" || !targets.includes(input.target as BillingCheckoutTarget)) throw new Error("target is invalid.");
    if (typeof input.billingInterval !== "string" || !intervals.includes(input.billingInterval as BillingInterval)) throw new Error("billingInterval is invalid.");
    if (input.promoCode !== undefined && typeof input.promoCode !== "string") throw new Error("promoCode is invalid.");
    // The email the business's new Polar customer gets when Polar already has the person's own for another business.
    const billingEmail = typeof input.billingEmail === "string" ? input.billingEmail.trim() : input.billingEmail;
    if (billingEmail !== undefined && !billingEmailSchema.safeParse(billingEmail).success) throw Object.assign(new Error("billingEmail must be an email address."), { status: 400 });
    // A code sells the plan it unlocks, whatever the target; each try counts as a guess.
    const promoCode = typeof input.promoCode === "string" && input.promoCode.trim() ? input.promoCode : undefined;
    const checkPromoCode = async () => {
      const limit = await checkPromoCodeLimit({ businessId, userId: session.user.id, ip: trustedClientIp(request) });
      if (!limit.allowed) throw promoCodeLimitResponse(limit.status);
    };
    // Each new request is a call to Polar; the person's open one for the same checkout comes back without one.
    const checkLimit = (subject: { businessId: string; userId: string }) => assertBillingCallAllowed("checkout", subject);
    const requestId = await createBillingCheckoutRequest(createDomainContext(), { userId: session.user.id, businessId, target: input.target as BillingCheckoutTarget, billingInterval: input.billingInterval as BillingInterval, promoCode, ...(typeof billingEmail === "string" ? { billingEmail } : {}), checkPromoCode, checkLimit });
    return NextResponse.json({ requestId }, { status: 202 });
  } catch (error) {
    return asApiResponse(error);
  }
}
