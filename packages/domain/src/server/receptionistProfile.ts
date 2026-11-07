import { and, eq, isNull } from "drizzle-orm";

import { businesses, enqueueOutbox, receptionistProfiles, type DatabaseTransaction } from "@lobbystack/db";
import {
  appointmentChangeVerificationModes,
  bookingModes,
  isRuntimeLocale,
  RECEPTIONIST_INSTRUCTIONS_MAX_LENGTH,
  RECEPTIONIST_TEXT_MAX_LENGTH,
  transferModes,
  type AppointmentChangePolicy,
  type BookingMode,
  type RuntimeLocale,
  type TransferPolicy,
} from "@lobbystack/shared";

// Receptionist settings. The dashboard and the v1 API check and save them
// here, so both follow one set of rules. A business has one or more
// receptionists (receptionist_profiles rows), exactly one of them its default;
// the summary, the AI and recording notice and the appointment change rules
// are the business's, shared by every receptionist, and live on businesses.

/** Fields a change can set. A missing field stays as it is; null clears an optional one. */
export type ReceptionistProfilePatch = {
  greeting?: string;
  tone?: string;
  summary?: string;
  bookingPolicy?: string;
  voiceInstructions?: string | null;
  smsInstructions?: string | null;
  chatInstructions?: string | null;
  transferMode?: TransferPolicy["mode"];
  transferNumber?: string | null;
  appointmentChangePolicy?: AppointmentChangePolicy;
  bookingMode?: BookingMode;
  /** Whether calls say, after the greeting, that the caller is speaking with an AI and the call is recorded and transcribed. */
  recordingNotice?: boolean;
};

export type ReceptionistSettingsChange = {
  patch: ReceptionistProfilePatch;
  /**
   * The language the receptionist's calls open in: for the default one the
   * business's default customer language; null has another receptionist speak
   * the business's.
   */
  locale?: RuntimeLocale | null;
  timezone?: string;
  /** Hands the summary back to AI, which rewrites it from the knowledge sources. */
  regenerateSummary: boolean;
};

const profileFields = ["greeting", "tone", "summary", "bookingPolicy", "voiceInstructions", "smsInstructions", "chatInstructions", "transferMode", "transferNumber"] as const;
type ProfileField = (typeof profileFields)[number];
const instructionFields: readonly ProfileField[] = ["voiceInstructions", "smsInstructions", "chatInstructions"];
const clearableFields: readonly ProfileField[] = [...instructionFields, "transferNumber"];

function invalid(message: string): Error {
  return Object.assign(new Error(message), { status: 400 });
}

function optionalText(value: unknown, field: string, maxLength: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") throw invalid(`${field} must be a string.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) throw invalid(`${field} is invalid.`);
  return normalized;
}

function appointmentPolicy(value: unknown): AppointmentChangePolicy | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("appointmentChangePolicy is invalid.");
  const policy = value as Record<string, unknown>;
  if (typeof policy.enabled !== "boolean" || typeof policy.allowCancel !== "boolean" || typeof policy.allowReschedule !== "boolean" || !(appointmentChangeVerificationModes as readonly string[]).includes(String(policy.verificationMode))) throw invalid("appointmentChangePolicy is invalid.");
  return { enabled: policy.enabled, allowCancel: policy.allowCancel, allowReschedule: policy.allowReschedule, verificationMode: policy.verificationMode as AppointmentChangePolicy["verificationMode"] };
}

/**
 * Reads the dashboard's receptionist settings body: profile fields in
 * camelCase plus locale, timezone and regenerateSummary. Throws a 400 error
 * that names the first field that is wrong.
 */
