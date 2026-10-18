import { and, asc, count, eq, ilike, inArray, isNull } from "drizzle-orm";

import { enqueueOutbox, withBusinessTransaction, type DatabaseTransaction } from "@lobbystack/db";
import { agentRules, businesses, businessHours, closures, phoneNumbers, receptionistProfiles, services, staff, staffServiceAssignments } from "@lobbystack/db";

import { requireBusinessAdmin, requireBusinessMembership } from "../authz";
import { normalizeHoursWindows } from "../hours";
import { writeBusinessHoursInTransaction } from "./businessHours";
import type { DomainContext } from "./context";

export async function listCatalog(
  context: DomainContext,
  input: { userId: string; businessId: string; search?: string; limit?: number; offset?: number },
) {
  return await withBusinessTransaction(context.db, { ...input, actorType: "operator" }, async (tx) => {
    await requireBusinessMembership(tx, input);
    const staffRows = await tx.select().from(staff).where(eq(staff.businessId, input.businessId)).orderBy(asc(staff.name));
    const serviceRows = await tx.select().from(services).where(and(eq(services.businessId, input.businessId), isNull(services.deletedAt), ...(input.search?.trim() ? [ilike(services.name, `%${input.search.trim()}%`)] : []))).orderBy(asc(services.name)).limit(Math.min(Math.max(Math.trunc(input.limit ?? 100), 1), 100) + 1).offset(Math.max(Math.trunc(input.offset ?? 0), 0));
    const hoursRows = await tx.select().from(businessHours).where(eq(businessHours.businessId, input.businessId)).orderBy(asc(businessHours.dayOfWeek), asc(businessHours.openMinutes));
    const closureRows = await tx.select().from(closures).where(eq(closures.businessId, input.businessId)).orderBy(asc(closures.startsAt));
    const numberRows = await tx.select().from(phoneNumbers).where(and(eq(phoneNumbers.businessId, input.businessId), eq(phoneNumbers.status, "active"))).orderBy(asc(phoneNumbers.e164));
    const profileRows = await tx.select().from(receptionistProfiles).where(eq(receptionistProfiles.businessId, input.businessId)).limit(1);
    const ruleRows = await tx.select().from(agentRules).where(eq(agentRules.businessId, input.businessId)).orderBy(asc(agentRules.sortOrder), asc(agentRules.createdAt), asc(agentRules.id));
    const limit = Math.min(Math.max(Math.trunc(input.limit ?? 100), 1), 100);
    const offset = Math.max(Math.trunc(input.offset ?? 0), 0);
    const [total] = await tx.select({ count: count() }).from(services).where(and(eq(services.businessId, input.businessId), isNull(services.deletedAt), ...(input.search?.trim() ? [ilike(services.name, `%${input.search.trim()}%`)] : [])));
    const page = serviceRows.slice(0, limit);
    const serviceIds = page.map((service) => service.id);
    const assignments = serviceIds.length ? await tx.select({ serviceId: staffServiceAssignments.serviceId, staffId: staffServiceAssignments.staffId }).from(staffServiceAssignments).where(and(eq(staffServiceAssignments.businessId, input.businessId), inArray(staffServiceAssignments.serviceId, serviceIds))) : [];
    return { staff: staffRows, services: page.map((service) => ({ ...service, assignedStaffIds: assignments.filter((assignment) => assignment.serviceId === service.id).map((assignment) => assignment.staffId) })), servicesPagination: { limit, offset, total: Number(total?.count ?? 0), hasNext: serviceRows.length > limit }, hours: hoursRows, closures: closureRows, phoneNumbers: numberRows, receptionistProfile: profileRows[0] ?? null, rules: ruleRows };
  });
}

export async function createService(
  context: DomainContext,
  input: { userId: string; businessId: string; name: string; slug: string; durationMinutes: number; description?: string; active?: boolean },
): Promise<string> {
  return await withBusinessTransaction(context.db, { ...input, actorType: "operator" }, async (tx) => {
    await requireBusinessAdmin(tx, input);
    return (await insertServiceInTransaction(tx, input)).id;
  });
}

