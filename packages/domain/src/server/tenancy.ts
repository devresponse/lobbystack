import { createHash, randomBytes, randomUUID } from "node:crypto";

import { and, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";

import { enqueueOutbox, withBusinessTransaction, type Database, type DatabaseTransaction } from "@lobbystack/db";
import { apiKeys, auditLogs, businessInvitations, businessMemberships, businesses, calendarConnections, receptionistProfiles, staff, users, webhookEndpoints } from "@lobbystack/db";
import { defaultAppointmentChangePolicy, normalizeAuthEmail, parseDeploymentMode, type InterfaceLocale } from "@lobbystack/shared";

import { requireBusinessAdmin, requireBusinessMembership } from "../authz";
import { disconnectCalendarInTransaction } from "./calendar";
import type { DomainContext } from "./context";

export type BusinessRole = "business_owner" | "business_admin" | "scheduler" | "viewer";

export type CreateBusinessInput = {
  userId: string;
  name: string;
  slug?: string;
  timezone: string;
  businessType: string;
  deploymentMode?: string;
};

function cleanSlug(slug: string): string {
  const result = slug.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (result.length < 2 || result.length > 120) {
    throw Object.assign(new Error("Business slug must be between 2 and 120 characters."), { status: 400 });
  }
  return result;
}

// Each business adds recurring worker jobs, so one account cannot create them without bound.
const maxOwnedBusinesses = 10;

/**
 * The IANA time zone a value names, spelled the way Intl lists it, such as
 * America/Vancouver for " america/vancouver", or undefined when it names none.
 * UTC offsets such as +05:00 don't name a zone.
 */
export function ianaTimeZone(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const zone = value.trim();
  if (zone.length > 80 || !/^[A-Za-z][\w+-]*(?:\/[\w+-]+)*$/.test(zone)) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
  } catch {
    return undefined;
  }
  // Intl accepts any letter case. resolvedOptions() would also swap in legacy names such as Asia/Calcutta, so only the case is fixed.
  return Intl.supportedValuesOf("timeZone").find((known) => known.toLowerCase() === zone.toLowerCase()) ?? zone;
}

function requireIanaTimeZone(value: unknown): string {
  const zone = ianaTimeZone(value);
  if (!zone) throw Object.assign(new Error("timezone must be an IANA time zone, such as America/Toronto."), { status: 400, code: "invalid_timezone" });
  return zone;
}

export async function createBusiness(
  context: DomainContext,
  input: CreateBusinessInput,
): Promise<{ businessId: string; membershipId: string }> {
  const timezone = requireIanaTimeZone(input.timezone);
  // Refuse a bad slug before taking any locks.
  if (input.slug !== undefined) cleanSlug(input.slug);
  const businessId = randomUUID();
  return await withBusinessTransaction(context.db, {
    userId: input.userId,
    businessId,
    actorType: "system",
  }, async (tx) => {
    // Lock the user row so concurrent creates by the same account count each other.
    await tx.select({ id: users.id }).from(users).where(eq(users.id, input.userId)).for("update");
    const owned = await tx.execute<{ count: number }>(sql`select count(*)::int as count from app.list_user_businesses(${input.userId}) where role = 'business_owner'`);
    if ((owned.rows[0]?.count ?? 0) >= maxOwnedBusinesses) {
      throw Object.assign(new Error(`Too many workspaces. One account can own up to ${maxOwnedBusinesses}.`), { status: 403 });
    }
    const created = await insertBusinessInTransaction(tx, { businessId, userId: input.userId, name: input.name, slug: input.slug, timezone, businessType: input.businessType, deploymentMode: input.deploymentMode });
    await tx.update(users).set({ activeBusinessId: businessId, updatedAt: new Date() }).where(eq(users.id, input.userId));
    return created;
  });
}

/**
 * Inserts a business with what every new business needs: its owner, the staff
 * member that stands for it, a receptionist profile, and its first snapshot.
 * The transaction must be scoped to businessId, and timezone must already be
 * an IANA name. A generated slug gets a random suffix when taken; a taken slug
 * the caller chose fails with a unique violation.
 */