export function readReceptionistSettingsChange(body: unknown): ReceptionistSettingsChange {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw invalid("A profile object is required.");
  const input = body as Record<string, unknown>;
  const fields: Partial<Record<ProfileField, string | null>> = {};
  for (const field of profileFields) {
    if (!(field in input)) continue;
    const value = optionalText(input[field], field, instructionFields.includes(field) ? RECEPTIONIST_INSTRUCTIONS_MAX_LENGTH : RECEPTIONIST_TEXT_MAX_LENGTH);
    if (value === null && !clearableFields.includes(field)) throw invalid(`${field} cannot be empty.`);
    if (value !== undefined) fields[field] = value;
  }
  if (fields.transferMode !== undefined && !(transferModes as readonly string[]).includes(fields.transferMode ?? "")) throw invalid("transferMode is invalid.");
  const policy = appointmentPolicy(input.appointmentChangePolicy);
  const bookingMode = input.bookingMode;
  if (bookingMode !== undefined && !(bookingModes as readonly unknown[]).includes(bookingMode)) throw invalid("bookingMode is invalid.");
  const recordingNotice = input.recordingNotice;
  if (recordingNotice !== undefined && typeof recordingNotice !== "boolean") throw invalid("recordingNotice must be true or false.");
  const patch = { ...fields, ...(policy !== undefined ? { appointmentChangePolicy: policy } : {}), ...(bookingMode !== undefined ? { bookingMode } : {}), ...(recordingNotice !== undefined ? { recordingNotice } : {}) } as ReceptionistProfilePatch;

  const locale = input.locale;
  if (locale !== undefined && locale !== null && !isRuntimeLocale(locale)) throw invalid("locale is invalid.");
  const timezone = input.timezone;
  if (timezone !== undefined && typeof timezone !== "string") throw invalid("timezone must be a string.");
  const regenerateSummary = input.regenerateSummary;
  if (regenerateSummary !== undefined && regenerateSummary !== true) throw invalid("regenerateSummary must be true.");
  if (regenerateSummary && patch.summary !== undefined) throw invalid("Send summary or regenerateSummary, not both.");
  if (Object.keys(patch).length === 0 && locale === undefined && timezone === undefined && !regenerateSummary) throw invalid("At least one profile field is required.");
  return { patch, ...(locale !== undefined ? { locale } : {}), ...(timezone !== undefined ? { timezone } : {}), regenerateSummary: regenerateSummary === true };
}

/** The fields of a patch every receptionist shares, which the business keeps. */
export const sharedReceptionistFields = ["summary", "recordingNotice", "appointmentChangePolicy"] as const satisfies ReadonlyArray<keyof ReceptionistProfilePatch>;
export type SharedReceptionistField = (typeof sharedReceptionistFields)[number];

/** A patch split into what the business keeps and what the receptionist keeps. */
export function splitReceptionistPatch(patch: ReceptionistProfilePatch): { shared: Pick<ReceptionistProfilePatch, SharedReceptionistField>; own: Omit<ReceptionistProfilePatch, SharedReceptionistField> } {
  const shared: Pick<ReceptionistProfilePatch, SharedReceptionistField> = {};
  const own: Omit<ReceptionistProfilePatch, SharedReceptionistField> = {};
  for (const [field, value] of Object.entries(patch) as Array<[keyof ReceptionistProfilePatch, unknown]>) {
    if (value === undefined) continue;
    if ((sharedReceptionistFields as readonly string[]).includes(field)) Object.assign(shared, { [field]: value });
    else Object.assign(own, { [field]: value });
  }
  return { shared, own };
}

/**
 * A receptionist as the dashboard and the API show it: its own row, with the
 * settings every receptionist shares read from the business.
 */
export type ReceptionistView = typeof receptionistProfiles.$inferSelect & Pick<typeof businesses.$inferSelect, keyof typeof sharedReceptionistColumns>;

/** The columns of businesses that hold the settings every receptionist shares. */
export const sharedReceptionistColumns = {
  summary: businesses.summary,
  summarySource: businesses.summarySource,
  summaryFingerprint: businesses.summaryFingerprint,
  summaryGeneratedAt: businesses.summaryGeneratedAt,
  recordingNotice: businesses.recordingNotice,
  appointmentChangePolicy: businesses.appointmentChangePolicy,
};

/**
 * A business's receptionist with the shared settings: the one named, or the
 * default one without a name. An archived receptionist is left out unless
 * asked for. Null when the business has no such receptionist. lock takes the
 * receptionist's row for update.
 */
