import { and, eq, ne } from "drizzle-orm";

import { auditLogs, phoneNumbers, receptionistProfiles, widgetKeys, type DatabaseTransaction } from "@lobbystack/db";
import { isUuid, type ReceptionistStatus } from "@lobbystack/shared";

// Who answers each phone number and website widget. Every number and widget
// key names one receptionist (a new one gets the default from a trigger); a
// paused or archived one's calls and chats go to the default receptionist
// (app.effective_receptionist). QR links name theirs in entryLinks.ts. Callers
// authorize: pointing an entry point at a receptionist is for owners and
// admins.

function failure(message: string, status: number, code: string): Error {
  return Object.assign(new Error(message), { status, code });
}

/** A receptionist id from a request body. Throws a 400 for anything else. */
export function readEntryPointReceptionist(value: unknown): string {
  if (typeof value !== "string" || !isUuid(value)) throw failure("receptionistId must be a receptionist's id.", 400, "invalid_receptionist");
  return value.toLowerCase();
}

/**
 * The business's receptionist an entry point may name: any that isn't
 * archived. A paused one may be named; the default receptionist answers for it
 * until it resumes. A 404 for a receptionist the business doesn't have, a 409
 * for an archived one.
 */
export async function requireAssignableReceptionistInTransaction(tx: DatabaseTransaction, input: { businessId: string; receptionistId: string }): Promise<{ id: string; name: string; status: ReceptionistStatus; isDefault: boolean }> {
  if (!isUuid(input.receptionistId)) throw failure("Receptionist not found.", 404, "receptionist_not_found");
  const [row] = await tx.select({ id: receptionistProfiles.id, name: receptionistProfiles.name, status: receptionistProfiles.status, isDefault: receptionistProfiles.isDefault, archivedAt: receptionistProfiles.archivedAt })
    .from(receptionistProfiles)
    .where(and(eq(receptionistProfiles.businessId, input.businessId), eq(receptionistProfiles.id, input.receptionistId.toLowerCase())))
    .limit(1);
  if (!row) throw failure("Receptionist not found.", 404, "receptionist_not_found");
  if (row.archivedAt) throw failure("An archived receptionist can't answer. Restore it first.", 409, "receptionist_archived");
  return { id: row.id, name: row.name, status: row.status as ReceptionistStatus, isDefault: row.isDefault };
}

/**
 * Points one of the business's numbers that isn't reclaimed at a receptionist:
 * its calls and texts go to that receptionist from the next one on. A 404 for
 * a number the business doesn't have.
 */
export async function setPhoneNumberReceptionistInTransaction(
  tx: DatabaseTransaction,
  input: { businessId: string; actorUserId: string | null; phoneNumberId: string; receptionistId: string },
): Promise<{ id: string; e164: string; receptionistId: string }> {
  const { businessId } = input;
  if (!isUuid(input.phoneNumberId)) throw failure("Phone number not found.", 404, "phone_number_not_found");
  const [number] = await tx.select({ id: phoneNumbers.id, e164: phoneNumbers.e164, receptionistId: phoneNumbers.receptionistId }).from(phoneNumbers)
    .where(and(eq(phoneNumbers.businessId, businessId), eq(phoneNumbers.id, input.phoneNumberId), ne(phoneNumbers.status, "reclaimed")))
    .limit(1)
    .for("update");
  if (!number) throw failure("Phone number not found.", 404, "phone_number_not_found");
  const receptionist = await requireAssignableReceptionistInTransaction(tx, { businessId, receptionistId: input.receptionistId });
  if (number.receptionistId !== receptionist.id) {
    await tx.update(phoneNumbers).set({ receptionistId: receptionist.id, updatedAt: new Date() })
      .where(and(eq(phoneNumbers.businessId, businessId), eq(phoneNumbers.id, number.id)));
    await tx.insert(auditLogs).values({
      businessId,
      ...(input.actorUserId ? { actorUserId: input.actorUserId } : {}),
      eventType: "phone_number.receptionist_changed",
      entityType: "phone_number",
      entityId: number.id,
      payload: { from: number.receptionistId, to: receptionist.id },
    });
  }
  return { id: number.id, e164: number.e164, receptionistId: receptionist.id };
}

/**
 * Points one of the business's widget keys at a receptionist: chats that start
 * from then on go to it, on every website the key runs on. A business or
 * receptionist page names its own receptionist instead (its signed token). A
 * 404 for a key the business doesn't have.
 */
export async function setWidgetKeyReceptionistInTransaction(
  tx: DatabaseTransaction,
  input: { businessId: string; actorUserId: string | null; widgetKeyId: string; receptionistId: string },
): Promise<{ id: string; receptionistId: string }> {
  const { businessId } = input;
  if (!isUuid(input.widgetKeyId)) throw failure("The widget key was not found.", 404, "widget_key_not_found");
  const [key] = await tx.select({ id: widgetKeys.id, receptionistId: widgetKeys.receptionistId }).from(widgetKeys)
    .where(and(eq(widgetKeys.businessId, businessId), eq(widgetKeys.id, input.widgetKeyId)))
    .limit(1)
    .for("update");
  if (!key) throw failure("The widget key was not found.", 404, "widget_key_not_found");
  const receptionist = await requireAssignableReceptionistInTransaction(tx, { businessId, receptionistId: input.receptionistId });
  if (key.receptionistId !== receptionist.id) {
    await tx.update(widgetKeys).set({ receptionistId: receptionist.id, updatedAt: new Date() })
      .where(and(eq(widgetKeys.businessId, businessId), eq(widgetKeys.id, key.id)));
    await tx.insert(auditLogs).values({
      businessId,
      ...(input.actorUserId ? { actorUserId: input.actorUserId } : {}),
      eventType: "widget_key.receptionist_changed",
      entityType: "widget_key",
      entityId: key.id,
      payload: { from: key.receptionistId, to: receptionist.id },
    });
  }
  return { id: key.id, receptionistId: receptionist.id };
}