export async function insertBusinessInTransaction(
  tx: DatabaseTransaction,
  input: { businessId: string; userId: string; name: string; slug?: string | undefined; timezone: string; businessType: string; deploymentMode?: string | undefined; defaultLocale?: string | undefined; websiteUrl?: string | undefined },
): Promise<{ businessId: string; membershipId: string }> {
  const { businessId, timezone } = input;
  const name = input.name.trim();
  const generatedSlug = name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 96).replace(/-$/, "") || "business";
  const baseSlug = input.slug === undefined ? generatedSlug : cleanSlug(input.slug);
  let business: { id: string } | undefined;
  for (let attempt = 0; attempt < 5; attempt++) {
    const insert = tx.insert(businesses).values({
      id: businessId,
      name,
      slug: attempt === 0 ? baseSlug : `${baseSlug}-${randomBytes(6).toString("hex")}`,
      timezone,
      businessType: input.businessType,
      // A self-hosted server's businesses get its unlimited plan, not the cloud's free one. Any other mode, development included, keeps them cloud, as before:
      // every mode but cloud skips billing and the paid-plan check on numbers.
      deploymentMode: input.deploymentMode ?? (parseDeploymentMode(process.env.DEPLOYMENT_MODE) === "self_hosted_standard" ? "self_hosted_standard" : "cloud"),
      onboardingStage: "website",
      ...(input.defaultLocale !== undefined ? { defaultLocale: input.defaultLocale } : {}),
      ...(input.websiteUrl !== undefined ? { websiteUrl: input.websiteUrl } : {}),
    });
    // Only generated slugs are replaceable. Target this constraint explicitly
    // so unrelated insert failures still roll back the transaction.
    [business] = await (input.slug === undefined ? insert.onConflictDoNothing({ target: businesses.slug }) : insert).returning({ id: businesses.id });
    if (business) break;
  }
  if (!business) {
    throw new Error("Business could not be created.");
  }
  const [membership] = await tx.insert(businessMemberships).values({
    businessId,
    userId: input.userId,
    role: "business_owner",
    status: "active",
  }).returning({ id: businessMemberships.id });
  if (!membership) {
    throw new Error("Business owner membership could not be created.");
  }
  // Booking assigns every appointment to a staff member. Businesses that don't
  // manage a team get one hidden member that stands for the business itself.
  await tx.insert(staff).values({ businessId, name, timezone });
  await tx.insert(receptionistProfiles).values({
    businessId,
    greeting: `Thanks for calling ${name}.`,
    tone: "warm and direct",
    // The business name, like defaultReceptionistProfile; summarySource marks it as the placeholder.
    summary: name,
    bookingPolicy: "Only confirm a booking after availability is checked.",
    voiceInstructions: "Sound calm, confident, and concise. Escalate urgent requests to a human when policy requires it.",
    smsInstructions: "Keep replies concise and friendly. Ask one follow-up question at a time.",
    transferMode: "on_request",
    appointmentChangePolicy: defaultAppointmentChangePolicy,
  });
  await enqueueOutbox(tx, {
    topic: "snapshot.refresh",
    businessId,
    aggregateType: "business",
    aggregateId: businessId,
    dedupeKey: `business:${businessId}:snapshot:initial`,
    payload: { businessId, reason: "business_created" },
  });
  return { businessId, membershipId: membership.id };
}

export async function listUserBusinesses(
  db: Database,
  userId: string,
): Promise<Array<{ businessId: string; name: string; slug: string; role: string; active: boolean; timezone: string; businessType: string; defaultLocale: string; websiteUrl: string | null; onboardingStage: string; createdAt: string }>> {
  return await withBusinessTransaction(db, { userId, actorType: "operator" }, async (tx) => {
    const [user] = await tx.select({ activeBusinessId: users.activeBusinessId }).from(users).where(eq(users.id, userId)).limit(1);
    const rows = await tx.execute<{ businessId: string; name: string; slug: string; role: string; timezone: string; businessType: string; defaultLocale: string; websiteUrl: string | null; onboardingStage: string; createdAt: Date }>(sql`select business_id as "businessId", name, slug, role, timezone, business_type as "businessType", default_locale as "defaultLocale", website_url as "websiteUrl", onboarding_stage as "onboardingStage", created_at as "createdAt" from app.list_user_businesses(${userId})`);
    return rows.rows.map((row) => ({ ...row, active: row.businessId === user?.activeBusinessId, createdAt: new Date(row.createdAt).toISOString() }));
  });
}

export async function updateBusiness(
  context: DomainContext,
  input: { userId: string; businessId: string; name?: string; timezone?: string; businessType?: string; defaultLocale?: string; websiteUrl?: string | null },
): Promise<void> {
  await withBusinessTransaction(context.db, { ...input, actorType: "operator" }, async (tx) => {
    await requireBusinessAdmin(tx, input);
    await updateBusinessInTransaction(tx, input);
  });
}

