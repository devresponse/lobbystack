import { NextResponse } from "next/server";

import { attributeBusiness, createBusiness, deleteBusiness, ianaTimeZone, listUserBusinesses, updateBusiness, type BusinessDeletion } from "@lobbystack/domain";
import { logEvent } from "@lobbystack/telemetry/node";
import { asApiResponse, businessIdFromRequest, getAppDatabase, jsonError, readJson, requireApiSession, requireOperatorBusiness } from "@/lib/api-helpers";
import { createDomainContext } from "@/lib/domain-context";
import { enforceFixedWindow, fixedWindowLimit } from "@/lib/fixed-window-limit";
import { passwordMatches } from "@/lib/password-check";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const session = await requireApiSession(request);
    return NextResponse.json({ businesses: await listUserBusinesses(getAppDatabase().db, session.user.id) });
  } catch (error) {
    return asApiResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireApiSession(request);
    const body = await readJson(request) as { name?: string; slug?: string; timezone?: string; businessType?: string; referralCode?: unknown };
    if (!body.name || !body.timezone || !body.businessType) {
      return jsonError("name, timezone, and businessType are required.", 400);
    }
    if (body.slug !== undefined && (typeof body.slug !== "string" || !body.slug.trim())) {
      return jsonError("slug must be a nonempty string when supplied.", 400);
    }
    const context = createDomainContext();
    // The browser names the zone and the server's time zone data may not know it; owners can change it in AI settings.
    const created = await createBusiness(context, { userId: session.user.id, name: body.name, ...(body.slug !== undefined ? { slug: body.slug } : {}), timezone: ianaTimeZone(body.timezone) ?? "UTC", businessType: body.businessType });
    // Attribute at creation, before the plan step can take a payment, so the
    // referrer earns commission on the first order too.
    if (typeof body.referralCode === "string" && body.referralCode) {
      await attributeBusiness(context, { businessId: created.businessId, referredUserId: session.user.id, referralCode: body.referralCode, source: "referral_link" });
    }
    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    return asApiResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const { session, businessId } = await requireOperatorBusiness(request);
    const body = await readJson(request) as { name?: string; timezone?: string; businessType?: string; defaultLocale?: string; websiteUrl?: string | null };
    await updateBusiness(createDomainContext(), { ...body, userId: session.user.id, businessId });
    return NextResponse.json({ ok: true });
  } catch (error) { return asApiResponse(error); }
}

/** How long a delete waits for the worker to end the business's paid plan, asking every 2 seconds, before answering plan_ending. */
const PLAN_END_WAIT_MS = 20_000;
const PLAN_END_POLL_MS = 2_000;

/**
 * Deletes a business and all its data for good, for one of its owners
 * (deleteBusiness says who may and what goes). The request names the business
 * in its query, never by the active one, and confirms with its typed name and
 * the person's password. 10 tries an hour per person.
 */
export async function DELETE(request: Request) {
  try {
    const session = await requireApiSession(request);
    const businessId = businessIdFromRequest(request);
    if (!businessId) return jsonError("A businessId is required.", 400, "business_required");
    const body = await readJson(request) as { confirmName?: unknown; password?: unknown } | null;
    if (typeof body?.confirmName !== "string" || !body.confirmName.trim()) return jsonError("Type the business's name to confirm.", 400, "confirmation_required");
    if (typeof body.password !== "string" || !body.password) return jsonError("Enter your password to confirm.", 400, "password_required");
    const limit = await enforceFixedWindow([fixedWindowLimit("business-delete", "user-hour", session.user.id, 10, 60 * 60, "rate_limit_user_hour")]);
    if (!limit.allowed) {
      return limit.status === 503
        ? NextResponse.json({ error: "Deleting a business is unavailable for a moment. Try again shortly.", code: "rate_limit_unavailable" }, { status: 503, headers: { "Retry-After": "5" } })
        : NextResponse.json({ error: "Too many tries. Try again later.", code: "rate_limited" }, { status: 429, headers: { "Retry-After": String(3_600 - (Math.floor(Date.now() / 1_000) % 3_600)) } });
    }
    if (!await passwordMatches(request, body.password)) return jsonError("That password isn't right.", 400, "invalid_password");
    const deleted = await deleteOncePlanEnds({ userId: session.user.id, businessId, confirmName: body.confirmName });
    // The business is gone, and so is its audit log, so this line is what's left of who deleted it.
    logEvent("info", "business.deleted", { businessId, userId: session.user.id, releasedNumbers: deleted.releasedNumbers, storedFiles: deleted.storedFiles });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return asApiResponse(error);
  }
}

/** Asks again while the worker ends the business's paid plan, which takes a few seconds, so most deletes answer once. */
async function deleteOncePlanEnds(input: { userId: string; businessId: string; confirmName: string }): Promise<BusinessDeletion> {
  const deadline = Date.now() + PLAN_END_WAIT_MS;
  for (;;) {
    try {
      return await deleteBusiness(createDomainContext(), input);
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code !== "plan_ending" || Date.now() + PLAN_END_POLL_MS > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, PLAN_END_POLL_MS));
    }
  }
}
