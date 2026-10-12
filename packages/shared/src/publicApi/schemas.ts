import { z } from "zod";

import { interfaceLocales } from "../locales";
import { appointmentChangeVerificationModes, bookingModes, RECEPTIONIST_INSTRUCTIONS_MAX_LENGTH, RECEPTIONIST_TEXT_MAX_LENGTH, RULE_CONTENT_CALL_MAX_LENGTH, RULE_TITLE_MAX_LENGTH, RULES_MAX, transferModes } from "../receptionist";
import { KNOWLEDGE_UPLOAD_MAX_BYTES, PUBLIC_API_VERSION, WEBHOOK_TEST_EVENT_TYPE, apiKeyScopes, webhookEventTypes, weekdays } from "./constants";

// The v1 public contract. Responses built by packages/domain are typed from
// these schemas, and the OpenAPI document is generated from them, so the docs,
// the REST API and webhook payloads cannot drift apart.

const id = z.uuid().describe("Stable identifier (UUID).");
const timestamp = z.iso.datetime().describe("ISO 8601 timestamp in UTC.");
const nullableTimestamp = timestamp.nullable();
// Zod 4 requires seconds once a timestamp has Z or an offset. The v1 API has always
// accepted minute precision too, such as 2026-10-09T14:00-04:00.
const withSeconds = z.iso.datetime({ offset: true });
const withoutSeconds = z.iso.datetime({ offset: true, precision: -1 });
const inputTimestamp = z.stringFormat("datetime", (value) => withSeconds.safeParse(value).success || withoutSeconds.safeParse(value).success).describe("ISO 8601 timestamp with a Z or numeric offset.");
const e164 = z.string().regex(/^\+[1-9]\d{6,14}$/, "Use E.164 format, for example +14165550134.").describe("Phone number in E.164 format.");
const clock = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/, "Use 24-hour HH:MM.").describe("Local time as 24-hour HH:MM.");
// A business's caller language is the language the AI receptionist speaks.
const locale = z.enum(["en", "fr"]);
// A contact's language picks the copy of the reminders and confirmations they receive.
const contactLocale = z.enum(interfaceLocales).describe("Language for the contact's reminders and confirmations: en, fr, es or sr.");

export const apiErrorCodes = [
  "invalid_request",
  "unauthorized",
  "forbidden",
  "insufficient_scope",
  "not_found",
  "conflict",
  "idempotency_key_reused",
  "idempotency_request_in_progress",
  "booking_disabled",
  "booking_requires_confirmation",
  "slot_unavailable",
  "rate_limited",
  "rate_limit_unavailable",
  "method_not_allowed",
  "internal_error",
  "business_required",
  "key_owner_inactive",
  "plan_limit_reached",
] as const;
export type ApiErrorCode = (typeof apiErrorCodes)[number];

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.enum(apiErrorCodes),
    message: z.string(),
    details: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  }),
});

export const apiHoursWindowSchema = z.object({
  day: z.enum(weekdays),
  open: clock,
  close: clock,
}).describe("One opening window on one day. A day with a break, such as lunch, has two windows. Days that are not listed are closed.");

export const apiMeSchema = z.object({
  api_key: z.object({
    id,
    name: z.string(),
    prefix: z.string().describe("The visible start of the key, for example lsk_1a2b3c4d, or lsp_1a2b3c4d for a platform key."),
    scopes: z.array(z.enum(apiKeyScopes)),
    created_at: timestamp,
  }),
  business: z.object({ id, name: z.string() }).nullable().describe("The business the key acts on. Always set for a per-business key. For a platform key, the business in the LobbyStack-Business header, or null when the request has none."),
  platform: z.object({
    partner: z.string().describe("Who the platform key belongs to, as set in PLATFORM_API_KEYS."),
    access: z.enum(["partner", "all"]).describe("all: the key can act on every business. partner: only on businesses its partner onboarded."),
  }).optional().describe("Present only for a platform key."),
}).describe("The API key making the request and the business it acts on.");