/** Updates basic business fields and refreshes the receptionist's snapshot. Callers authorize first. */
export async function updateBusinessInTransaction(
  tx: DatabaseTransaction,
  input: { businessId: string; name?: string; timezone?: string; businessType?: string; defaultLocale?: string; websiteUrl?: string | null },
): Promise<void> {
  const timezone = input.timezone === undefined ? undefined : requireIanaTimeZone(input.timezone);
  const values = { ...(input.name !== undefined ? { name: input.name.trim() } : {}), ...(timezone !== undefined ? { timezone } : {}), ...(input.businessType !== undefined ? { businessType: input.businessType.trim() } : {}), ...(input.defaultLocale !== undefined ? { defaultLocale: input.defaultLocale.trim() } : {}), ...(input.websiteUrl !== undefined ? { websiteUrl: input.websiteUrl } : {}), updatedAt: new Date() };
  if (Object.keys(values).length === 1) throw new Error("At least one business field is required.");
  const [business] = await tx.update(businesses).set(values).where(eq(businesses.id, input.businessId)).returning({ id: businesses.id });
  if (!business) throw new Error("Business not found.");
  // shortcut: every staff row today is the default member that stands for the business; once staff set their own zones, update only that member.
  if (timezone !== undefined) await tx.update(staff).set({ timezone, updatedAt: new Date() }).where(eq(staff.businessId, input.businessId));
  await enqueueOutbox(tx, { topic: "snapshot.refresh", businessId: input.businessId, aggregateType: "business", aggregateId: input.businessId, dedupeKey: `business:${input.businessId}:snapshot:${Date.now()}`, payload: { businessId: input.businessId, reason: "business_updated" } });
}

export async function switchWorkspace(
  context: DomainContext,
  input: { userId: string; businessId: string },
): Promise<void> {
  await withBusinessTransaction(context.db, {
    userId: input.userId,
    businessId: input.businessId,
    actorType: "operator",
  }, async (tx) => {
    await requireBusinessMembership(tx, input);
    await tx.update(users).set({ activeBusinessId: input.businessId, updatedAt: new Date() }).where(eq(users.id, input.userId));
  });
}

/**
 * The lock every change to a business's team takes: role changes, removals,
 * accepting an invitation and sending a claim link. Taken first, it keeps the
 * last owner from being demoted twice at once without two transactions waiting
 * on each other's rows.
 */
