import { and, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";

import { billingAccounts, businesses, phoneNumbers } from "@lobbystack/db";
import { countOperatorTestCallsHeard, currentWebsiteIngestion, loadBusinessPlanLimits } from "@lobbystack/domain";
import { asApiResponse, withOperatorTransaction } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

/**
 * Activation state for the dashboard: what the agent has learned, whether the
 * operator has heard it work, and whether it can answer a real phone call yet.
 * A successful web call is one that carried media and then ended, which is a
 * durable fact about the call rather than a provider status string.
 */
export async function GET(request: Request) {
  try {
    return NextResponse.json(await withOperatorTransaction(request, async ({ businessId, tx }) => {
      const business = (await tx.select({ deploymentMode: businesses.deploymentMode }).from(businesses).where(eq(businesses.id, businessId)).limit(1))[0];
      const account = (await tx.select({ plan: billingAccounts.plan }).from(billingAccounts).where(eq(billingAccounts.businessId, businessId)).limit(1))[0];
      const { limits } = await loadBusinessPlanLimits(tx, businessId);
      const number = (await tx.select({ id: phoneNumbers.id }).from(phoneNumbers).where(and(eq(phoneNumbers.businessId, businessId), eq(phoneNumbers.status, "active"), isNull(phoneNumbers.reclaimScheduledAt))).limit(1))[0];
      const completedWebCalls = await countOperatorTestCallsHeard(tx, businessId);
      const ingestion = await currentWebsiteIngestion(tx, businessId);
      return {
        deploymentMode: business?.deploymentMode ?? "cloud",
        plan: account?.plan ?? "free_cloud",
        // A plan in force that includes a number can still lack one: the
        // onboarding number step can be skipped, and those operators need
        // claiming, not checkout. A promo plan can include none, and a
        // catalog can give Free one.
        numberIncluded: limits.includedBusinessNumbers !== 0,
        hasDedicatedNumber: Boolean(number),
        completedWebCalls,
        websiteImport: ingestion ? { status: ingestion.status, websiteUrl: ingestion.websiteUrl, importedCount: ingestion.importedCount, indexedCount: ingestion.indexedCount } : null,
      };
    }));
  } catch (error) {
    return asApiResponse(error);
  }
}