export const apiBusinessSchema = z.object({
  id,
  name: z.string(),
  timezone: z.string().describe("IANA time zone, for example America/Toronto."),
  locale: z.string().describe("Default language for callers: en or fr."),
  website_url: z.string().nullable(),
  business_type: z.string().describe("What kind of business it is. The dashboard uses service_company."),
  onboarding_stage: z.string().describe("Where the business is in onboarding, for example website, phone_number or complete."),
  booking_mode: z.enum(bookingModes).describe("instant: appointments are booked directly. request: the receptionist takes a request and the team confirms it. off: no booking."),
  hours: z.array(apiHoursWindowSchema),
  created_at: timestamp,
  updated_at: timestamp,
});

export const apiBusinessUpdateSchema = z.strictObject({
  name: z.string().trim().min(1).max(200).optional(),
  timezone: z.string().trim().min(1).max(80).optional(),
  locale: locale.optional(),
  website_url: z.url().max(2_000).nullable().optional(),
  business_type: z.string().trim().min(1).max(64).optional().describe("What kind of business it is."),
  hours: z.array(apiHoursWindowSchema).max(28).optional().describe("Replaces the whole week. Omit a day to close it. Send two windows for a day with a break. Windows on the same day can't overlap."),
});

const appointmentChangePolicyFields = {
  enabled: z.boolean().describe("Whether callers can change their own appointments with the receptionist."),
  allow_cancel: z.boolean(),
  allow_reschedule: z.boolean(),
  verification_mode: z.enum(appointmentChangeVerificationModes).describe("How a caller proves an appointment is theirs. phone_match_and_facts: their phone number and details of the booking. otp_required: a code sent by text. operator_only: the team makes the change."),
};

const receptionistText = z.string().trim().min(1).max(RECEPTIONIST_TEXT_MAX_LENGTH);
const receptionistInstructions = z.string().trim().min(1).max(RECEPTIONIST_INSTRUCTIONS_MAX_LENGTH).nullable();

export const apiReceptionistSchema = z.object({
  greeting: z.string().describe("What the receptionist says when it answers."),
  tone: z.string().describe("How it speaks, such as professional or warm."),
  summary: z.string().describe("What it tells callers the business does. Calls leave it out while summary_source is placeholder."),
  summary_source: z.enum(["placeholder", "generated", "operator"]).describe("placeholder: the default from sign-up. generated: written by AI from the business's knowledge. operator: written by a person or through the API, and AI never replaces it."),
  booking_policy: z.string().describe("Rules it follows when it books."),
  voice_instructions: z.string().nullable().describe("Extra instructions for calls."),
  sms_instructions: z.string().nullable().describe("Extra instructions for text messages."),
  chat_instructions: z.string().nullable().describe("Extra instructions for website chat."),
  transfer_mode: z.enum(transferModes).describe("When it puts a caller through to transfer_number: never, always, on_request, on_urgent or during_business_hours."),
  transfer_number: z.string().nullable().describe("Where it transfers calls, in E.164 format. A number saved before that was required may be in another format. With no number, it never transfers."),
  booking_mode: z.enum(bookingModes).describe("instant: appointments are booked directly. request: the receptionist takes a request and the team confirms it. off: no booking."),
  appointment_change_policy: z.object(appointmentChangePolicyFields).describe("Whether callers can cancel or reschedule their own appointments, and how they prove it's theirs."),
  updated_at: timestamp,
}).describe("How the receptionist answers, what it says about the business, and what it may do.");

export const apiReceptionistUpdateSchema = z.strictObject({
  greeting: receptionistText.optional(),
  tone: receptionistText.optional(),
  summary: receptionistText.optional().describe("AI never rewrites a summary set here."),
  regenerate_summary: z.literal(true).optional().describe("Hands the summary back to AI, which rewrites it from the business's knowledge. Can't be sent with summary."),
  booking_policy: receptionistText.optional(),
  voice_instructions: receptionistInstructions.optional().describe("null removes them."),
  sms_instructions: receptionistInstructions.optional().describe("null removes them."),
  chat_instructions: receptionistInstructions.optional().describe("null removes them."),
  transfer_mode: z.enum(transferModes).optional(),
  transfer_number: e164.nullable().optional().describe("null removes it, which stops transfers."),
  booking_mode: z.enum(bookingModes).optional(),
  appointment_change_policy: z.strictObject(appointmentChangePolicyFields).optional().describe("Send all four fields."),
}).refine((value) => value.summary === undefined || value.regenerate_summary === undefined, { message: "Send summary or regenerate_summary, not both.", path: ["regenerate_summary"] });

