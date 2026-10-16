import { NextResponse } from "next/server";

import { getBusinessPublicProfileSettings, hasMinimumRole, requireBusinessMembership, updateBusinessPublicProfile, type PublicProfileSettingsView } from "@lobbystack/domain";
import { publicProfileSettingsSchema } from "@lobbystack/shared";

import { asApiResponse, readJson, withOperatorTransaction } from "@/lib/api-helpers";
import { publicProfileUrl } from "@/lib/public-profile-page";

export const dynamic = "force-dynamic";

// The business's public page at /profile/<slug>: every member can read its
// settings, and owners and admins change and publish it.

function withUrl(view: PublicProfileSettingsView, canEdit: boolean) {
  return { ...view, url: publicProfileUrl(view.slug), canEdit };
}

export async function GET(request: Request) {
  try {
    return NextResponse.json(await withOperatorTransaction(request, async ({ session, businessId, tx }) => {
      const membership = await requireBusinessMembership(tx, { userId: session.user.id, businessId });
      return withUrl(await getBusinessPublicProfileSettings(tx, { businessId }), hasMinimumRole(membership.role, "business_admin"));
    }));
  } catch (error) { return asApiResponse(error); }
}

export async function PUT(request: Request) {
  try {
    return NextResponse.json(await withOperatorTransaction(request, async ({ session, businessId, tx }) => {
      const parsed = publicProfileSettingsSchema.safeParse(await readJson(request));
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw NextResponse.json({ error: issue?.message ?? "The page settings are invalid.", code: "public_profile_invalid", field: issue?.path.join(".") ?? null }, { status: 400 });
      }
      return withUrl(await updateBusinessPublicProfile(tx, { businessId, userId: session.user.id, settings: parsed.data }), true);
    }, { minimumRole: "business_admin" }));
  } catch (error) { return asApiResponse(error); }
}
