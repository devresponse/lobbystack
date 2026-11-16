import { eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { businessInvitations, users } from "@lobbystack/db";
import { inviteMember, removeMember, revokeInvitation, updateMemberRole } from "@lobbystack/domain";
import { normalizeInterfaceLocale } from "@lobbystack/shared";
import { asApiResponse, businessIdFromRequest, requireApiSession, withOperatorTransaction } from "@/lib/api-helpers";
import { jsonError, parseBody } from "@/lib/request-input";
import { getAuthDatabase } from "@/lib/auth";
import { createDomainContext } from "@/lib/domain-context";
import { enforceFixedWindow, fixedWindowLimit } from "@/lib/fixed-window-limit";

export const dynamic = "force-dynamic";

const roles = ["business_admin", "scheduler", "viewer"] as const;

const roleField = z.enum(roles, "role is business_admin, scheduler or viewer.");
const businessField = z.string().trim().min(1).optional();

const memberRoleUpdate = z.object({ businessId: businessField, membershipId: z.string("membershipId is required.").trim().min(1, "membershipId is required."), role: roleField });
const memberRemoval = z.object({ businessId: businessField, membershipId: z.string().trim().min(1).optional(), invitationId: z.string().trim().min(1).optional() })
  .refine((body) => Boolean(body.membershipId ?? body.invitationId), { error: "Name the membershipId to remove, or the invitationId to revoke.", path: ["membershipId"] });
const invitation = z.object({ businessId: businessField, email: z.email("Give the person's email address."), role: roleField });

export async function GET(request: Request) {
  try {
    return NextResponse.json(await withOperatorTransaction(request, async ({ businessId, tx }) => {
      // RLS hides other users' rows from the app role, so read members through this function.
      const members = await tx.execute<{ joinedAt: string }>(sql`select membership_id as "membershipId", user_id as "userId", name, email, role, status, joined_at as "joinedAt" from app.list_business_members(${businessId}::uuid)`);
      const invitations = await tx.select({ invitationId: businessInvitations.id, email: businessInvitations.email, role: businessInvitations.role, status: businessInvitations.status, transfersOwnership: businessInvitations.transfersOwnership, expiresAt: businessInvitations.expiresAt, invitedAt: businessInvitations.createdAt }).from(businessInvitations).where(eq(businessInvitations.businessId, businessId));
      // Raw queries return Postgres timestamp text, which Safari's Date can't parse; send ISO like invitedAt.
      return { members: members.rows.map((member) => ({ ...member, joinedAt: new Date(member.joinedAt).toISOString() })), invitations };
    }));
  } catch (error) {
    return asApiResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const session = await requireApiSession(request);
    const body = await parseBody(request, memberRoleUpdate);
    const businessId = body.businessId ?? businessIdFromRequest(request);
    if (!businessId) return jsonError("A businessId is required.", 400, "business_required");
    await updateMemberRole(createDomainContext(), { userId: session.user.id, businessId, membershipId: body.membershipId, role: body.role });
    return NextResponse.json({ ok: true });
  } catch (error) { return asApiResponse(error); }
}

export async function DELETE(request: Request) {
  try {
    const session = await requireApiSession(request);
    const body = await parseBody(request, memberRemoval);
    const businessId = body.businessId ?? businessIdFromRequest(request);
    if (!businessId) return jsonError("A businessId is required.", 400, "business_required");
    if (body.membershipId) await removeMember(createDomainContext(), { userId: session.user.id, businessId, membershipId: body.membershipId });
    else await revokeInvitation(createDomainContext(), { userId: session.user.id, businessId, invitationId: body.invitationId! });
    return NextResponse.json({ ok: true });
  } catch (error) { return asApiResponse(error); }
}

export async function POST(request: Request) {
  try {
    const session = await requireApiSession(request);
    const input = await parseBody(request, invitation);
    const businessId = input.businessId ?? businessIdFromRequest(request);
    if (!businessId) throw jsonError("A businessId is required.", 400, "business_required");
    // Each invite sends an email, so cap how many one account can send.
    const limit = await enforceFixedWindow([fixedWindowLimit("team-invite", "user-hour", session.user.id, 20, 60 * 60, "rate_limit_user_hour")]);
    if (!limit.allowed) return jsonError(limit.status === 429 ? "Too many invitations. Try again later." : "Invitation abuse protection is unavailable.", limit.status);
    // The email goes out in the inviter's dashboard language, which only the auth role can read.
    const [inviter] = await getAuthDatabase().db.select({ locale: users.preferredLocale }).from(users).where(eq(users.id, session.user.id)).limit(1);
    const locale = normalizeInterfaceLocale(inviter?.locale) ?? undefined;
    return NextResponse.json(await inviteMember(createDomainContext(), { userId: session.user.id, businessId, email: input.email, role: input.role, locale }), { status: 201 });
  } catch (error) {
    return asApiResponse(error);
  }
}