export async function lockBusinessTeam(tx: DatabaseTransaction, businessId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('team:' || ${businessId}::uuid::text, 0))`);
}

/** Exactly one plain address: mail transports send a comma or semicolon list to every recipient. */
export function isSingleEmailAddress(normalizedEmail: string): boolean {
  return /^[^\s@,;:<>()"]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(normalizedEmail);
}

/** Where an invitation's email sends its recipient to accept it. */
export function invitationUrl(token: string): string {
  // Invitations may go to someone without an account preference. Let the
  // compatibility entry point negotiate their locale before redirecting.
  return `${process.env.APP_BASE_URL ?? "http://localhost"}/accept-invite?token=${encodeURIComponent(token)}`;
}

/**
 * Records an invitation the caller may send and queues its email. The email
 * must already be normalized and valid. It names the business and whoever sent
 * it, and is written in `locale`, or in English without one.
 */
export async function insertInvitationInTransaction(
  tx: DatabaseTransaction,
  input: { businessId: string; invitedByUserId: string; normalizedEmail: string; role: BusinessRole; transfersOwnership?: boolean; locale?: InterfaceLocale | undefined },
): Promise<{ invitationId: string; token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const invitationId = randomUUID();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await tx.insert(businessInvitations).values({
    id: invitationId,
    businessId: input.businessId,
    invitedByUserId: input.invitedByUserId,
    email: input.normalizedEmail,
    normalizedEmail: input.normalizedEmail,
    role: input.role,
    tokenHash,
    expiresAt,
    transfersOwnership: input.transfersOwnership ?? false,
  });
  const business = (await tx.select({ name: businesses.name }).from(businesses).where(eq(businesses.id, input.businessId)).limit(1))[0];
  const inviter = (await tx.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, input.invitedByUserId)).limit(1))[0];
  const url = invitationUrl(token);
  await enqueueOutbox(tx, {
    topic: "email.send",
    businessId: input.businessId,
    aggregateType: "business_invitation",
    aggregateId: invitationId,
    dedupeKey: `invitation:${invitationId}:send`,
    payload: {
      invitationId,
      email: input.normalizedEmail,
      token,
      template: "invitation",
      url,
      variables: {
        url,
        role: input.role,
        transfersOwnership: String(input.transfersOwnership ?? false),
        ...(input.locale ? { locale: input.locale } : {}),
        ...(business?.name ? { businessName: business.name } : {}),
        ...(inviter?.name ? { inviterName: inviter.name } : {}),
        ...(inviter?.email ? { inviterEmail: inviter.email } : {}),
      },
    },
  });
  return { invitationId, token, expiresAt };
}

/** `locale` is the inviter's dashboard language, which the email is written in. */
export async function inviteMember(
  context: DomainContext,
  input: { userId: string; businessId: string; email: string; role: BusinessRole; locale?: InterfaceLocale | undefined },
): Promise<{ invitationId: string; token: string }> {
  const normalizedEmail = normalizeAuthEmail(input.email);
  if (!isSingleEmailAddress(normalizedEmail)) {
    throw Object.assign(new Error("Enter one valid email address."), { status: 400 });
  }
  return await withBusinessTransaction(context.db, {
    userId: input.userId,
    businessId: input.businessId,
    actorType: "operator",
  }, async (tx) => {
    await requireBusinessAdmin(tx, { userId: input.userId, businessId: input.businessId });
    const { invitationId, token } = await insertInvitationInTransaction(tx, { businessId: input.businessId, invitedByUserId: input.userId, normalizedEmail, role: input.role, locale: input.locale });
    return { invitationId, token };
  });
}

/** What a handover turned off, so the dashboard can tell the new owner. */
export type HandoverTurnedOff = { webhookEndpoints: number; calendarConnections: number };

/**
 * Stops the business's data reaching whoever set it up: the webhook endpoints
 * the sender made in the dashboard or with their API keys, those any partner's
 * platform key made (the handover unlinks every partner), and the calendars
 * the sender connected. The new owner can turn the endpoints back on and
 * connect their own calendar.
 */
async function turnOffSenderConnections(tx: DatabaseTransaction, input: { businessId: string; senderUserId: string; ownerUserId: string }): Promise<HandoverTurnedOff> {
  const now = new Date();
  const senderKeys = tx.select({ id: apiKeys.id }).from(apiKeys).where(and(eq(apiKeys.businessId, input.businessId), eq(apiKeys.createdByUserId, input.senderUserId)));
  const endpoints = await tx.update(webhookEndpoints).set({ status: "disabled", disabledReason: "manual", disabledAt: now, updatedAt: now }).where(and(
    eq(webhookEndpoints.businessId, input.businessId),
    eq(webhookEndpoints.status, "enabled"),
    or(eq(webhookEndpoints.createdByUserId, input.senderUserId), inArray(webhookEndpoints.createdByApiKeyId, senderKeys), isNotNull(webhookEndpoints.createdByPlatformKeyId)),
  )).returning({ id: webhookEndpoints.id });
  const connections = await tx.select({ id: calendarConnections.id }).from(calendarConnections).where(and(eq(calendarConnections.businessId, input.businessId), eq(calendarConnections.ownerUserId, input.senderUserId), ne(calendarConnections.status, "disconnected")));
  const disconnected: { id: string; provider: string }[] = [];
  for (const { id } of connections) {
    const connection = await disconnectCalendarInTransaction(tx, { businessId: input.businessId, connectionId: id });
    if (connection) disconnected.push({ id, provider: connection.provider });
  }
  const audits = [
    ...endpoints.map(({ id }) => ({ businessId: input.businessId, actorUserId: input.ownerUserId, eventType: "webhook_endpoint.updated", entityType: "webhook_endpoint", entityId: id, payload: { actor: "system", reason: "handover", fields: ["status"] } })),
    ...disconnected.map(({ id, provider }) => ({ businessId: input.businessId, actorUserId: input.ownerUserId, eventType: "calendar_connection.disconnected", entityType: "calendar_connection", entityId: id, payload: { provider, reason: "handover" } })),
  ];
  if (audits.length) await tx.insert(auditLogs).values(audits);
  return { webhookEndpoints: endpoints.length, calendarConnections: disconnected.length };
}

export async function acceptInvitation(
  context: DomainContext,
  input: { userId: string; tokenHash: string; email: string | null | undefined; emailVerified: boolean | null | undefined },
): Promise<{ businessId: string; role: string; turnedOff?: HandoverTurnedOff }> {
  const resolved = await context.db.execute<{ business_id: string }>(sql`select app.resolve_business_by_invitation(${input.tokenHash}) as business_id`);
  const businessId = resolved.rows[0]?.business_id;
  if (!businessId) {
    throw new Error("Invitation is invalid or expired.");
  }
  return await withBusinessTransaction(context.db, { userId: input.userId, actorType: "system", businessId }, async (tx) => {
    await lockBusinessTeam(tx, businessId);
    const rows = await tx.select().from(businessInvitations).where(and(eq(businessInvitations.tokenHash, input.tokenHash), eq(businessInvitations.status, "pending"))).limit(1);
    const invitation = rows[0];
    if (!invitation || invitation.expiresAt <= new Date()) {
      throw new Error("Invitation is invalid or expired.");
    }
    // A forwarded or leaked link must not let a different account join.
    if (!input.emailVerified || !input.email || normalizeAuthEmail(input.email) !== invitation.normalizedEmail) {
      throw Object.assign(new Error("Sign in with the verified email address this invitation was sent to."), { status: 403 });
    }
    // Only an owner can hand the business over, and the sender may have stopped being one since.
    if (invitation.transfersOwnership && invitation.invitedByUserId !== input.userId) {
      const [sender] = await tx.select({ role: businessMemberships.role }).from(businessMemberships).where(and(eq(businessMemberships.businessId, invitation.businessId), eq(businessMemberships.userId, invitation.invitedByUserId), eq(businessMemberships.status, "active"))).limit(1);
      if (sender?.role !== "business_owner") throw Object.assign(new Error("This claim link no longer works. Ask whoever sent it for a new one."), { status: 409 });
    }
    // Claim the invitation before joining, so a second accept of the same token fails.
    const [claimed] = await tx.update(businessInvitations).set({ status: "accepted", acceptedByUserId: input.userId, acceptedAt: new Date(), updatedAt: new Date() }).where(and(eq(businessInvitations.id, invitation.id), eq(businessInvitations.status, "pending"))).returning({ id: businessInvitations.id });
    if (!claimed) {
      throw new Error("Invitation is invalid or expired.");
    }
    if (invitation.transfersOwnership) {
      // A claim link makes the claimant an owner even if they were already on the team.
      await tx.insert(businessMemberships).values({ businessId: invitation.businessId, userId: input.userId, role: "business_owner", status: "active" }).onConflictDoUpdate({
        target: [businessMemberships.businessId, businessMemberships.userId],
        set: { role: "business_owner", status: "active", updatedAt: new Date() },
      });
      // The business is theirs now, so the account that set it up loses its access:
      // its place on the team, the invitations it sent (it holds their links), its
      // API keys for the business, any partner's platform-key link to it, and the
      // webhooks and calendars that would keep sending it the business's data.
      let turnedOff: HandoverTurnedOff | undefined;
      if (invitation.invitedByUserId !== input.userId) {
        await tx.update(businessMemberships).set({ status: "removed", updatedAt: new Date() }).where(and(eq(businessMemberships.businessId, invitation.businessId), eq(businessMemberships.userId, invitation.invitedByUserId), eq(businessMemberships.status, "active")));
        await tx.update(businessInvitations).set({ status: "revoked", updatedAt: new Date() }).where(and(eq(businessInvitations.businessId, invitation.businessId), eq(businessInvitations.invitedByUserId, invitation.invitedByUserId), eq(businessInvitations.status, "pending")));
        turnedOff = await turnOffSenderConnections(tx, { businessId: invitation.businessId, senderUserId: invitation.invitedByUserId, ownerUserId: input.userId });
        await tx.update(apiKeys).set({ revokedAt: new Date(), revokedByUserId: input.userId, updatedAt: new Date() }).where(and(eq(apiKeys.businessId, invitation.businessId), eq(apiKeys.createdByUserId, invitation.invitedByUserId), isNull(apiKeys.revokedAt)));
        await tx.execute(sql`select app.finish_business_handover(${invitation.businessId}::uuid, ${invitation.invitedByUserId}::uuid)`);
      }
      // As with a claimed prospect demo, the dashboard opens on the business they now own.
      await tx.update(users).set({ activeBusinessId: invitation.businessId, updatedAt: new Date() }).where(eq(users.id, input.userId));
      return { businessId: invitation.businessId, role: "business_owner", ...(turnedOff ? { turnedOff } : {}) };
    }
    // An active member keeps their role, so an owner who accepts a viewer invite stays owner.
    const [joined] = await tx.insert(businessMemberships).values({
      businessId: invitation.businessId,
      userId: input.userId,
      role: invitation.role,
      status: "active",
    }).onConflictDoUpdate({
      target: [businessMemberships.businessId, businessMemberships.userId],
      set: { role: invitation.role, status: "active", updatedAt: new Date() },
      setWhere: ne(businessMemberships.status, "active"),
    }).returning({ role: businessMemberships.role });
    const role = joined?.role ?? (await tx.select({ role: businessMemberships.role }).from(businessMemberships).where(and(eq(businessMemberships.businessId, invitation.businessId), eq(businessMemberships.userId, input.userId))).limit(1))[0]!.role;
    return { businessId: invitation.businessId, role };
  });
}

export async function previewInvitation(
  context: DomainContext,
  input: { tokenHash: string },
): Promise<{ businessName: string; email: string; expired: boolean; status: string } | null> {
  const resolved = await context.db.execute<{ business_id: string }>(sql`select app.resolve_business_by_invitation(${input.tokenHash}) as business_id`);
  const businessId = resolved.rows[0]?.business_id;
  if (!businessId) return null;
  return await withBusinessTransaction(context.db, { actorType: "system", businessId }, async (tx) => {
    const rows = await tx.select({
      businessName: businesses.name,
      email: businessInvitations.email,
      expiresAt: businessInvitations.expiresAt,
      status: businessInvitations.status,
    }).from(businessInvitations).innerJoin(businesses, eq(businesses.id, businessInvitations.businessId)).where(and(eq(businessInvitations.tokenHash, input.tokenHash), eq(businessInvitations.businessId, businessId))).limit(1);
    const invitation = rows[0];
    return invitation ? { businessName: invitation.businessName, email: invitation.email, expired: invitation.expiresAt <= new Date(), status: invitation.status } : null;
  });
}

export type TeamChangeOutcome = "changed" | "not_found" | "final_owner";

/** Whether the active membership is the business's last active owner. The caller holds the team lock. */
async function isFinalOwner(tx: DatabaseTransaction, businessId: string, role: string): Promise<boolean> {
  if (role !== "business_owner") return false;
  const owners = await tx.select({ id: businessMemberships.id }).from(businessMemberships).where(and(eq(businessMemberships.businessId, businessId), eq(businessMemberships.role, "business_owner"), eq(businessMemberships.status, "active")));
  return owners.length <= 1;
}

/**
 * Revokes the API keys a member made for the business. Only owners and admins
 * make keys, and a key keeps every scope it was given, so a member who stops
 * being one, or leaves, keeps none of them.
 */
async function revokeMemberApiKeys(tx: DatabaseTransaction, input: { businessId: string; userId: string; revokedByUserId?: string | undefined }): Promise<void> {
  await tx.update(apiKeys).set({ revokedAt: new Date(), revokedByUserId: input.revokedByUserId ?? null, updatedAt: new Date() }).where(and(eq(apiKeys.businessId, input.businessId), eq(apiKeys.createdByUserId, input.userId), isNull(apiKeys.revokedAt)));
}

/** Changes an active member's role. A business always keeps an owner, and a member demoted below admin loses their API keys. */
export async function updateMemberRoleInTransaction(tx: DatabaseTransaction, input: { businessId: string; membershipId: string; role: Exclude<BusinessRole, "business_owner">; actorUserId?: string | undefined }): Promise<TeamChangeOutcome> {
  await lockBusinessTeam(tx, input.businessId);
  const membership = (await tx.select({ role: businessMemberships.role, userId: businessMemberships.userId }).from(businessMemberships).where(and(eq(businessMemberships.id, input.membershipId), eq(businessMemberships.businessId, input.businessId), eq(businessMemberships.status, "active"))).limit(1))[0];
  if (!membership) return "not_found";
  if (await isFinalOwner(tx, input.businessId, membership.role)) return "final_owner";
  await tx.update(businessMemberships).set({ role: input.role, updatedAt: new Date() }).where(and(eq(businessMemberships.id, input.membershipId), eq(businessMemberships.businessId, input.businessId), eq(businessMemberships.status, "active")));
  if (input.role !== "business_admin") await revokeMemberApiKeys(tx, { businessId: input.businessId, userId: membership.userId, revokedByUserId: input.actorUserId });
  return "changed";
}

/**
 * Takes an active member off the team, with the pending invitations they sent
 * (the inviter holds the link) or received, either of which would let them
 * back in, and the API keys they made. The app role can't read other people's
 * users rows, so the caller says how to find the member's email.
 */
export async function removeMemberInTransaction(tx: DatabaseTransaction, input: { businessId: string; membershipId: string; actorUserId?: string | undefined }, memberEmail: () => Promise<string | undefined>): Promise<TeamChangeOutcome> {
  await lockBusinessTeam(tx, input.businessId);
  const membership = (await tx.select({ role: businessMemberships.role, userId: businessMemberships.userId }).from(businessMemberships).where(and(eq(businessMemberships.id, input.membershipId), eq(businessMemberships.businessId, input.businessId), eq(businessMemberships.status, "active"))).limit(1))[0];
  if (!membership) return "not_found";
  if (await isFinalOwner(tx, input.businessId, membership.role)) return "final_owner";
  const email = await memberEmail();
  // Invitations and keys go first: a member removing themselves can't reach
  // the business's rows once their membership is gone.
  await tx.update(businessInvitations).set({ status: "revoked", updatedAt: new Date() }).where(and(eq(businessInvitations.businessId, input.businessId), eq(businessInvitations.status, "pending"), or(eq(businessInvitations.invitedByUserId, membership.userId), email ? eq(businessInvitations.normalizedEmail, normalizeAuthEmail(email)) : undefined)));
  await revokeMemberApiKeys(tx, { businessId: input.businessId, userId: membership.userId, revokedByUserId: input.actorUserId });
  await tx.update(businessMemberships).set({ status: "removed", updatedAt: new Date() }).where(and(eq(businessMemberships.id, input.membershipId), eq(businessMemberships.businessId, input.businessId), eq(businessMemberships.status, "active")));
  return "changed";
}

/** Revokes a pending invitation. False when the business has no such pending invitation. */
export async function revokeInvitationInTransaction(tx: DatabaseTransaction, input: { businessId: string; invitationId: string }): Promise<boolean> {
  const changed = await tx.update(businessInvitations).set({ status: "revoked", updatedAt: new Date() }).where(and(eq(businessInvitations.id, input.invitationId), eq(businessInvitations.businessId, input.businessId), eq(businessInvitations.status, "pending"))).returning({ id: businessInvitations.id });
  return changed.length > 0;
}

export async function updateMemberRole(
  context: DomainContext,
  input: { userId: string; businessId: string; membershipId: string; role: Exclude<BusinessRole, "business_owner"> },
): Promise<void> {
  await withBusinessTransaction(context.db, { ...input, actorType: "operator" }, async (tx) => {
    await requireBusinessAdmin(tx, input);
    const outcome = await updateMemberRoleInTransaction(tx, { ...input, actorUserId: input.userId });
    if (outcome === "not_found") throw new Error("Membership not found.");
    if (outcome === "final_owner") throw new Error("The final owner cannot be changed.");
  });
}

export async function removeMember(
  context: DomainContext,
  input: { userId: string; businessId: string; membershipId: string },
): Promise<void> {
  await withBusinessTransaction(context.db, { ...input, actorType: "operator" }, async (tx) => {
    await requireBusinessAdmin(tx, input);
    // RLS hides the member's users row from the app role; this function returns their email.
    const outcome = await removeMemberInTransaction(tx, { ...input, actorUserId: input.userId }, async () => (await tx.execute<{ email: string }>(sql`select email from app.list_business_members(${input.businessId}::uuid) where membership_id = ${input.membershipId}::uuid`)).rows[0]?.email);
    if (outcome === "not_found") throw new Error("Membership not found.");
    if (outcome === "final_owner") throw new Error("The final owner cannot be removed.");
  });
}

export async function revokeInvitation(
  context: DomainContext,
  input: { userId: string; businessId: string; invitationId: string },
): Promise<void> {
  await withBusinessTransaction(context.db, { ...input, actorType: "operator" }, async (tx) => {
    await requireBusinessAdmin(tx, input);
    if (!await revokeInvitationInTransaction(tx, input)) throw new Error("Invitation not found or already resolved.");
  });
}
