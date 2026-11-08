import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { billingAccounts } from "@lobbystack/db";
import { createBillingProvider } from "@lobbystack/providers";
import { hasBillingCustomerPortal, isManagedBillingAccount } from "@lobbystack/domain";
import { asApiResponse, jsonError, withOperatorTransaction } from "@/lib/api-helpers";
import { assertBillingCallAllowed } from "@/lib/billing-limit";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const billing = createBillingProvider(process.env);
    if (!billing) throw new Error("Billing customer portal is not configured.");
    const { account, businessId, userId } = await withOperatorTransaction(request, async ({ businessId, session, tx }) => ({
      account: (await tx.select({ source: billingAccounts.source, billingKey: billingAccounts.billingKey, customerId: billingAccounts.customerId, subscriptionId: billingAccounts.subscriptionId, plan: billingAccounts.plan, subscriptionState: billingAccounts.subscriptionState }).from(billingAccounts).where(eq(billingAccounts.businessId, businessId)).limit(1))[0] ?? null,
      businessId,
      userId: session.user.id,
    }), { minimumRole: "business_admin" });
    if (!account || !hasBillingCustomerPortal(account)) return jsonError("A billing customer with subscription history is required before opening the customer portal.", 409);
    // The operator bills a managed plan directly, so Polar has nothing for its customer to manage.
    if (isManagedBillingAccount(account)) return jsonError("This business is on a managed plan, billed directly by the operator.", 409);
    // Each session is a call to Polar.
    await assertBillingCallAllowed("portal", { businessId, userId });
    return NextResponse.json(await billing.createPortalSession({ customer: { id: account.customerId, billingKey: account.billingKey }, returnUrl: `${process.env.APP_BASE_URL ?? new URL(request.url).origin}/settings/plan`, locale: null }));
  } catch (error) { return asApiResponse(error); }
}
