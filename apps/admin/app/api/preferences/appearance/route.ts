import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { hasMinimumRole, requireBusinessMembership, updateBusinessTimezoneInTransaction } from "@lobbystack/domain";
import { businesses } from "@lobbystack/db";
import { asApiResponse, jsonError, readJson, withOperatorTransaction } from "@/lib/api-helpers";
import { runtimeDeploymentMode } from "@/lib/deployment-mode";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    return NextResponse.json(await withOperatorTransaction(request, async ({ session, businessId, tx }) => {
      const membership = await requireBusinessMembership(tx, { userId: session.user.id, businessId });
      const row = (await tx.select({ telemetryEnabled: businesses.telemetryEnabled, timezone: businesses.timezone }).from(businesses).where(eq(businesses.id, businessId)).limit(1))[0];
      if (!row) throw jsonError("Business not found.", 404);
      // Browser telemetry stamps this on every event once the workspace opts in.
      return { ...row, canManageTenant: hasMinimumRole(membership.role, "business_admin"), deploymentMode: runtimeDeploymentMode() };
    }));
  } catch (error) { return asApiResponse(error); }
}

export async function PATCH(request: Request) {
  try {
    return NextResponse.json(await withOperatorTransaction(request, async ({ businessId, tx }) => {
      const body = await readJson(request) as { telemetryEnabled?: unknown; timezone?: unknown } | null;
      if (!body || (body.telemetryEnabled === undefined && body.timezone === undefined)) throw jsonError("Send telemetryEnabled or timezone.");
      if (body.telemetryEnabled !== undefined && typeof body.telemetryEnabled !== "boolean") throw jsonError("telemetryEnabled must be a boolean.");
      if (body.timezone !== undefined && typeof body.timezone !== "string") throw jsonError("timezone must be a string.");
      const saved: { telemetryEnabled?: boolean; timezone?: string } = {};
      if (body.telemetryEnabled !== undefined) {
        await tx.update(businesses).set({ telemetryEnabled: body.telemetryEnabled, updatedAt: new Date() }).where(eq(businesses.id, businessId));
        saved.telemetryEnabled = body.telemetryEnabled;
      }
      if (body.timezone !== undefined) saved.timezone = await updateBusinessTimezoneInTransaction(tx, { businessId, timezone: body.timezone });
      return saved;
    }, { minimumRole: "business_admin" }));
  } catch (error) { return asApiResponse(error); }
}