/** Adds a service and refreshes the receptionist snapshot. Callers authorize and check the fields first. */
export async function insertServiceInTransaction(
  tx: DatabaseTransaction,
  input: { businessId: string; name: string; slug: string; durationMinutes: number; description?: string | undefined; active?: boolean | undefined },
): Promise<typeof services.$inferSelect> {
  const [service] = await tx.insert(services).values({
    businessId: input.businessId,
    name: input.name.trim(),
    slug: input.slug.trim().toLowerCase(),
    durationMinutes: input.durationMinutes,
    description: input.description,
    active: input.active ?? true,
  }).returning();
  if (!service) {
    throw new Error("Service could not be created.");
  }
  await enqueueOutbox(tx, {
    topic: "snapshot.refresh",
    businessId: input.businessId,
    aggregateType: "service",
    aggregateId: service.id,
    dedupeKey: `service:${service.id}:snapshot:${Date.now()}`,
    payload: { businessId: input.businessId, reason: "service_created" },
  });
  return service;
}

export async function updateService(
  context: DomainContext,
  input: { userId: string; businessId: string; serviceId: string; name?: string; slug?: string; durationMinutes?: number; description?: string | null; active?: boolean },
): Promise<void> {
  await withBusinessTransaction(context.db, { ...input, actorType: "operator" }, async (tx) => {
    await requireBusinessAdmin(tx, input);
    if (!await updateServiceInTransaction(tx, input)) throw Object.assign(new Error("Service not found."), { status: 404 });
  });
}

/** Changes the fields given on a service that isn't deleted and refreshes the snapshot. Null when there is no such service. Callers authorize first. */
export async function updateServiceInTransaction(
  tx: DatabaseTransaction,
  input: { businessId: string; serviceId: string; name?: string | undefined; slug?: string | undefined; durationMinutes?: number | undefined; description?: string | null | undefined; active?: boolean | undefined },
): Promise<typeof services.$inferSelect | null> {
  const [service] = await tx.update(services).set({
    ...(input.name !== undefined ? { name: input.name.trim() } : {}),
    ...(input.slug !== undefined ? { slug: input.slug.trim().toLowerCase() } : {}),
    durationMinutes: input.durationMinutes,
    description: input.description,
    active: input.active,
    updatedAt: new Date(),
  }).where(and(eq(services.id, input.serviceId), eq(services.businessId, input.businessId), isNull(services.deletedAt))).returning();
  if (!service) return null;
  await enqueueOutbox(tx, { topic: "snapshot.refresh", businessId: input.businessId, aggregateType: "service", aggregateId: service.id, dedupeKey: `service:${service.id}:snapshot:${Date.now()}`, payload: { businessId: input.businessId, reason: "service_updated" } });
  return service;
}

/**
 * Deletes a service from the catalog. Appointments still reference it for
 * history, so the row stays, inactive and marked deleted, and its slug is
 * free for a new service.
 */
export async function deleteService(
  context: DomainContext,
  input: { userId: string; businessId: string; serviceId: string },
): Promise<void> {
  await withBusinessTransaction(context.db, { ...input, actorType: "operator" }, async (tx) => {
    await requireBusinessAdmin(tx, input);
    if (!await deleteServiceInTransaction(tx, input)) throw Object.assign(new Error("Service not found."), { status: 404 });
  });
}

/** Marks a service deleted, as deleteService explains, and drops its staff. False when there is no such service. Callers authorize first. */
export async function deleteServiceInTransaction(tx: DatabaseTransaction, input: { businessId: string; serviceId: string }): Promise<boolean> {
  const now = new Date();
  const [service] = await tx.update(services).set({ active: false, deletedAt: now, updatedAt: now }).where(and(eq(services.id, input.serviceId), eq(services.businessId, input.businessId), isNull(services.deletedAt))).returning({ id: services.id });
  if (!service) return false;
  await tx.delete(staffServiceAssignments).where(and(eq(staffServiceAssignments.businessId, input.businessId), eq(staffServiceAssignments.serviceId, service.id)));
  await enqueueOutbox(tx, { topic: "snapshot.refresh", businessId: input.businessId, aggregateType: "service", aggregateId: service.id, dedupeKey: `service:${service.id}:snapshot:${Date.now()}`, payload: { businessId: input.businessId, reason: "service_deleted" } });
  return true;
}

/**
 * Makes these staff members the only ones who take the service; an empty list
 * opens it to every active staff member again. Refreshes the snapshot when the
 * assignments change. Callers authorize first and check the service exists.
 * Lists the ids that aren't staff of this business, and changes nothing then.
 */