export const apiRuleSchema = z.object({
  id,
  title: z.string(),
  content: z.string().describe("What the receptionist must or must not do. Calls read the first 4,000 characters; a rule written in the dashboard can be longer."),
  active: z.boolean().describe("Whether the receptionist follows it."),
  created_at: timestamp,
  updated_at: timestamp,
}).describe("An instruction the receptionist follows on calls and in chats.");

export const apiRuleCreateSchema = z.strictObject({
  title: z.string().trim().min(1).max(RULE_TITLE_MAX_LENGTH),
  content: z.string().trim().min(1).max(RULE_CONTENT_CALL_MAX_LENGTH).describe("Up to 4,000 characters, all of which calls use."),
  active: z.boolean().optional().describe("Defaults to true."),
});

export const apiRuleUpdateSchema = z.strictObject({
  title: z.string().trim().min(1).max(RULE_TITLE_MAX_LENGTH).optional(),
  content: z.string().trim().min(1).max(RULE_CONTENT_CALL_MAX_LENGTH).optional().describe("Up to 4,000 characters, all of which calls use."),
  active: z.boolean().optional().describe("false stops the receptionist following it without deleting it."),
});

export const apiRuleReorderSchema = z.strictObject({
  rule_ids: z.array(id).min(1).max(RULES_MAX).describe("Every rule id once, in the order the receptionist should read them."),
});

export const apiBusinessCreateSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  timezone: z.string().trim().min(1).max(80).describe("IANA time zone, for example America/Toronto."),
  business_type: z.string().trim().min(1).max(64).optional().describe("Defaults to service_company, the type the dashboard uses."),
  slug: z.string().trim().min(2).max(120).optional().describe("Lowercase letters, digits and hyphens. Made from the name when left out. Another business already using it is a 409."),
  locale: locale.optional().describe("Default language for callers: en or fr. Defaults to en."),
  website_url: z.url().max(2_000).optional(),
});

export const apiBusinessSummarySchema = z.object({
  id,
  name: z.string(),
  timezone: z.string().describe("IANA time zone, for example America/Toronto."),
  locale: z.string().describe("Default language for callers: en or fr."),
  website_url: z.string().nullable(),
  onboarding_stage: z.string().describe("Where the business is in onboarding, for example website, phone_number or complete."),
  created_at: timestamp,
}).describe("A business the platform key's partner onboarded.");

export const apiServiceSchema = z.object({
  id,
  name: z.string(),
  slug: z.string().describe("A short name no other service of the business uses."),
  description: z.string().nullable(),
  duration_minutes: z.number().int(),
  active: z.boolean().describe("Only active services can be booked. GET /services lists the others only with include_inactive=true."),
  staff_ids: z.array(id).describe("The staff members who take this service. Empty means every active staff member does."),
  created_at: timestamp,
  updated_at: timestamp,
});

const serviceSlug = z.string().trim().toLowerCase().min(1).max(120).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, digits and single hyphens, such as color-touch-up.");
const serviceStaffIds = z.array(id).max(100);

export const apiServiceCreateSchema = z.strictObject({
  name: z.string().trim().min(1).max(160),
  slug: serviceSlug.optional().describe("Made from the name when left out, keeping only its Latin letters and digits, so a name without any needs a slug. One another service already uses is a 409."),
  description: z.string().trim().min(1).max(2_000).optional(),
  duration_minutes: z.number().int().min(1).max(1_440).describe("How long an appointment for it lasts, from 1 minute to 24 hours."),
  active: z.boolean().optional().describe("Defaults to true."),
  staff_ids: serviceStaffIds.optional().describe("The staff members who take it. Leave it out, or send [], to let every active staff member take it. Inactive staff don't take bookings, so a service whose staff are all inactive can't be booked."),
});

export const apiServiceUpdateSchema = z.strictObject({
  name: z.string().trim().min(1).max(160).optional(),
  slug: serviceSlug.optional().describe("One another service already uses is a 409."),
  description: z.string().trim().min(1).max(2_000).nullable().optional().describe("null removes it."),
  duration_minutes: z.number().int().min(1).max(1_440).optional(),
  active: z.boolean().optional().describe("false stops new bookings for it without deleting it."),
  staff_ids: serviceStaffIds.optional().describe("Replaces who takes it. [] lets every active staff member take it. Inactive staff don't take bookings, so a service whose staff are all inactive can't be booked."),
});

