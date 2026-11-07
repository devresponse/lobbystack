import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { loadReceptionistView, readReceptionistSettingsChange, saveReceptionistProfileInTransaction, updateBusinessInTransaction, updateReceptionistInTransaction } from "@lobbystack/domain";
import { businesses } from "@lobbystack/db";
import { asApiResponse, jsonError, readJson, withOperatorTransaction } from "@/lib/api-helpers";
import { receptionistIdFromRequest } from "@/lib/receptionist-filter";

export const dynamic = "force-dynamic";

// AI settings. ?receptionist=<id> picks which receptionist's own settings the
// page shows and saves, the default one without it; the shared settings (the
// summary, the AI notice and the appointment change rules) and the timezone
// are the business's. The language is the receptionist's own, except the
// default receptionist's, which is the business's.

export async function GET(request: Request) {
  try {
    const receptionistId = receptionistIdFromRequest(request);
    return NextResponse.json(await withOperatorTransaction(request, async ({ businessId, tx }) => {
      const business = await tx.select({ id: businesses.id, name: businesses.name, timezone: businesses.timezone, defaultLocale: businesses.defaultLocale }).from(businesses).where(eq(businesses.id, businessId)).limit(1);
      const profile = await loadReceptionistView(tx, { businessId, receptionistId });
      if (receptionistId && !profile) throw jsonError("Receptionist not found.", 404);
      // The dropdown lists the receptionists from /api/receptionists/choices, as every other one does.
      return { business: business[0] ?? null, profile };
    }));
  } catch (error) {
    return asApiResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const receptionistId = receptionistIdFromRequest(request);
    return NextResponse.json(await withOperatorTransaction(request, async ({ session, businessId, tx }) => {
      // The field rules live in the domain, which the v1 API shares.
      const { patch, locale, timezone, regenerateSummary } = readReceptionistSettingsChange(await readJson(request));

      const business = (await tx.select({ id: businesses.id }).from(businesses).where(eq(businesses.id, businessId)).limit(1))[0];
      if (!business) throw jsonError("Business not found.", 404);

      const speaker = locale !== undefined ? await loadReceptionistView(tx, { businessId, receptionistId }) : null;
      if (locale !== undefined && !speaker) throw jsonError("Receptionist not found.", 404);
      // The business always has a language, which the default receptionist speaks.
      if (locale === null && speaker?.isDefault) throw jsonError("The default receptionist speaks the business's language, so choose one.", 400, "invalid_locale");
      const businessLocale = speaker?.isDefault && locale ? locale : undefined;

      // Opening hours keep their clock times in a new zone; booked appointments keep theirs.
      if (businessLocale !== undefined || timezone !== undefined) {
        await updateBusinessInTransaction(tx, { businessId, ...(businessLocale !== undefined ? { defaultLocale: businessLocale } : {}), ...(timezone !== undefined ? { timezone } : {}), audit: { actorUserId: session.user.id } });
      }
      if (speaker && locale !== undefined) {
        // Another receptionist keeps a language of its own. The default one
        // speaks the business's, so one it brought along when it became the
        // default gives way.
        const own = speaker.isDefault ? null : locale;
        if ((speaker.locale ?? null) !== own) await updateReceptionistInTransaction(tx, { businessId, actorUserId: session.user.id, receptionistId: speaker.id, patch: { locale: own } });
      }

      const profile = await saveReceptionistProfileInTransaction(tx, { businessId, receptionistId, patch, regenerateSummary });
      if (!profile) throw jsonError("Receptionist profile could not be saved.", 500);
      return { profile };
    }, { minimumRole: "business_admin" }));
  } catch (error) {
    return asApiResponse(error);
  }
}
