import { NextResponse } from "next/server";
import { z } from "zod";

import { createTopUpCheckoutRequest, packCheckoutConfigured, readPackCheckoutInTransaction } from "@lobbystack/domain";
import { billingProviderNames, billingProviderOf, planChangeRefusalOf } from "@lobbystack/shared";
import { asApiResponse, businessIdFromRequest, readJson, requireApiSession, withOperatorTransaction } from "@/lib/api-helpers";
import { assertBillingCallAllowed } from "@/lib/billing-limit";
import { createDomainContext } from "@/lib/domain-context";

// The dashboard's checkout for a top-up on sale (docs/features/top-ups.md):
// POST queues one, and GET reads it while the page waits for the provider's
// payment page, then for the payment, as /api/billing/packs/checkout does for
// a pack, whose table and job it shares.

export const dynamic = "force-dynamic";

const billingEmailSchema = z.email().max(320);
/** A top-up's code in billing.json's topUps, as billing_pack_plans keeps it. */
const topUpSchema = z.string().trim().min(1).max(48);

const invalid = (message: string) => Object.assign(new Error(message), { status: 400 });

export async function GET(request: Request) {
  try {
    const checkoutId = new URL(request.url).searchParams.get("checkoutId");
    if (!checkoutId) throw invalid("A checkoutId is required.");
    return NextResponse.json(await withOperatorTransaction(request, async ({ businessId, tx }) => {
      const checkout = await readPackCheckoutInTransaction(tx, { businessId, checkoutId });
      if (!checkout || checkout.kind !== "top_up") throw Object.assign(new Error("Top-up checkout not found."), { status: 404 });
      return {
        id: checkout.id,
        topUp: checkout.pack,
        status: checkout.status,
        // Only while the page is ready and still open.
        checkoutUrl: checkout.checkoutUrl,
        error: checkout.error,
        expiresAt: checkout.expiresAt.toISOString(),
        // What became of the top-up once the payment arrived: refunded when the payment went back first, frozen while a dispute holds it.
        topUpStatus: checkout.topUpStatus,
        // The payment arrived and the business has the top-up, live or held by a dispute.
        synced: checkout.status === "paid" && checkout.topUpStatus !== null && checkout.topUpStatus !== "refunded",
        refusal: planChangeRefusalOf(checkout.error),
        providerName: billingProviderNames[billingProviderOf(process.env)],
      };
    }, { minimumRole: "business_admin" }));
  } catch (error) {
    return asApiResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireApiSession(request);
    const body = await readJson(request);
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw invalid("A top-up checkout request is required.");
    const input = body as Record<string, unknown>;
    const businessId = typeof input.businessId === "string" ? input.businessId : businessIdFromRequest(request);
    if (!businessId) throw invalid("A businessId is required.");
    const topUp = topUpSchema.safeParse(input.topUp);
    if (!topUp.success) throw invalid("topUp is invalid.");
    // As GET /api/billing and the API say: without the deployment's provider set up, no page could be made.
    if (!packCheckoutConfigured(process.env)) throw Object.assign(new Error("Top-ups can't be bought here right now."), { status: 409, code: "top_up_not_on_sale" });
    // The email the business's new provider customer gets when the provider already has the person's own for another business.
    const billingEmail = typeof input.billingEmail === "string" ? input.billingEmail.trim() : input.billingEmail;
    if (billingEmail !== undefined && !billingEmailSchema.safeParse(billingEmail).success) throw invalid("billingEmail must be an email address.");
    // Each new checkout is a call to the provider, counted with plan and pack checkouts; the person's open one for the same top-up comes back without one.
    const checkLimit = (subject: { businessId: string; userId: string }) => assertBillingCallAllowed("checkout", subject);
    const checkoutId = await createTopUpCheckoutRequest(createDomainContext(), { userId: session.user.id, businessId, topUp: topUp.data, ...(typeof billingEmail === "string" ? { billingEmail } : {}), checkLimit });
    return NextResponse.json({ checkoutId }, { status: 202 });
  } catch (error) {
    return asApiResponse(error);
  }
}
