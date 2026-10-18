import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { readReceptionistSettingsChange, saveReceptionistProfileInTransaction, updateBusinessInTransaction } from "@lobbystack/domain";
import { businesses, receptionistProfiles } from "@lobbystack/db";
import { asApiResponse, jsonError, readJson, withOperatorTransaction } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    return NextResponse.json(await withOperatorTransaction(request, async ({ businessId, tx }) => {
      const business = await tx.select({ id: businesses.id, name: businesses.name, timezone: businesses.timezone, defaultLocale: businesses.defaultLocale }).from(businesses).where(eq(businesses.id, businessId)).limit(1);
      const profile = await tx.select().from(receptionistProfiles).where(eq(receptionistProfiles.businessId, businessId)).limit(1);
      return { business: business[0] ?? null, profile: profile[0] ?? null };
    }));
  } catch (error) {
    return asApiResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    return NextResponse.json(await withOperatorTransaction(request, async ({ businessId, tx }) => {
      // The field rules live in the domain, which the v1 API shares.
      const { patch, locale, timezone, regenerateSummary } = readReceptionistSettingsChange(await readJson(request));

      const business = (await tx.select({ name: businesses.name }).from(businesses).where(eq(businesses.id, businessId)).limit(1))[0];
      if (!business) throw jsonError("Business not found.", 404);

      // Opening hours keep their clock times in a new zone; booked appointments keep theirs.
      if (locale !== undefined || timezone !== undefined) {
        await updateBusinessInTransaction(tx, { businessId, ...(locale !== undefined ? { defaultLocale: locale } : {}), ...(timezone !== undefined ? { timezone } : {}) });
      }

      const profile = await saveReceptionistProfileInTransaction(tx, { businessId, businessName: business.name, patch, regenerateSummary });
      if (!profile) throw jsonError("Receptionist profile could not be saved.", 500);
      return { profile };
    }, { minimumRole: "business_admin" }));
  } catch (error) {
    return asApiResponse(error);
  }
}
