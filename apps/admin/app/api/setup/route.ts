import { NextResponse } from "next/server";

import { loadSetupGuideInTransaction, setupGuideStepIds, updateSetupGuideSkippedStepsInTransaction } from "@lobbystack/domain";
import { asApiResponse, jsonError, readJson, withOperatorTransaction } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    return NextResponse.json(await withOperatorTransaction(request, async ({ businessId, tx }) => {
      const { steps, fullScanDocumentId } = await loadSetupGuideInTransaction(tx, businessId);
      return {
        steps: [
          { id: "fullScan", name: "Read the rest of your site", description: "Onboarding read a sample", documentId: fullScanDocumentId, status: steps.fullScan },
          { id: "sources", name: "Add more sources", description: "Upload policies, FAQs, or pricing", status: steps.sources },
          { id: "testCall", name: "Hear your agent", description: "Call it from your browser", status: steps.testCall },
          { id: "phoneNumber", name: "Connect a phone number", description: "Let it answer real callers", status: steps.phoneNumber },
        ],
      };
    }, { minimumRole: "business_admin" }));
  } catch (error) {
    return asApiResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    return NextResponse.json(await withOperatorTransaction(request, async ({ businessId, tx }) => {
      const body = await readJson(request) as { stepId?: string; skipped?: boolean };
      if (!body || !setupGuideStepIds.includes(body.stepId as (typeof setupGuideStepIds)[number]) || typeof body.skipped !== "boolean") throw jsonError("A valid stepId and skipped flag are required.");
      const changed = await updateSetupGuideSkippedStepsInTransaction(tx, businessId, (current) => body.skipped ? Array.from(new Set([...current, body.stepId!])) : current.filter((id) => id !== body.stepId));
      if (!changed) throw jsonError("Business not found.", 404);
      return { skippedSteps: changed.after };
    }, { minimumRole: "business_admin" }));
  } catch (error) {
    return asApiResponse(error);
  }
}
