import { NextResponse } from "next/server";
import { z } from "zod";

import { hasMinimumRole, readBusinessTelemetryPreferenceInTransaction, requireBusinessMembership, setBusinessTelemetryPreferenceInTransaction } from "@lobbystack/domain";
import { asApiResponse, withOperatorTransaction } from "@/lib/api-helpers";
import { jsonError, parseBody } from "@/lib/request-input";
import { runtimeDeploymentMode } from "@/lib/deployment-mode";

export const dynamic = "force-dynamic";

const telemetryChoice = z.object({ telemetryEnabled: z.boolean("telemetryEnabled is true or false.") });

export async function GET(request: Request) {
  try {
    return NextResponse.json(await withOperatorTransaction(request, async ({ session, businessId, tx }) => {
      const membership = await requireBusinessMembership(tx, { userId: session.user.id, businessId });
      // Browser telemetry stamps this on every event once the workspace opts in.
      const telemetryEnabled = await readBusinessTelemetryPreferenceInTransaction(tx, { businessId });
      if (telemetryEnabled === null) throw jsonError("Business not found.", 404);
      return { telemetryEnabled, canManageTenant: hasMinimumRole(membership.role, "business_admin"), deploymentMode: runtimeDeploymentMode() };
    }));
  } catch (error) { return asApiResponse(error); }
}

export async function PATCH(request: Request) {
  try {
    return NextResponse.json(await withOperatorTransaction(request, async ({ businessId, tx }) => {
      const { telemetryEnabled } = await parseBody(request, telemetryChoice);
      await setBusinessTelemetryPreferenceInTransaction(tx, { businessId, telemetryEnabled });
      return { telemetryEnabled };
    }, { minimumRole: "business_admin" }));
  } catch (error) { return asApiResponse(error); }
}
