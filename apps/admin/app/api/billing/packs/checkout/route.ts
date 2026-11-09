import { NextResponse } from "next/server";
import { z } from "zod";

import { createPackCheckoutRequest, readPackCheckoutInTransaction } from "@lobbystack/domain";
import { billingProviderNames, billingProviderOf, planChangeRefusalOf } from "@lobbystack/shared";
import { asApiResponse, businessIdFromRequest, readJson, requireApiSession, withOperatorTransaction } from "@/lib/api-helpers";
import { assertBillingCallAllowed } from "@/lib/billing-limit";
import { createDomainContext } from "@/lib/domain-context";

// The dashboard's checkout for a prepaid pack: POST queues one, and GET reads
// it while the page waits for the provider's payment page, then for the
// payment, as /api/billing/checkout does for a plan.

export const dynamic = "force-dynamic";

const billingEmailSchema = z.email().max(320);
/** A pack's code in billing.json's packs, as billing_pack_plans keeps it. */
const packSchema = z.string().trim().min(1).max(48);

const invalid = (message: string) => Object.assign(new Error(message), { status: 400 });

export async function GET(request: Request) {
  try {
    const checkoutId = new URL(request.url).searchParams.get("checkoutId");
    if (!checkoutId) throw invalid("A checkoutId is required.");
    return NextResponse.json(await withOperatorTransaction(request, async ({ businessId, tx }) => {
      const checkout = await readPackCheckoutInTransaction(tx, { businessId, checkoutId });
      if (!checkout) throw Object.assign(new Error("Pack checkout not found."), { status: 404 });
      return {
        id: checkout.id,
        pack: checkout.pack,
        status: checkout.status,
        // Only while the page is ready and still open.
        checkoutUrl: checkout.checkoutUrl,
        error: checkout.error,
        expiresAt: checkout.expiresAt.toISOString(),
        // billing.reconcile marks the checkout paid as it adds the pack, so the business has it once this is true.
        synced: checkout.status === "paid",
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
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw invalid("A pack checkout request is required.");
    const input = body as Record<string, unknown>;
    const businessId = typeof input.businessId === "string" ? input.businessId : businessIdFromRequest(request);
    if (!businessId) throw invalid("A businessId is required.");
    const pack = packSchema.safeParse(input.pack);
    if (!pack.success) throw invalid("pack is invalid.");
    // The email the business's new provider customer gets when the provider already has the person's own for another business.
    const billingEmail = typeof input.billingEmail === "string" ? input.billingEmail.trim() : input.billingEmail;
    if (billingEmail !== undefined && !billingEmailSchema.safeParse(billingEmail).success) throw invalid("billingEmail must be an email address.");
    // Each new checkout is a call to the provider, counted with plan checkouts; the person's open one for the same pack comes back without one.
    const checkLimit = (subject: { businessId: string; userId: string }) => assertBillingCallAllowed("checkout", subject);
    const checkoutId = await createPackCheckoutRequest(createDomainContext(), { userId: session.user.id, businessId, pack: pack.data, ...(typeof billingEmail === "string" ? { billingEmail } : {}), checkLimit });
    return NextResponse.json({ checkoutId }, { status: 202 });
  } catch (error) {
    return asApiResponse(error);
  }
}