export async function loadReceptionistView(
  tx: DatabaseTransaction,
  input: { businessId: string; receptionistId?: string | null | undefined; includeArchived?: boolean; lock?: boolean },
): Promise<ReceptionistView | null> {
  const which = input.receptionistId
    ? and(eq(receptionistProfiles.id, input.receptionistId), input.includeArchived ? undefined : isNull(receptionistProfiles.archivedAt))
    : eq(receptionistProfiles.isDefault, true);
  const query = tx
    .select({ profile: receptionistProfiles, shared: sharedReceptionistColumns })
    .from(receptionistProfiles)
    .innerJoin(businesses, eq(businesses.id, receptionistProfiles.businessId))
    .where(and(eq(receptionistProfiles.businessId, input.businessId), which))
    .limit(1);
  const [row] = input.lock ? await query.for("update", { of: receptionistProfiles }) : await query;
  return row ? { ...row.profile, ...row.shared } : null;
}

function notFound(message: string): Error {
  return Object.assign(new Error(message), { status: 404 });
}

/**
 * Saves the fields given and refreshes the snapshot calls read receptionists
 * from. The shared settings go to the business; the others to the
 * receptionist named, or the default one, which every business has from the
 * moment it exists (migration 0143). A summary someone writes is never
 * replaced by AI; regenerateSummary hands it back to AI and queues the
 * rewrite. Callers authorize and check the fields first. Null when nothing
 * was saved; a 404 error for a receptionist the business doesn't have or has
 * archived.
 */
export async function saveReceptionistProfileInTransaction(
  tx: DatabaseTransaction,
  input: { businessId: string; receptionistId?: string | null | undefined; patch: ReceptionistProfilePatch; regenerateSummary?: boolean | undefined },
): Promise<ReceptionistView | null> {
  const { businessId } = input;
  const { shared, own } = splitReceptionistPatch(input.patch);
  const now = new Date();

  // The receptionist named; none means the default one.
  let target: { id: string } | undefined;
  if (input.receptionistId) {
    [target] = await tx.select({ id: receptionistProfiles.id }).from(receptionistProfiles)
      .where(and(eq(receptionistProfiles.businessId, businessId), eq(receptionistProfiles.id, input.receptionistId), isNull(receptionistProfiles.archivedAt)))
      .limit(1)
      .for("update");
    if (!target) throw notFound("Receptionist not found.");
  }

  // 1. The business keeps the shared settings.
  const summarySource = shared.summary !== undefined ? "operator" as const : input.regenerateSummary ? "generated" as const : undefined;
  const businessSet = { ...shared, ...(summarySource ? { summarySource } : {}) };
  if (Object.keys(businessSet).length) {
    const [business] = await tx.update(businesses).set({ ...businessSet, updatedAt: now }).where(eq(businesses.id, businessId)).returning({ id: businesses.id });
    if (!business) return null;
  }

  // 2. The receptionist keeps its own settings. A save of shared settings
  // alone still marks it saved, which names the snapshot refresh below.
  const [saved] = await tx.update(receptionistProfiles).set({ ...own, updatedAt: now })
    .where(and(eq(receptionistProfiles.businessId, businessId), target ? eq(receptionistProfiles.id, target.id) : eq(receptionistProfiles.isDefault, true)))
    .returning({ id: receptionistProfiles.id, updatedAt: receptionistProfiles.updatedAt });
  if (!saved) {
    if (target) throw notFound("Receptionist not found.");
    return null;
  }

  await enqueueOutbox(tx, {
    topic: "snapshot.refresh",
    businessId,
    aggregateType: "receptionist_profile",
    aggregateId: saved.id,
    dedupeKey: `snapshot:${businessId}:profile:${saved.id}:${saved.updatedAt.toISOString()}`,
    payload: { businessId },
  });
  if (input.regenerateSummary) {
    await enqueueOutbox(tx, {
      topic: "business.generateSummary",
      businessId,
      aggregateType: "business",
      aggregateId: businessId,
      dedupeKey: `business-summary:${businessId}:regenerate:${Date.now()}`,
      payload: { businessId, reason: "operator_regenerate", force: true },
    });
  }
  return await loadReceptionistView(tx, { businessId, receptionistId: saved.id });
}