export async function replaceServiceStaffInTransaction(tx: DatabaseTransaction, input: { businessId: string; serviceId: string; staffIds: readonly string[] }): Promise<{ unknownStaffIds: string[]; changed: boolean }> {
  // Ids come back from the database in lowercase, so compare them that way.
  const wanted = [...new Set(input.staffIds.map((id) => id.toLowerCase()))];
  const known = wanted.length ? (await tx.select({ id: staff.id }).from(staff).where(and(eq(staff.businessId, input.businessId), inArray(staff.id, wanted)))).map((row) => row.id) : [];
  const unknownStaffIds = wanted.filter((id) => !known.includes(id));
  if (unknownStaffIds.length) return { unknownStaffIds, changed: false };
  const current = (await tx.select({ staffId: staffServiceAssignments.staffId }).from(staffServiceAssignments).where(and(eq(staffServiceAssignments.businessId, input.businessId), eq(staffServiceAssignments.serviceId, input.serviceId)))).map((row) => row.staffId);
  const removed = current.filter((id) => !wanted.includes(id));
  const added = wanted.filter((id) => !current.includes(id));
  if (!removed.length && !added.length) return { unknownStaffIds: [], changed: false };
  if (removed.length) await tx.delete(staffServiceAssignments).where(and(eq(staffServiceAssignments.businessId, input.businessId), eq(staffServiceAssignments.serviceId, input.serviceId), inArray(staffServiceAssignments.staffId, removed)));
  if (added.length) await tx.insert(staffServiceAssignments).values(added.map((staffId) => ({ businessId: input.businessId, serviceId: input.serviceId, staffId }))).onConflictDoNothing();
  await enqueueOutbox(tx, { topic: "snapshot.refresh", businessId: input.businessId, aggregateType: "service", aggregateId: input.serviceId, dedupeKey: `service:${input.serviceId}:staff:${Date.now()}`, payload: { businessId: input.businessId, reason: "assignment_updated" } });
  return { unknownStaffIds: [], changed: true };
}

export async function assignStaffToService(
  context: DomainContext,
  input: { userId: string; businessId: string; staffId: string; serviceId: string },
): Promise<void> {
  await withBusinessTransaction(context.db, { ...input, actorType: "operator" }, async (tx) => {
    await requireBusinessAdmin(tx, input);
    const [service] = await tx.select({ id: services.id }).from(services).where(and(eq(services.id, input.serviceId), eq(services.businessId, input.businessId), isNull(services.deletedAt))).limit(1);
    if (!service) throw Object.assign(new Error("Service not found."), { status: 404 });
    await tx.insert(staffServiceAssignments).values(input).onConflictDoNothing();
    await enqueueOutbox(tx, {
      topic: "snapshot.refresh",
      businessId: input.businessId,
      aggregateType: "staff_service_assignment",
      aggregateId: input.staffId,
      dedupeKey: `assignment:${input.staffId}:${input.serviceId}:${Date.now()}`,
      payload: { businessId: input.businessId, reason: "assignment_updated" },
    });
  });
}

export async function unassignStaffFromService(
  context: DomainContext,
  input: { userId: string; businessId: string; staffId: string; serviceId: string },
): Promise<void> {
  await withBusinessTransaction(context.db, { ...input, actorType: "operator" }, async (tx) => {
    await requireBusinessAdmin(tx, input);
    await tx.delete(staffServiceAssignments).where(and(eq(staffServiceAssignments.businessId, input.businessId), eq(staffServiceAssignments.staffId, input.staffId), eq(staffServiceAssignments.serviceId, input.serviceId)));
    await enqueueOutbox(tx, { topic: "snapshot.refresh", businessId: input.businessId, aggregateType: "staff_service_assignment", aggregateId: input.staffId, dedupeKey: `assignment:${input.staffId}:${input.serviceId}:${Date.now()}`, payload: { businessId: input.businessId, reason: "assignment_updated" } });
  });
}

/**
 * Replaces the weekly hours a person set, in the dashboard or the API: the
 * listed windows, other days closed. A day can have several windows. Marks
 * the hours as the operator's, so AI never replaces them, and refreshes the
 * receptionist snapshot. Callers authorize first.
 */
export async function replaceBusinessHoursInTransaction(
  tx: DatabaseTransaction,
  input: { businessId: string; hours: Array<{ dayOfWeek: number; openMinutes: number; closeMinutes: number }> },
): Promise<void> {
  const hours = normalizeHoursWindows(input.hours);
  // Updating the business row first locks it, so this write and the worker's
  // generated hours (which lock the same row) can't interleave.
  await tx.update(businesses).set({ hoursSource: "operator", updatedAt: new Date() }).where(eq(businesses.id, input.businessId));
  await writeBusinessHoursInTransaction(tx, { businessId: input.businessId, hours, reason: "hours_updated" });
}