export const apiStaffSchema = z.object({
  id,
  name: z.string(),
  active: z.boolean().describe("Only active staff members take bookings."),
  timezone: z.string(),
  service_ids: z.array(id).describe("Active services this person can be booked for. A service with no staff assigned is open to every active staff member."),
  created_at: timestamp,
  updated_at: timestamp,
}).describe("A person who takes appointments. A business that never set up staff has one active staff member named after the business.");

export const apiCallSchema = z.object({
  id,
  channel: z.enum(["phone", "web"]).describe("phone: a phone call. web: a browser call from the website or dashboard."),
  status: z.enum(["in_progress", "completed"]),
  outcome: z.enum(["appointment_booked", "booking_incomplete", "message_taken", "conversation", "none"]),
  summary: z.string().nullable().describe("Short summary of the call, when one is available."),
  end_reason: z.string().nullable().describe("Why the call ended, as reported by the call provider or receptionist."),
  contact_id: id.nullable(),
  caller_name: z.string().nullable(),
  caller_phone: z.string().nullable(),
  duration_seconds: z.number().int().nullable(),
  recording_available: z.boolean(),
  started_at: timestamp,
  ended_at: nullableTimestamp,
  created_at: timestamp,
});

export const apiTranscriptEntrySchema = z.object({
  speaker: z.enum(["caller", "receptionist", "other"]),
  text: z.string(),
  at: timestamp,
});

export const apiCallDetailSchema = apiCallSchema.extend({
  transcript: z.array(apiTranscriptEntrySchema),
});

export const apiContactSchema = z.object({
  id,
  name: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  locale: z.string().nullable(),
  timezone: z.string().nullable(),
  created_at: timestamp,
  updated_at: timestamp,
});

export const apiContactCreateSchema = z.strictObject({
  name: z.string().trim().min(1).max(200).optional(),
  phone: e164.optional(),
  email: z.email().max(320).optional(),
  locale: contactLocale.optional(),
  timezone: z.string().trim().min(1).max(80).optional(),
}).refine((value) => Boolean(value.phone || value.email), { error: "Provide a phone or an email.", path: ["phone"] });

export const apiContactUpdateSchema = z.strictObject({
  name: z.string().trim().min(1).max(200).nullable().optional(),
  phone: e164.optional(),
  email: z.email().max(320).nullable().optional(),
  locale: contactLocale.nullable().optional(),
  timezone: z.string().trim().min(1).max(80).nullable().optional(),
});

export const apiAppointmentSchema = z.object({
  id,
  status: z.enum(["confirmed", "cancelled"]),
  starts_at: timestamp,
  ends_at: timestamp,
  timezone: z.string(),
  service_id: id,
  service_name: z.string(),
  staff_id: id,
  staff_name: z.string(),
  contact_id: id,
  contact_name: z.string().nullable(),
  contact_phone: z.string().nullable(),
  source: z.string().describe("Where the booking came from, for example voice, web_chat, dashboard or api."),
  calendar_sync_status: z.enum(["pending", "synced", "failed", "not_required"]),
  created_at: timestamp,
  updated_at: timestamp,
});

export const apiAppointmentCreateSchema = z.strictObject({
  service_id: id,
  starts_at: inputTimestamp.describe("Start time. Use a starts_at value from GET /availability."),
  contact_id: id.optional().describe("An existing contact with a phone number. Provide contact_id or contact_phone."),
  contact_phone: e164.optional(),
  contact_name: z.string().trim().min(1).max(200).optional(),
  staff_id: id.optional().describe("Book with this active staff member. Without it, LobbyStack picks one who is free."),
  sms_consent: z.boolean().optional().describe("True only if the customer agreed to receive confirmation and reminder texts. Self-hosted instances only: on LobbyStack Cloud, texts come from LobbyStack's shared number, and only the receptionist can collect that consent, on a call."),
}).refine((value) => Boolean(value.contact_id || value.contact_phone), { error: "Provide contact_id or contact_phone.", path: ["contact_phone"] });

