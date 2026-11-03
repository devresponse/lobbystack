import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { listReceptionistChoicesInTransaction, loadReceptionistView, readReceptionistSettingsChange, saveReceptionistProfileInTransaction, updateBusinessInTransaction } from "@lobbystack/domain";
import { businesses } from "@lobbystack/db";
import { asApiResponse, jsonError, readJson, withOperatorTransaction } from "@/lib/api-helpers";
import { receptionistIdFromRequest } from "@/lib/receptionist-filter";

export const dynamic = "force-dynamic";

// AI settings. ?receptionist=<id> picks which receptionist's own settings the
// page shows and saves, the default one without it; the shared settings (the
// summary, the AI notice and the appointment change rules) are the business's.

export async function GET(request: Request) {
  try {
    const receptionistId = receptionistIdFromRequest(request);
    return NextResponse.json(await withOperatorTransaction(request, async ({ businessId, tx }) => {
      const business = await tx.select({ id: businesses.id, name: businesses.name, timezone: businesses.timezone, defaultLocale: businesses.defaultLocale }).from(businesses).where(eq(businesses.id, businessId)).limit(1);
      const profile = await loadReceptionistView(tx, { businessId, receptionistId });
      if (receptionistId && !profile) throw jsonError("Receptionist not found.", 404);
      const receptionists = await listReceptionistChoicesInTransaction(tx, { businessId });
      return { business: business[0] ?? null, profile, receptionists };
    }));
  } catch (error) {
    return asApiResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const receptionistId = receptionistIdFromRequest(request);
    return NextResponse.json(await withOperatorTransaction(request, async ({ businessId, tx }) => {
      // The field rules live in the domain, which the v1 API shares.
      const { patch, locale, timezone, regenerateSummary } = readReceptionistSettingsChange(await readJson(request));

      const business = (await tx.select({ name: businesses.name }).from(businesses).where(eq(businesses.id, businessId)).limit(1))[0];
      if (!business) throw jsonError("Business not found.", 404);

      // Opening hours keep their clock times in a new zone; booked appointments keep theirs.
      if (locale !== undefined || timezone !== undefined) {
        await updateBusinessInTransaction(tx, { businessId, ...(locale !== undefined ? { defaultLocale: locale } : {}), ...(timezone !== undefined ? { timezone } : {}) });
      }

      const profile = await saveReceptionistProfileInTransaction(tx, { businessId, businessName: business.name, receptionistId, patch, regenerateSummary });
      if (!profile) throw jsonError("Receptionist profile could not be saved.", 500);
      return { profile };
    }, { minimumRole: "business_admin" }));
  } catch (error) {
    return asApiResponse(error);
  }
}
