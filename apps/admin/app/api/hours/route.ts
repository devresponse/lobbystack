import { and, asc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { businesses, businessHours, receptionistProfiles, type DatabaseTransaction } from "@lobbystack/db";
import { replaceBusinessHoursInTransaction } from "@lobbystack/domain";
import { normalizeBookingMode } from "@lobbystack/shared";
import { asApiResponse, withOperatorTransaction } from "@/lib/api-helpers";
import { jsonError, parseBody } from "@/lib/request-input";

export const dynamic = "force-dynamic";

// The weekly opening hours editor. hoursSource says who set them: nobody yet,
// AI from the knowledge sources, or a person. Saving here makes them the
// operator's, so AI never replaces them.

async function loadHours(tx: DatabaseTransaction, businessId: string) {
  const business = await tx.select({ timezone: businesses.timezone, hoursSource: businesses.hoursSource }).from(businesses).where(eq(businesses.id, businessId)).limit(1);
  const hours = await tx.select({ dayOfWeek: businessHours.dayOfWeek, openMinutes: businessHours.openMinutes, closeMinutes: businessHours.closeMinutes }).from(businessHours).where(eq(businessHours.businessId, businessId)).orderBy(asc(businessHours.dayOfWeek), asc(businessHours.openMinutes));
  // The default receptionist's booking mode, which the hours page explains.
  const profile = await tx.select({ bookingMode: receptionistProfiles.bookingMode }).from(receptionistProfiles).where(and(eq(receptionistProfiles.businessId, businessId), eq(receptionistProfiles.isDefault, true))).limit(1);
  if (!business[0]) throw jsonError("Business not found.", 404);
  return { timezone: business[0].timezone, hoursSource: business[0].hoursSource, bookingMode: normalizeBookingMode(profile[0]?.bookingMode), hours };
}

// A window is a day and the minutes from midnight it opens and closes, so a day can have several.
const openingWindow = z.object({
  dayOfWeek: z.number("Each opening window needs dayOfWeek, openMinutes and closeMinutes.").int("dayOfWeek is a whole number, 0 for Sunday to 6 for Saturday.").min(0, "dayOfWeek is 0 for Sunday to 6 for Saturday.").max(6, "dayOfWeek is 0 for Sunday to 6 for Saturday."),
  openMinutes: z.number("Each opening window needs dayOfWeek, openMinutes and closeMinutes.").int("openMinutes is a whole number of minutes from midnight.").min(0, "openMinutes is between 0 and 1440.").max(1_440, "openMinutes is between 0 and 1440."),
  closeMinutes: z.number("Each opening window needs dayOfWeek, openMinutes and closeMinutes.").int("closeMinutes is a whole number of minutes from midnight.").min(0, "closeMinutes is between 0 and 1440.").max(1_440, "closeMinutes is between 0 and 1440."),
});
const weeklyHours = z.object({ hours: z.array(openingWindow, "hours must be a list of up to 28 opening windows.").max(28, "hours must be a list of up to 28 opening windows.") });

export async function GET(request: Request) {
  try {
    return NextResponse.json(await withOperatorTransaction(request, async ({ businessId, tx }) => await loadHours(tx, businessId)));
  } catch (error) {
    return asApiResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    return NextResponse.json(await withOperatorTransaction(request, async ({ businessId, tx }) => {
      const { hours } = await parseBody(request, weeklyHours);
      try {
        await replaceBusinessHoursInTransaction(tx, { businessId, hours });
      } catch (error) {
        throw jsonError(error instanceof Error ? error.message : "The opening hours are invalid.");
      }
      return await loadHours(tx, businessId);
    }, { minimumRole: "business_admin" }));
  } catch (error) {
    return asApiResponse(error);
  }
}