export const apiAppointmentRescheduleSchema = z.strictObject({
  starts_at: inputTimestamp,
  staff_id: id.optional().describe("Move the appointment to this active staff member. Defaults to the current one."),
});

export const apiAvailabilitySlotSchema = z.object({
  starts_at: timestamp,
  ends_at: timestamp,
});

export const apiMessageSchema = z.object({
  id,
  status: z.enum(["open", "done"]),
  title: z.string(),
  body: z.string().describe("The full message as the team sees it."),
  caller_name: z.string().nullable(),
  callback_phone: z.string().nullable(),
  urgency: z.enum(["low", "normal", "urgent"]).nullable(),
  callback_window: z.string().nullable(),
  channel: z.enum(["voice", "web_voice", "web_chat", "sms"]).nullable(),
  call_id: id.nullable(),
  created_at: timestamp,
  updated_at: timestamp,
});

export const apiKnowledgeEntrySchema = z.object({
  id,
  type: z.enum(["text", "faq"]),
  title: z.string().describe("The entry's title, or an FAQ's question."),
  content: z.string().describe("The entry's text, or an FAQ's answer."),
  tags: z.array(z.string()).describe("Your own labels for the entry."),
  priority: z.number().int().describe("Entries with higher numbers come first when the receptionist picks the entries it keeps ready on every call. Defaults to 0."),
  active: z.boolean().describe("Whether the receptionist answers from it."),
  created_at: timestamp,
  updated_at: timestamp,
}).describe("A text entry or FAQ the receptionist answers from.");

export const apiKnowledgeEntryUpdateSchema = z.strictObject({
  title: z.string().trim().min(1).max(300).optional().describe("The entry's title, or an FAQ's question."),
  content: z.string().trim().min(1).max(20_000).optional().describe("The entry's text, or an FAQ's answer."),
  tags: z.array(z.string().trim().min(1).max(255)).max(100).optional().describe("Replaces the entry's labels. faq is reserved, because it marks an FAQ, so it is ignored here: an entry keeps its type."),
  priority: z.number().int().min(-100).max(100).optional(),
  active: z.boolean().optional().describe("false stops the receptionist answering from the entry without deleting it."),
});

// Zod 4 reports an unknown type as "Invalid discriminator value. ..."; keep the v1 detail message "Invalid input".
export const apiKnowledgeEntryCreateSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("text"), title: z.string().trim().min(1).max(300), content: z.string().trim().min(1).max(20_000) }),
  z.strictObject({ type: z.literal("faq"), question: z.string().trim().min(1).max(300), answer: z.string().trim().min(1).max(20_000) }),
], { error: (issue) => (issue.code === "invalid_union" ? "Invalid input" : undefined) });

export const apiKnowledgeSourceSchema = z.object({
  id,
  type: z.enum(["website", "page", "file"]).describe("website: a site added as a source, whose crawl reads its pages. page: one page a crawl read, or a site that has no crawl of its own. file: an uploaded document."),
  title: z.string(),
  url: z.string().nullable().describe("The website's or page's address. Null for a file."),
  status: z.enum(["pending", "processing", "indexed", "error", "cancelled"]).describe("pending: a file waits its turn. processing: it is being read. indexed: the receptionist can use it. error or cancelled: reading stopped."),
  error: z.string().nullable().describe("Why reading failed, when status is error."),
  active: z.boolean().describe("Whether the receptionist answers from it. An inactive source stays indexed but unused."),
  page_limit: z.number().int().nullable().describe("How many pages a website's crawl reads: a sample at first, the full site after POST /knowledge/sources/{source_id}/expand. Null for a page or a file."),
  created_at: timestamp,
  updated_at: timestamp,
}).describe("A website, page or file the receptionist learns from.");

export const apiKnowledgeSourceUpdateSchema = z.strictObject({
  active: z.boolean().describe("false stops the receptionist answering from the source without deleting it."),
});

export const apiKnowledgeSourceCreateSchema = z.strictObject({
  type: z.literal("website"),
  url: z.string().trim().min(1).max(2_000).describe("The site to read, such as https://example.com. A site that is already a source returns that source."),
});

