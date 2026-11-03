import { and, eq, isNull, sql } from "drizzle-orm";

import { businesses, enqueueOutbox, receptionistProfiles, type DatabaseTransaction } from "@lobbystack/db";
import {
  appointmentChangeVerificationModes,
  bookingModes,
  defaultAppointmentChangePolicy,
  defaultReceptionistName,
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

/** The settings a receptionist has before anyone edits them. */
export function defaultReceptionistProfile(businessName: string) {
  return {
    greeting: `Thank you for calling ${businessName}.`,
    tone: "professional",
    summary: businessName,
    summarySource: "placeholder" as const,
    bookingPolicy: "Confirm availability before booking.",
    voiceInstructions: null,
    smsInstructions: null,
    chatInstructions: null,
    transferMode: "on_request" as const,
    transferNumber: null,
    appointmentChangePolicy: defaultAppointmentChangePolicy,
    bookingMode: "instant" as const,
    recordingNotice: true,
  };
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
 * settings every receptionist shares read from the business. Its row's copies
 * of those settings are left over from before receptionists, kept current on
 * the default receptionist only, and never read.
 */
export type ReceptionistView = typeof receptionistProfiles.$inferSelect;

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

/**
 * Gives the default receptionist's row the business's new shared settings,
 * which the code of the release before reads from there. Until the clean-up
 * deploy, every write of them to businesses calls this in its transaction.
 */
export async function copySharedSettingsToDefaultReceptionist(
  tx: DatabaseTransaction,
  businessId: string,
  values: Partial<{ [Key in keyof typeof sharedReceptionistColumns]: ReceptionistView[Key] }>,
): Promise<void> {
  if (!Object.keys(values).length) return;
  await tx.update(receptionistProfiles).set(values)
    .where(and(eq(receptionistProfiles.businessId, businessId), eq(receptionistProfiles.isDefault, true)));
}

function notFound(message: string): Error {
  return Object.assign(new Error(message), { status: 404 });
}

/**
 * Saves the fields given and refreshes the snapshot calls read receptionists
 * from. The shared settings go to the business and to the default
 * receptionist's copy; the others to the receptionist named, or the default
 * one, which is created from the defaults when the business has none. A
 * summary someone writes is never replaced by AI; regenerateSummary hands it
 * back to AI and queues the rewrite. Callers authorize and check the fields
 * first. Null when nothing was saved; a 404 error for a receptionist the
 * business doesn't have or has archived.
 */
export async function saveReceptionistProfileInTransaction(
  tx: DatabaseTransaction,
  input: { businessId: string; businessName: string; receptionistId?: string | null | undefined; patch: ReceptionistProfilePatch; regenerateSummary?: boolean | undefined },
): Promise<ReceptionistView | null> {
  const { businessId } = input;
  const { shared, own } = splitReceptionistPatch(input.patch);
  const now = new Date();

  // The receptionist named, unless it is the default one.
  let target: { id: string; isDefault: boolean } | undefined;
  if (input.receptionistId) {
    [target] = await tx.select({ id: receptionistProfiles.id, isDefault: receptionistProfiles.isDefault }).from(receptionistProfiles)
      .where(and(eq(receptionistProfiles.businessId, businessId), eq(receptionistProfiles.id, input.receptionistId), isNull(receptionistProfiles.archivedAt)))
      .limit(1)
      .for("update");
    if (!target) throw notFound("Receptionist not found.");
  }

  // 1. The business keeps the shared settings.
  const summarySource = shared.summary !== undefined ? "operator" as const : input.regenerateSummary ? "generated" as const : undefined;
  const businessSet = { ...shared, ...(summarySource ? { summarySource } : {}) };
  const [business] = Object.keys(businessSet).length
    ? await tx.update(businesses).set({ ...businessSet, updatedAt: now }).where(eq(businesses.id, businessId)).returning({ defaultLocale: businesses.defaultLocale, ...sharedReceptionistColumns })
    : await tx.select({ defaultLocale: businesses.defaultLocale, ...sharedReceptionistColumns }).from(businesses).where(eq(businesses.id, businessId)).limit(1);
  if (!business) return null;
  const { defaultLocale, ...sharedNow } = business;
  const sharedChanged = Object.keys(businessSet).length > 0;

  // 2. The default receptionist keeps a copy of them until the clean-up
  // deploy, for the code of the release before, and its own settings when it
  // is the one being saved. It is created from the defaults when the business
  // has none, which only a business from before receptionist profiles can be.
  let saved: { id: string; updatedAt: Date } | undefined;
  if (!target || target.isDefault || sharedChanged) {
    const ownOfDefault = !target || target.isDefault ? own : {};
    const defaults = defaultReceptionistProfile(input.businessName);
    const [defaultProfile] = await tx.insert(receptionistProfiles).values({
      businessId,
      name: defaultReceptionistName(defaultLocale),
      isDefault: true,
      greeting: ownOfDefault.greeting ?? defaults.greeting,
      tone: ownOfDefault.tone ?? defaults.tone,
      bookingPolicy: ownOfDefault.bookingPolicy ?? defaults.bookingPolicy,
      ...(ownOfDefault.voiceInstructions !== undefined ? { voiceInstructions: ownOfDefault.voiceInstructions } : {}),
      ...(ownOfDefault.smsInstructions !== undefined ? { smsInstructions: ownOfDefault.smsInstructions } : {}),
      ...(ownOfDefault.chatInstructions !== undefined ? { chatInstructions: ownOfDefault.chatInstructions } : {}),
      transferMode: ownOfDefault.transferMode ?? defaults.transferMode,
      ...(ownOfDefault.transferNumber !== undefined ? { transferNumber: ownOfDefault.transferNumber } : {}),
      ...(ownOfDefault.bookingMode !== undefined ? { bookingMode: ownOfDefault.bookingMode } : {}),
      ...sharedNow,
      // A business that never had a summary starts from the placeholder,
      // which the copy trigger then gives the business too.
      ...(sharedNow.summarySource === "placeholder" && !sharedNow.summary ? { summary: defaults.summary } : {}),
      appointmentChangePolicy: sharedNow.appointmentChangePolicy ?? defaults.appointmentChangePolicy,
    }).onConflictDoUpdate({
      target: receptionistProfiles.businessId,
      targetWhere: sql`${receptionistProfiles.isDefault}`,
      set: { ...ownOfDefault, ...(sharedChanged ? sharedNow : {}), updatedAt: now },
    }).returning({ id: receptionistProfiles.id, updatedAt: receptionistProfiles.updatedAt });
    if (!defaultProfile) return null;
    saved = defaultProfile;
  }

  // 3. Any other receptionist keeps its own settings.
  if (target && !target.isDefault) {
    const [other] = await tx.update(receptionistProfiles).set({ ...own, updatedAt: now })
      .where(and(eq(receptionistProfiles.businessId, businessId), eq(receptionistProfiles.id, target.id)))
      .returning({ id: receptionistProfiles.id, updatedAt: receptionistProfiles.updatedAt });
    if (!other) throw notFound("Receptionist not found.");
    saved = other;
  }
  if (!saved) return null;

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