export const knowledgeUploadContentTypes = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
  "text/markdown",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/tiff",
] as const;

export const apiKnowledgeUploadCreateSchema = z.strictObject({
  file_name: z.string().trim().min(1).max(255).regex(/[^.]/, "Use the file's name, such as prices.pdf.").describe("The file's name, such as prices.pdf."),
  content_type: z.enum(knowledgeUploadContentTypes).describe("PDF, Word (DOCX), plain text, Markdown, or a JPEG, PNG, WebP or TIFF image."),
  length: z.number().int().positive().max(KNOWLEDGE_UPLOAD_MAX_BYTES).describe("The file's size in bytes, up to 10 MB."),
  checksum_sha256: z.string().regex(/^[A-Za-z0-9+/]{43}=$/, "Use the base64 SHA-256 of the file.").describe("The base64-encoded SHA-256 of the file's bytes."),
});

export const apiKnowledgeUploadSchema = z.object({
  upload_id: id,
  upload_url: z.string().describe("Send the file's bytes here with PUT."),
  upload_headers: z.record(z.string(), z.string()).describe("Send exactly these headers with the PUT."),
  expires_at: nullableTimestamp.describe("When upload_url stops working, about 15 minutes after it was made."),
}).describe("Where to send a file before completing its upload.");

export const apiKnowledgeUploadCompleteSchema = z.strictObject({
  title: z.string().trim().min(1).max(1_000).optional().describe("Defaults to the file name."),
  tags: z.array(z.string().trim().min(1).max(255)).max(100).optional(),
});

export const apiWebhookEventTypeSchema = z.enum(webhookEventTypes);

export const apiWebhookEndpointSchema = z.object({
  id,
  url: z.string(),
  description: z.string().nullable(),
  events: z.array(apiWebhookEventTypeSchema),
  status: z.enum(["enabled", "disabled"]),
  disabled_reason: z.enum(["manual", "failing"]).nullable(),
  created_at: timestamp,
  updated_at: timestamp,
});

export const apiWebhookEndpointWithSecretSchema = apiWebhookEndpointSchema.extend({
  secret: z.string().describe("Signing secret (whsec_...). Returned only when the endpoint is created."),
});

const webhookUrl = z.url().max(2_000).describe("HTTPS URL that receives events.");

export const apiWebhookEndpointCreateSchema = z.strictObject({
  url: webhookUrl,
  events: z.array(apiWebhookEventTypeSchema).min(1),
  description: z.string().trim().max(200).optional(),
});

export const apiWebhookEndpointUpdateSchema = z.strictObject({
  url: webhookUrl.optional(),
  events: z.array(apiWebhookEventTypeSchema).min(1).optional(),
  description: z.string().trim().max(200).nullable().optional(),
  status: z.enum(["enabled", "disabled"]).optional(),
});

export const apiWebhookTestResultSchema = z.object({
  event_id: id,
  delivery_id: id,
});

export const apiDeletedSchema = z.object({ id, deleted: z.literal(true) });

function eventEnvelope<T extends z.ZodType>(type: string, data: T) {
  return z.object({
    id: id.describe("Event id. Also sent as the webhook-id header; use it to ignore duplicates."),
    type: z.literal(type),
    api_version: z.literal(PUBLIC_API_VERSION),
    created_at: timestamp,
    business_id: id,
    data,
  });
}

export const apiWebhookEventSchemas = {
  "call.completed": eventEnvelope("call.completed", apiCallSchema),
  "appointment.booked": eventEnvelope("appointment.booked", apiAppointmentSchema),
  "appointment.rescheduled": eventEnvelope("appointment.rescheduled", apiAppointmentSchema),
  "appointment.cancelled": eventEnvelope("appointment.cancelled", apiAppointmentSchema),
  "message.taken": eventEnvelope("message.taken", apiMessageSchema),
  "contact.created": eventEnvelope("contact.created", apiContactSchema),
} as const;

export const apiWebhookTestEventSchema = eventEnvelope(WEBHOOK_TEST_EVENT_TYPE, z.object({ endpoint_id: id, message: z.string() }));

export type ApiMe = z.infer<typeof apiMeSchema>;
export type ApiBusiness = z.infer<typeof apiBusinessSchema>;
export type ApiBusinessUpdate = z.infer<typeof apiBusinessUpdateSchema>;
export type ApiBusinessCreate = z.infer<typeof apiBusinessCreateSchema>;
export type ApiBusinessSummary = z.infer<typeof apiBusinessSummarySchema>;
export type ApiHoursWindow = z.infer<typeof apiHoursWindowSchema>;
export type ApiReceptionist = z.infer<typeof apiReceptionistSchema>;
export type ApiReceptionistUpdate = z.infer<typeof apiReceptionistUpdateSchema>;
export type ApiRule = z.infer<typeof apiRuleSchema>;
export type ApiRuleCreate = z.infer<typeof apiRuleCreateSchema>;
export type ApiRuleUpdate = z.infer<typeof apiRuleUpdateSchema>;
export type ApiRuleReorder = z.infer<typeof apiRuleReorderSchema>;
export type ApiService = z.infer<typeof apiServiceSchema>;
export type ApiServiceCreate = z.infer<typeof apiServiceCreateSchema>;
export type ApiServiceUpdate = z.infer<typeof apiServiceUpdateSchema>;
export type ApiStaff = z.infer<typeof apiStaffSchema>;
export type ApiCall = z.infer<typeof apiCallSchema>;
export type ApiCallDetail = z.infer<typeof apiCallDetailSchema>;
export type ApiContact = z.infer<typeof apiContactSchema>;
export type ApiContactCreate = z.infer<typeof apiContactCreateSchema>;
export type ApiContactUpdate = z.infer<typeof apiContactUpdateSchema>;
export type ApiAppointment = z.infer<typeof apiAppointmentSchema>;
export type ApiAppointmentCreate = z.infer<typeof apiAppointmentCreateSchema>;
export type ApiAvailabilitySlot = z.infer<typeof apiAvailabilitySlotSchema>;
export type ApiMessage = z.infer<typeof apiMessageSchema>;
export type ApiKnowledgeEntry = z.infer<typeof apiKnowledgeEntrySchema>;
export type ApiKnowledgeEntryCreate = z.infer<typeof apiKnowledgeEntryCreateSchema>;
export type ApiKnowledgeEntryUpdate = z.infer<typeof apiKnowledgeEntryUpdateSchema>;
export type ApiKnowledgeSource = z.infer<typeof apiKnowledgeSourceSchema>;
export type ApiKnowledgeSourceCreate = z.infer<typeof apiKnowledgeSourceCreateSchema>;
export type ApiKnowledgeSourceUpdate = z.infer<typeof apiKnowledgeSourceUpdateSchema>;
export type ApiKnowledgeUpload = z.infer<typeof apiKnowledgeUploadSchema>;
export type ApiKnowledgeUploadCreate = z.infer<typeof apiKnowledgeUploadCreateSchema>;
export type ApiKnowledgeUploadComplete = z.infer<typeof apiKnowledgeUploadCompleteSchema>;
export type ApiWebhookEndpoint = z.infer<typeof apiWebhookEndpointSchema>;
export type ApiWebhookEndpointCreate = z.infer<typeof apiWebhookEndpointCreateSchema>;
export type ApiWebhookEndpointUpdate = z.infer<typeof apiWebhookEndpointUpdateSchema>;
export type ApiWebhookEventPayload = {
  id: string;
  type: string;
  api_version: typeof PUBLIC_API_VERSION;
  created_at: string;
  business_id: string;
  data: Record<string, unknown>;
};

/** The v1 list envelope around one resource schema: `{ data, next_cursor, has_more }`. */
export function apiPageSchema<T extends z.ZodType>(item: T) {
  return z.object({
    data: z.array(item),
    next_cursor: z.string().nullable().describe("Pass as cursor to get the next page. Null on the last page."),
    has_more: z.boolean(),
  });
}

/** Parses a request body; returns field-level problems instead of throwing. */
export function parseApiInput<T>(schema: z.ZodType<T>, value: unknown): { ok: true; data: T } | { ok: false; details: Array<{ path: string; message: string }> } {
  const result = schema.safeParse(value);
  if (result.success) return { ok: true, data: result.data };
  return { ok: false, details: result.error.issues.map((issue) => ({ path: issue.path.map(String).join(".") || "(body)", message: issue.message })) };
}
