import { z } from "zod";

import { billingPlanSlugs, cloudBillingPlanSlugs, type PolarEnv } from "../billing";
import { billingPlanAccessLevels, billingPlanEndings, billingPlanTiers, billingProfileSchema } from "../billingProfile";
import { interfaceLocales } from "../locales";
import { PUBLIC_PROFILE_LIMITS, publicProfileTextFields } from "../publicProfile";
import { appointmentChangeVerificationModes, bookingModes, CONTACT_PASSCODE_DEFAULT_LENGTH, CONTACT_PASSCODE_LOCK_ATTEMPTS, CONTACT_PASSCODE_MAX_LENGTH, CONTACT_PASSCODE_MIN_LENGTH, isContactPasscode, isGuessableContactPasscode, RECEPTIONIST_INSTRUCTIONS_MAX_LENGTH, RECEPTIONIST_TEXT_MAX_LENGTH, RULE_CONTENT_CALL_MAX_LENGTH, RULE_TITLE_MAX_LENGTH, RULES_MAX, transferModes } from "../receptionist";
import { widgetPositions } from "../widget";
import { CONTACT_PASSCODES_MAX_PER_REQUEST, KNOWLEDGE_UPLOAD_MAX_BYTES, PUBLIC_API_VERSION, WEBHOOK_TEST_EVENT_TYPE, apiKeyScopes, webhookEventTypes, weekdays } from "./constants";

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
    details: z.array(z.object({ path: z.string(), message: z.string(), code: z.string().optional().describe("Why, where an error has more than one reason, such as each refusal of a billing catalog apply.") })).optional(),
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

const businessHoursSources = ["none", "generated", "operator"] as const;
const onboardingStages = ["create_business", "website", "knowledge", "greeting", "plan", "phone_number", "phone_number_claiming", "attribution", "complete"] as const;

export const apiBusinessSchema = z.object({
  id,
  name: z.string(),
  slug: z.string().describe("A short name no other business uses, set when the business is created. Its public profile page is at /profile/{slug}."),
  timezone: z.string().describe("IANA time zone, for example America/Toronto."),
  locale: z.string().describe("Default language for callers: en or fr."),
  website_url: z.string().nullable(),
  business_type: z.string().describe("What kind of business it is. The dashboard uses service_company."),
  onboarding_stage: z.enum(onboardingStages).describe("The step the dashboard's onboarding shows, the same as stage in GET /onboarding. complete: onboarding is finished."),
  booking_mode: z.enum(bookingModes).describe("instant: appointments are booked directly. request: the receptionist takes a request and the team confirms it. off: no booking."),
  hours: z.array(apiHoursWindowSchema),
  hours_source: z.enum(businessHoursSources).describe("Who set the hours. operator: a person, in the dashboard or with PATCH /business, and AI leaves them alone. generated: AI found them in the business's knowledge, and updates them when that knowledge changes. none: not recorded. AI fills in hours it finds only while the business has none."),
  ai_traces_enabled: z.boolean().describe("Whether each AI turn on calls and website chats keeps a debug trace, read with GET /ai-traces. Off by default."),
  created_at: timestamp,
  updated_at: timestamp,
});

export const apiBusinessUpdateSchema = z.strictObject({
  name: z.string().trim().min(1).max(200).optional(),
  timezone: z.string().trim().min(1).max(80).optional(),
  locale: locale.optional(),
  website_url: z.url().max(2_000).nullable().optional(),
  business_type: z.string().trim().min(1).max(64).optional().describe("What kind of business it is."),
  hours: z.array(apiHoursWindowSchema).max(28).optional().describe("Replaces the whole week. Omit a day to close it. Send two windows for a day with a break. Windows on the same day can't overlap. The hours then count as a person's, with hours_source operator, so AI stops changing them."),
  ai_traces_enabled: z.boolean().optional().describe("true keeps a debug trace of each AI turn from now on, for the ai_traces retention period. Traces hold what callers and visitors said. false stops new ones; existing ones expire as usual."),
});

const appointmentChangePolicyFields = {
  enabled: z.boolean().describe("Whether callers can change their own appointments with the receptionist."),
  allow_cancel: z.boolean(),
  allow_reschedule: z.boolean(),
  verification_mode: z.enum(appointmentChangeVerificationModes).describe("How a caller proves an appointment is theirs. phone_match_and_facts: their phone number and details of the booking. otp_required: a code sent by text. passcode_required: a PIN they type on the phone keypad, set on their contact in the dashboard. operator_only: the team makes the change."),
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

const checkoutPlans = ["starter", "pro"] as const;
const billingIntervals = ["monthly", "annual"] as const;

export const apiBillingSchema = z.object({
  plan: z.enum(billingPlanSlugs).describe("The plan in force now. A Starter or Pro subscription that lapsed reads as free_cloud."),
  promo_plan: z.string().nullable().describe("The code of the promo plan in force, which behaves as plan with its own allowances, limits and overage rates. Null on a standard plan."),
  plan_ends: nullableTimestamp.describe("When a promo plan that lasts a set number of months ends: it ends at the subscription's first renewal from then on. Null otherwise."),
  plan_ends_with: z.enum(["tier", "cancel"]).nullable().describe("What that renewal does: tier moves the subscription to the plan's tier at its standard price, cancel ends it. Null when plan_ends is."),
  managed: z.boolean().describe("true when the deployment's operator runs the plan outside Polar and bills the business directly."),
  subscription_state: z.string().nullable().describe("The subscription's state, such as active, trialing, past_due or canceled. Null without a subscription."),
  billing_interval: z.enum(billingIntervals).nullable().describe("Null unless the plan is Starter or Pro."),
  current_period_end: nullableTimestamp.describe("When the paid period ends. Null unless the plan is Starter or Pro."),
  spending_cap_cents: z.number().int().nullable().describe("The most a Starter or Pro plan spends on usage over its allowance each month. Null means no cap, and is always null on other plans."),
  overage_spend_cents: z.number().int().describe("Usage over the allowance this month."),
  spending_cap_reached: z.boolean().describe("true once this month's overage reached the cap, which stops further billable usage."),
}).describe("The business's plan and what it spends.");

export const apiBillingUpdateSchema = z.strictObject({
  spending_cap_cents: z.number().int().min(0).nullable().describe("Cents. null removes the cap. Only Starter and Pro plans have one."),
});

export const apiCheckoutCreateSchema = z.strictObject({
  plan: z.enum([...checkoutPlans, "promo"]).describe("starter or pro, or promo for the plan promo_code unlocks."),
  interval: z.enum(billingIntervals),
  promo_code: z.string().min(1).max(64).optional().describe("A promo code the deployment's operator issued, compared regardless of case and spaces. Required with plan promo, and only allowed with it."),
}).superRefine((value, context) => {
  if ((value.plan === "promo") === (value.promo_code !== undefined)) return;
  context.addIssue({ code: "custom", path: ["promo_code"], message: value.plan === "promo" ? "Required when plan is promo." : "Only allowed when plan is promo." });
});

export const apiCheckoutSchema = z.object({
  id,
  plan: z.enum(checkoutPlans),
  interval: z.enum(billingIntervals),
  status: z.enum(["pending", "processing", "ready", "changed", "error"]).describe("pending or processing: Polar is making the page. ready: checkout_url is set. changed: the business already paid for a plan, so Polar moved that subscription to this plan with no page, charging any difference to the saved payment method; paid turns true once Polar confirms it. error: Polar made no page or change; error says why, and another checkout can be started."),
  promo_plan: z.string().nullable().describe("The plan a promo code unlocked, whose tier plan names. Null for a standard plan."),
  checkout_url: z.string().nullable().describe("The Polar page where the customer pays. Send it to them. Null unless status is ready."),
  error: z.string().nullable(),
  paid: z.boolean().describe("true once the business is on the plan bought here."),
  created_at: timestamp,
  updated_at: timestamp,
}).describe("A Polar checkout for a plan.");

export const apiManagedPlanCreateSchema = z.strictObject({
  plan: z.literal("enterprise"),
});

// The billing catalog: every plan of a brand's billing.json, standard or not,
// as migration 0108's tables hold it. The fields carry the columns' own names.

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/).describe("SHA-256 as 64 lowercase hex characters.");
const nullableCount = z.number().int().nullable();

// The first six stop an apply, catalog_changed and brand_mismatch a link too, and the rest only a link.
export const billingCatalogRefusalCodes = ["brand_mismatch", "file_not_deployed", "catalog_changed", "plan_frozen", "currency_locked", "code_taken", "polar_org_mismatch", "polar_org_changed", "links_incomplete", "unknown_price", "terms_changed", "discount_mismatch", "id_taken", "id_changed"] as const;
export type BillingCatalogRefusalCode = (typeof billingCatalogRefusalCodes)[number];

export const apiBillingCatalogApplySchema = z.strictObject({
  brand: z.string().min(1).max(64).describe("The brand whose file this is. It must be the brand this deployment shows."),
  billing_file: billingProfileSchema.describe("The contents of brands/<brand>/billing.json, as written."),
  replaces_hash: sha256Hex.nullable().optional().describe("Apply only if the latest catalog run has this hash, so an apply by someone else in between stops this one. null: only if nothing was applied yet."),
  allow_undeployed: z.boolean().optional().describe("true applies a file whose hash differs from the one the running code was built with, as on a sandbox. Defaults to false."),
  dry_run: z.boolean().optional().describe("true shows what the apply would change and anything that would stop it, and changes nothing. Defaults to false."),
});

export const billingPolarEnvs = ["sandbox", "production"] as const satisfies ReadonlyArray<PolarEnv>;
const polarObjectId = z.string().min(1).max(100);

export const apiBillingCatalogLinkSchema = z.strictObject({
  brand: z.string().min(1).max(64).describe("The brand whose file Polar was set up from. It must be the brand this deployment shows."),
  hash: sha256Hex.describe("The hash of the file Polar was set up from. It must be the latest catalog run's."),
  polar_env: z.enum(billingPolarEnvs).describe("The Polar server the products are on. It must be the one this deployment's POLAR_API_BASE_URL names."),
  polar_org: polarObjectId.describe("The Polar organization the products are in. It must be this deployment's POLAR_ORGANIZATION_ID, and the one every earlier link named."),
  plans: z.array(z.strictObject({
    code: z.string().min(1).max(64).describe("A sold plan that isn't retired."),
    terms_hash: sha256Hex.describe("The plan's terms_hash its Polar objects were made from. It must be the row's."),
    polar_disc: polarObjectId.nullable().describe("The Polar discount for a plan with a discount; null for any other plan."),
    prices: z.array(z.strictObject({
      period: z.enum(["monthly", "annual"]),
      currency: z.string().regex(/^[a-z]{3}$/),
      polar_id: polarObjectId.describe("The Polar product that sells this price."),
    })).min(1).max(2).describe("Every live price of the plan."),
  })).max(60).describe("Every sold plan that isn't retired, each with every live price."),
  replace_ids: z.boolean().optional().describe("true lets a live price or a plan that already has a Polar product or discount take another one: the old price row is retired with its product, and a new live row takes the new one. Defaults to false."),
  dry_run: z.boolean().optional().describe("true shows what the link would change and anything that would stop it, and changes nothing. Defaults to false."),
});

export const billingCheckCodes = ["catalog_hash", "code_hash", "plan_rows", "not_linked", "org_settings", "meter", "credits", "product", "discount", "webhook", "leftover", "linked_id", "retired_id", "polar_org", "webhook_secret", "product_vars", "unreadable"] as const;
export type BillingCheckCode = (typeof billingCheckCodes)[number];
export const billingCheckPairs = ["file_postgres", "file_polar", "postgres_polar"] as const;
export type BillingCheckPair = (typeof billingCheckPairs)[number];

export const apiBillingCheckSchema = z.object({
  code: z.enum(billingCheckCodes).describe("Which check found it."),
  pair: z.enum(billingCheckPairs).describe("The two copies it compared: the repository file, the Postgres tables and Polar."),
  level: z.enum(["drift", "warn", "info"]).describe("drift fails a verify; warn and info don't."),
  subject: z.string().describe("What it is about, such as a plan, a price or a Polar object."),
  message: z.string(),
}).describe("Something a verify found that isn't as the file says.");

export const apiBillingCatalogChangeSchema = z.object({
  table: z.enum(["billing_plans", "billing_prices"]),
  key: z.string().describe("A plan's code, or code/period/currency for a price."),
  action: z.enum(["insert", "update", "retire", "restore"]),
  fields: z.record(z.string(), z.object({ from: z.unknown(), to: z.unknown() })).describe("For update and restore, each changed column with its old and new value. Empty otherwise."),
  lowers_allowance: z.boolean().describe("An included amount, the storage limit or the number count goes down."),
  raises_price: z.boolean().describe("A price or an overage rate goes up."),
}).describe("One row an apply writes.");

export const apiBillingCatalogRefusalSchema = z.object({
  code: z.enum(billingCatalogRefusalCodes),
  message: z.string(),
  path: z.string().describe("The request field it is about, such as billing_file.plans.pro-launch."),
}).describe("Something that stops an apply or a link.");

export const apiBillingCatalogRunSchema = z.object({
  id: id.nullable().describe("Null for a dry run, which stores nothing."),
  kind: z.enum(["catalog", "polar", "verify"]).describe("catalog: an apply. polar: a link of Polar's products. verify: the worker's daily check."),
  status: z.enum(["applied", "unchanged", "failed", "passed", "drift", "preview"]).describe("applied or unchanged for an apply or a link; passed, drift or failed for a verify; preview for a dry run."),
  brand: z.string(),
  ver: z.number().int().describe("The file's version."),
  hash: sha256Hex.describe("SHA-256 of the normalized file."),
  prev_hash: sha256Hex.nullable().describe("The previous run of the same kind's hash. Null on the first."),
  code_hash: sha256Hex.nullable().describe("The file hash the running code was built with. Null when the brand has no billing.json in it."),
  changes: z.array(apiBillingCatalogChangeSchema).describe("Every row written, plans then prices, each by key."),
  problems: z.array(apiBillingCheckSchema).describe("Every check a verify found not ok. Always empty for an apply or a link."),
  blocked_by: z.array(apiBillingCatalogRefusalSchema).describe("For a dry run, everything that would stop the apply; empty means it would go through. Always empty for a stored run."),
  polar_env: z.enum(["sandbox", "production"]).nullable(),
  polar_org: z.string().nullable(),
  key_id: id.nullable().describe("The operator platform key that asked."),
  partner: z.string().nullable().describe("That key's partner."),
  started_at: timestamp,
  ended_at: nullableTimestamp,
}).describe("One apply of a billing.json, one link of Polar's products, one verify, or the dry run of an apply or a link.");

export const billingCodeStatuses = ["active", "expired", "used_up", "revoked"] as const;

export const apiBillingCodeSchema = z.object({
  id,
  code: z.string().describe("What people type, in upper case. It is compared regardless of case and spaces."),
  plan: z.string().describe("The plan it unlocks: a billing.json plan whose access is code."),
  business_id: id.nullable().describe("The one business that may use it. Null for a shared code, which anyone may enter."),
  max_uses: z.number().int().nullable().describe("How many businesses may subscribe with it. Null for no limit, which only a bound code may have."),
  uses: z.number().int().describe("Businesses that subscribed with it. Checkouts opened at the same time can take it past max_uses."),
  expires_at: nullableTimestamp.describe("No new checkout after this. Null for no end, which only a bound code may have."),
  status: z.enum(billingCodeStatuses).describe("active: it works. expired, used_up or revoked: it doesn't, and whoever enters it reads only that it isn't valid. Businesses already on its plan keep it."),
  note: z.string().nullable(),
  link: z.string().describe("The sign-up page with the code filled in, to send to whoever will use it. Someone already signed in goes on to Settings > Plan with it."),
  key_id: id.describe("The operator platform key that issued it."),
  partner: z.string().describe("That key's partner."),
  created_at: timestamp,
  revoked_at: nullableTimestamp,
}).describe("A promo code that unlocks a plan whose access is code.");

export const apiBillingCodeCreateSchema = z.strictObject({
  plan: z.string().min(3).max(48).describe("The plan it unlocks, by its billing.json code. Its access must be code, and it must not be retired. A plan that isn't on sale yet takes codes, which work once it is."),
  code: z.string().min(4).max(64).optional().describe("The code itself, such as SPRING25: 4 to 32 letters and digits, groups joined by single hyphens, stored in upper case. Left out, one is made up, such as ALLO-7K2Q-PX9M."),
  prefix: z.string().regex(/^[A-Za-z0-9]{2,8}$/).optional().describe("For a made-up code, its first group. Defaults to the first four letters of the brand's name. Not with code."),
  business_id: id.optional().describe("Bind it to one business, which then is the only one that can use it."),
  max_uses: z.number().int().min(1).max(100_000).optional().describe("How many businesses may subscribe with it. Required for a shared code. A bound code defaults to 1."),
  expires_at: z.iso.datetime({ offset: true }).optional().describe("No new checkout after this. Required for a shared code, and in the future."),
  note: z.string().trim().max(200).optional().describe("Who it is for or why, for the operator's own records."),
}).superRefine((value, context) => {
  if (value.code !== undefined && value.prefix !== undefined) context.addIssue({ code: "custom", path: ["prefix"], message: "Send code or prefix, not both." });
  if (value.business_id !== undefined) return;
  // A code anyone may enter needs a use limit and an end, so a leaked one can't run forever.
  if (value.max_uses === undefined) context.addIssue({ code: "custom", path: ["max_uses"], message: "Required for a shared code." });
  if (value.expires_at === undefined) context.addIssue({ code: "custom", path: ["expires_at"], message: "Required for a shared code." });
});

export const apiBillingCatalogPriceSchema = z.object({
  id,
  period: z.enum(["monthly", "annual"]),
  currency: z.string(),
  cents: z.number().int().describe("The price for one period."),
  per_month: z.number().int().describe("cents for monthly, cents / 12 rounded down for annual."),
  polar_id: z.string().nullable().describe("The Polar product that sells it, once Polar is seeded."),
  retired_at: nullableTimestamp.describe("When it stopped being sold. Null for a live price."),
  created_at: timestamp,
  updated_at: timestamp,
});

export const apiBillingCatalogPlanSchema = z.object({
  code: z.string().describe("The plan's permanent code, its key in billing.json."),
  tier: z.enum(billingPlanTiers).describe("The built-in tier the code treats it as. Equals code for the four standard plans."),
  status: z.enum(["draft", "active", "retired"]).describe("draft until Polar can sell it as defined, active, or retired."),
  access: z.enum(billingPlanAccessLevels).describe("public, code (promo code only) or hidden (operator only)."),
  sold: z.boolean(),
  custom: z.boolean(),
  overage: z.boolean(),
  src: z.enum(["file", "api"]),
  names: z.record(z.string(), z.string()).nullable().describe("Display names by language. Null for standard plans."),
  voice_sec: nullableCount.describe("Voice seconds included a month."),
  sms_seg: nullableCount.describe("Alert SMS segments included a month."),
  calls_out: nullableCount.describe("Outbound call attempts included a month."),
  chat_units: nullableCount.describe("Website chat AI units included a month."),
  kb_bytes: nullableCount.describe("Knowledge storage limit in bytes."),
  numbers: nullableCount.describe("Business phone numbers included."),
  voice_rate: nullableCount.describe("Overage cents per voice minute."),
  sms_rate: nullableCount.describe("Overage cents per alert SMS segment."),
  call_rate: nullableCount.describe("Overage cents per outbound call attempt."),
  months: nullableCount.describe("How many months the plan lasts; null means no end."),
  ends: z.enum(billingPlanEndings).nullable(),
  offer_end: nullableTimestamp,
  discount: z.record(z.string(), z.unknown()).nullable(),
  polar_disc: z.string().nullable(),
  terms_hash: sha256Hex,
  frozen_at: nullableTimestamp,
  sort: z.number().int(),
  retired_at: nullableTimestamp,
  created_at: timestamp,
  updated_at: timestamp,
  prices: z.array(apiBillingCatalogPriceSchema).describe("Every price of the plan, live ones first."),
});

export const apiBillingCatalogPolarSchema = z.object({
  env: z.enum(billingPolarEnvs).describe("The Polar server this deployment uses: sandbox when POLAR_API_BASE_URL names sandbox-api.polar.sh, else production."),
  org: z.string().nullable().describe("POLAR_ORGANIZATION_ID. Null when unset."),
  secret_sha256: sha256Hex.nullable().describe("SHA-256 of POLAR_WEBHOOK_SECRET, never the secret, so a check can compare it with Polar's. Null when unset."),
  product_vars: z.record(z.string(), z.string().nullable()).describe("The four optional POLAR_<PLAN>_<INTERVAL>_PRODUCT_ID values, by plan/period, such as starter/monthly. Checkout reads one only before its plan's first link; after that they aren't needed. Null when unset."),
  last_link: apiBillingCatalogRunSchema.nullable().describe("The latest link. Null before the first."),
}).describe("The Polar settings this deployment runs with.");

export const apiBillingCatalogSchema = z.object({
  brand: z.string().describe("The brand this deployment shows."),
  code_hash: sha256Hex.nullable().describe("The hash of the brand's billing.json in the running code. Null when it has none."),
  hash: sha256Hex.nullable().describe("The latest catalog run's hash. Null before the first apply."),
  matches_code: z.boolean().describe("Both hashes are set and equal. false after a deploy that changed the file means it's time to apply it."),
  last_run: apiBillingCatalogRunSchema.nullable(),
  profile: z.record(z.string(), z.unknown()).nullable().describe("The latest applied file, normalized, in its own camel case."),
  currency: z.string().nullable().describe("The live prices' currency."),
  plans: z.array(apiBillingCatalogPlanSchema).describe("Every plan, whatever its access or status, by sort then code."),
  polar: apiBillingCatalogPolarSchema,
}).describe("The plans and prices this deployment holds. Checkout, plan changes, Polar's webhook, the plan screens and usage limits read them.");

export const apiBillingPlanPriceSchema = z.object({
  interval: z.enum(billingIntervals),
  currency: z.string().describe("Three lowercase letters, such as cad."),
  amount_cents: z.number().int().describe("The price for one period."),
  monthly_amount_cents: z.number().int().describe("amount_cents for monthly, amount_cents / 12 rounded down for annual."),
  checkout_available: z.boolean().describe("true when POST /billing/checkout can sell it here: Polar is set up and one of its products sells this price."),
});

export const apiBillingPlanSchema = z.object({
  slug: z.enum(cloudBillingPlanSlugs),
  custom: z.boolean().describe("Priced by agreement, with no fixed allowances."),
  overage_billable: z.boolean().describe("Usage past the allowance is billed rather than blocked."),
  included: z.object({
    voice_seconds: nullableCount.describe("Voice seconds included a month."),
    alert_sms_segments: nullableCount.describe("Alert SMS segments included a month."),
    outbound_call_attempts: nullableCount.describe("Outbound call attempts (transfers) included a month."),
    chat_ai_units: nullableCount.describe("Website chat AI units included a month."),
    knowledge_storage_bytes: nullableCount.describe("Knowledge storage limit in bytes."),
    business_numbers: nullableCount.describe("Business phone numbers included."),
  }).describe("What the plan includes. Null means custom."),
  overage_rates: z.object({
    voice_minute_cents: nullableCount,
    alert_sms_segment_cents: nullableCount,
    outbound_call_attempt_cents: nullableCount,
  }).describe("Cents for each unit past the allowance, in the plans' currency. Null where usage past it is blocked or priced by agreement."),
  sort: z.number().int().describe("The order plan cards show them in."),
  prices: z.array(apiBillingPlanPriceSchema).describe("Empty for a plan Polar doesn't sell, such as free_cloud and enterprise."),
});

export const apiBillingPlansSchema = z.object({
  currency: z.string().describe("The prices' currency, three lowercase letters."),
  source: z.enum(["catalog", "built_in"]).describe("catalog once the deployment applied a billing.json; built_in before that: the plans the running code ships with, in US dollars."),
  plans: z.array(apiBillingPlanSchema).describe("Free, Starter, Pro and Enterprise, by sort."),
}).describe("The standard plans this deployment offers, with their allowances and prices.");

const phoneNumberCountries = ["US", "CA", "GB", "AU"] as const;
const phoneNumberKinds = ["local", "toll_free"] as const;

export const apiPhoneNumberSchema = z.object({
  id,
  phone_number: e164,
  status: z.enum(["active", "releasing", "released"]).describe("active: calls and texts to the number reach the receptionist, even while a release is scheduled. releasing: the number is being given back to the carrier. released: the business no longer has it."),
  release_scheduled_at: nullableTimestamp.describe("When an active number is released: when DELETE asked for it, or 30 days after a replacement went live. Null when no release is planned."),
  created_at: timestamp,
  updated_at: timestamp,
}).describe("A phone number the business has or had.");

export const apiPhoneNumberSearchSchema = z.strictObject({
  country: z.enum(phoneNumberCountries).optional().describe("Defaults to the country of the business's time zone, or US."),
  kind: z.enum(phoneNumberKinds).optional().describe("Defaults to local."),
  area_code: z.string().trim().regex(/^\d{1,6}$/, "Use digits only.").optional(),
  city: z.string().trim().min(1).max(100).optional(),
  region: z.string().trim().min(1).max(64).optional().describe("A state or province, such as ON or NY."),
  postal_code: z.string().trim().min(1).max(16).optional(),
  limit: z.number().int().min(1).max(20).optional().describe("How many offers to return. Defaults to 10."),
  replaces: z.uuid().optional().describe("The id of an active number to replace. The offers are then replacements, which only POST /phone-numbers/{phone_number_id}/replace accepts."),
});

export const apiPhoneNumberOfferSchema = z.object({
  phone_number: e164,
  country: z.enum(phoneNumberCountries),
  kind: z.enum(phoneNumberKinds),
  locality: z.string().nullable().describe("The city or area the number belongs to, when the carrier says."),
  region: z.string().nullable(),
  capabilities: z.object({ voice: z.boolean(), sms: z.boolean() }),
  offer_token: z.string().describe("Claim the number with this before expires_at. Only this business, and the account the key acts as, can use it."),
  expires_at: timestamp,
}).describe("A number the business can claim.");

export const apiPhoneNumberClaimCreateSchema = z.strictObject({
  offer_token: z.string().min(1).max(4_000).describe("An offer_token from POST /phone-numbers/search."),
});

export const apiPhoneNumberClaimSchema = z.object({
  id,
  status: z.enum(["pending", "provisioning", "claimed", "failed"]).describe("pending: waiting to be bought. provisioning: the number is being bought and connected to the receptionist. claimed: the number is live and phone_number_id names it. failed: error says why; search again for another number."),
  phone_number: e164.describe("The number being claimed."),
  phone_number_id: z.uuid().nullable().describe("The number's id once the claim is claimed."),
  replaces_phone_number_id: z.uuid().nullable().describe("For a replacement, the number it replaces. That number keeps working until 30 days after the new one goes live."),
  error: z.string().nullable(),
  created_at: timestamp,
  updated_at: timestamp,
}).describe("A request to buy a phone number for the business.");

const widgetKeyStatuses = ["active", "disabled", "revoked"] as const;
const widgetOrigins = z.array(z.url({ protocol: /^https?$/ }).max(2_000)).max(50);

export const apiWidgetConfigSchema = z.strictObject({
  color: z.string().regex(/^#[0-9a-fA-F]{3,8}$/, "Use a hex color such as #0f766e.").optional(),
  position: z.enum(widgetPositions).optional(),
  title: z.string().max(160).optional(),
  subtitle: z.string().max(320).optional(),
  greeting: z.string().max(400).optional(),
  locale: z.enum(interfaceLocales).optional().describe("The widget's language: en, fr, es or sr. Left out, it follows the visitor's browser."),
  lead_form: z.strictObject({
    enabled: z.boolean(),
    require_phone: z.boolean().optional(),
    require_email: z.boolean().optional(),
    show_before_chat: z.boolean().optional(),
  }).optional().describe("Asks visitors for their contact details."),
  live_chat: z.strictObject({
    enabled: z.boolean(),
  }).optional().describe("Live chat with the team. During opening hours, a visitor who asks for a person gets someone from the team in the chat, who replies from Messages. If nobody joins within 3 minutes, the receptionist takes a message."),
}).describe("How the widget looks and behaves.");

export const apiWidgetKeySchema = z.object({
  id,
  label: z.string().nullable(),
  status: z.enum(widgetKeyStatuses).describe("active: the widget works. disabled: it stops until it's turned back on. revoked: it stops for good."),
  allowed_origins: z.array(z.string()).describe("The websites the widget runs on, such as https://example.com."),
  config: apiWidgetConfigSchema,
  key: z.string().nullable().describe("The key itself, which the widget's script tag carries. null for a revoked key, and for a key created before keys were stored, which only its creator saw."),
  embed_snippet: z.string().nullable().describe("The script tag to paste into the website's HTML. null when key is null."),
  last_used_at: nullableTimestamp,
  created_at: timestamp,
}).describe("A key that puts the chat widget on the business's websites.");

export const apiWidgetKeyCreatedSchema = apiWidgetKeySchema.extend({
  key: z.string().describe("The key itself, which the widget's script tag carries."),
  embed_snippet: z.string().describe("The script tag to paste into the website's HTML."),
}).describe("A new widget key, with the script tag that adds the widget to a website.");

export const apiWidgetKeyCreateSchema = z.strictObject({
  label: z.string().trim().min(1).max(120).optional(),
  allowed_origins: widgetOrigins.describe("The websites the widget may run on, as full http or https URLs. Only each one's origin is kept."),
  config: apiWidgetConfigSchema.optional(),
});

export const apiWidgetKeyUpdateSchema = z.strictObject({
  label: z.string().trim().min(1).max(120).nullable().optional().describe("null removes the label."),
  allowed_origins: widgetOrigins.optional().describe("Replaces the list."),
  config: apiWidgetConfigSchema.optional().describe("Replaces the whole configuration."),
  status: z.enum(widgetKeyStatuses).optional().describe("A revoked key can't be turned back on."),
});

// The public profile page checks its text as the dashboard does: whitespace
// runs become one space, and an empty value is stored as null.
const profileText = publicProfileTextFields;

export const apiPublicProfileSchema = z.object({
  slug: z.string().describe("The business's slug, the last part of the page's address."),
  url: z.string().describe("The page's address. It answers 404 until the page is published."),
  published: z.boolean().describe("Whether anyone can open the page. Until it's published, only the business's team can preview it, from the dashboard."),
  published_at: nullableTimestamp.describe("When the page was last published. Unpublishing keeps it."),
  category: z.string().nullable().describe("What kind of business it is, shown under its name, such as Dental clinic."),
  description: z.string().nullable().describe("About the business, as plain text with paragraphs."),
  address: z.object({
    line1: z.string().nullable(),
    line2: z.string().nullable(),
    city: z.string().nullable(),
    region: z.string().nullable().describe("Province or state."),
    postal_code: z.string().nullable(),
    country_code: z.string().nullable().describe("Two-letter country code, such as CA."),
  }).describe("The address the page shows. Parts that are null are left out."),
  public_email: z.string().nullable().describe("The email address the page shows."),
  show_phone: z.boolean().describe("Whether the page shows the number callers reach the receptionist on."),
  show_hours: z.boolean().describe("Whether the page shows the opening hours and closures in the next 30 days."),
  show_services: z.boolean().describe("Whether the page lists the active services."),
  show_map: z.boolean().describe("Whether the page shows a map of the address. It needs a street or a city."),
  widget_key_id: z.uuid().nullable().describe("The widget key of the website chat the page opens. null: the page has no chat. While that key is disabled or revoked, the page has no chat either."),
  updated_at: nullableTimestamp.describe("When the settings were last saved. null: they never were, so these are the defaults the dashboard starts from: the receptionist's summary as the description, unless it's still the sign-up placeholder, and the most recently used widget."),
}).describe("The business's public profile page on this deployment, at /profile/{slug}: whether it's published and what it shows.");

export const apiPublicProfileUpdateSchema = z.strictObject({
  published: z.boolean().optional().describe("true publishes the page. false takes it down, and its address answers 404."),
  category: profileText.category.optional().describe(`Up to ${PUBLIC_PROFILE_LIMITS.category} characters. An empty string or null removes it.`),
  description: profileText.description.optional().describe(`Up to ${PUBLIC_PROFILE_LIMITS.description} characters. Paragraphs are kept, with at most one blank line between them. An empty string or null removes it.`),
  address: z.strictObject({
    line1: profileText.address.line1.optional(),
    line2: profileText.address.line2.optional(),
    city: profileText.address.city.optional(),
    region: profileText.address.region.optional(),
    postal_code: profileText.address.postalCode.optional(),
    country_code: profileText.address.countryCode.optional().describe("Two-letter country code, such as CA."),
  }).optional().describe("Changes the parts sent and keeps the rest. An empty string or null removes a part."),
  public_email: profileText.publicEmail.optional().describe("An empty string or null removes it."),
  show_phone: z.boolean().optional(),
  show_hours: z.boolean().optional(),
  show_services: z.boolean().optional(),
  show_map: z.boolean().optional(),
  widget_key_id: z.uuid().nullable().optional().describe("One of the business's active widget keys, which GET /widget-keys lists. null removes the chat from the page."),
});

const calendarStatuses = ["connected", "syncing", "error"] as const;

export const apiCalendarConnectionSchema = z.object({
  id,
  provider: z.string().describe("google: Google Calendar."),
  account_id: z.string().describe("Google's id for the connected account."),
  calendar_id: z.string().nullable().describe("The calendar the receptionist reads busy times from and adds appointments to. null until one is picked with PATCH /calendars/{connection_id}; until then the connection changes nothing."),
  staff_id: id.nullable().describe("The staff member whose calendar this is: its busy times block only them, and their appointments go to it. null: the business's calendar, whose busy times block everyone and which takes the appointments of staff without a calendar of their own."),
  status: z.enum(calendarStatuses).describe("connected: the busy times are up to date. syncing: reading the calendar after a change. error: the last sync failed, and sync_error says why. While a picked calendar is syncing or failing, the staff it covers can't be booked."),
  sync_error: z.string().nullable(),
  last_synced_at: nullableTimestamp,
  created_at: timestamp,
  updated_at: timestamp,
}).describe("A calendar account connected to the business.");

export const apiCalendarConnectionUpdateSchema = z.strictObject({
  calendar_id: z.string().trim().min(1).max(255).optional().describe("A writable calendar from GET /calendars/{connection_id}/calendars. Picking another one reads it again, so the staff it covers can't be booked until that finishes."),
  staff_id: id.nullable().optional().describe("An active staff member from GET /staff, or null for the business's calendar."),
});

export const apiAccountCalendarSchema = z.object({
  id: z.string().describe("Google's id for the calendar. Send it as calendar_id."),
  name: z.string(),
  primary: z.boolean().describe("true for the account's main calendar."),
  writable: z.boolean().describe("true when appointments can be added to it. Only a writable calendar can be picked."),
  selected: z.boolean().describe("true for the calendar the connection uses."),
}).describe("A calendar in a connected account.");

export const apiCalendarConnectLinkSchema = z.object({
  url: z.string().describe("The link to open in a browser. Whoever opens it signs in to the dashboard as an owner or admin of the business, then agrees on Google's page."),
  expires_at: timestamp.describe("The link works until then."),
}).describe("A link that connects a Google Calendar to the business.");

// The alerts the dashboard's notification settings show, by their API names.
const notificationEventDescriptions = {
  voice_message: "A caller left a message during a call.",
  text_message: "A customer texted the business number.",
  customer_sms_failed: "A confirmation or reminder text to a customer failed or wasn't delivered.",
  calendar_sync: "An appointment couldn't sync to the connected calendar.",
  transfer_failed: "The receptionist tried to transfer a caller to a person, and the transfer didn't complete.",
  website_chat: "A visitor wrote through the website chat widget. At most one alert per chat a day.",
  website_live_chat: "A visitor in the website chat asked to talk with a person. Someone on the team has 3 minutes to reply from Messages before the receptionist offers to take a message.",
  webhook_disabled: "Events stopped going to a webhook endpoint after its deliveries failed for about a day.",
} as const;
export type ApiNotificationEvent = keyof typeof notificationEventDescriptions;
export const apiNotificationEvents = Object.keys(notificationEventDescriptions) as ApiNotificationEvent[];

function notificationEventShape<T extends z.ZodType>(channels: T) {
  return Object.fromEntries(apiNotificationEvents.map((event) => [event, channels.describe(notificationEventDescriptions[event])])) as Record<ApiNotificationEvent, T>;
}

const summaryTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, "Use 24-hour HH:MM.").describe("Local time in the business's time zone, as 24-hour HH:MM.");

export const apiNotificationPreferencesSchema = z.object({
  email_enabled: z.boolean().describe("false: no alert emails at all, whatever events says."),
  sms_enabled: z.boolean().describe("false: no alert texts at all, whatever events says."),
  events: z.object(notificationEventShape(z.object({ email: z.boolean(), sms: z.boolean() }))).describe("Which alerts go out by email and which by text."),
  daily_summary: z.object({
    enabled: z.boolean(),
    send_time: summaryTime.nullable().describe("When the summary of the day before goes out."),
  }).describe("A daily summary of the alerts."),
  sms: z.object({
    available: z.boolean().describe("true when texts can be turned on."),
    unavailable_reason: z.enum(["sender_missing", "phone_unverified", "consent_required"]).nullable().describe("sender_missing: the deployment has no number to send alerts from. phone_unverified: the account has no verified mobile number. consent_required: the account hasn't agreed to alert texts. The account's owner fixes the last two in the dashboard's notification settings."),
  }),
}).describe("The alerts the account the key acts as gets about this business. Each person on the team has their own.");

export const apiNotificationPreferencesUpdateSchema = z.strictObject({
  email_enabled: z.boolean().optional(),
  sms_enabled: z.boolean().optional().describe("Texts can be turned on only while sms.available is true."),
  events: z.strictObject(notificationEventShape(z.strictObject({ email: z.boolean().optional(), sms: z.boolean().optional() }).optional())).optional().describe("Only the events and switches sent change."),
  daily_summary: z.strictObject({
    enabled: z.boolean().optional(),
    send_time: summaryTime.nullable().optional(),
  }).optional().describe("A summary that is on needs a send_time."),
});

const memberRoles = ["business_owner", "business_admin", "scheduler", "viewer"] as const;
const invitableRoles = ["business_admin", "scheduler", "viewer"] as const;
const teamEmail = z.string().trim().min(3).max(320);

export const apiTeamMemberSchema = z.object({
  id: id.describe("The membership id."),
  user_id: id,
  name: z.string().nullable(),
  email: z.string(),
  role: z.enum(memberRoles),
  joined_at: timestamp,
}).describe("Someone on the business's team.");

export const apiTeamInvitationSchema = z.object({
  id,
  email: z.string(),
  role: z.enum(memberRoles),
  status: z.enum(["pending", "expired"]).describe("pending: waiting to be accepted. expired: can no longer be accepted; send a new one."),
  transfers_ownership: z.boolean().describe("true for a claim link: accepting it makes the invitee an owner and takes the account that sent it off the team."),
  expires_at: timestamp,
  created_at: timestamp,
}).describe("An invitation nobody has accepted yet.");

export const apiTeamSchema = z.object({
  members: z.array(apiTeamMemberSchema).describe("Everyone on the team, earliest first."),
  invitations: z.array(apiTeamInvitationSchema).describe("Invitations nobody has accepted or revoked, newest first."),
}).describe("The business's team and its open invitations.");

export const apiTeamInvitationCreateSchema = z.strictObject({
  email: teamEmail.describe("One address. Only an account with this verified email can accept."),
  role: z.enum(invitableRoles),
});

export const apiTeamMemberUpdateSchema = z.strictObject({
  role: z.enum(invitableRoles).describe("Ownership changes hands through POST /team/claim-link instead."),
});

export const apiClaimLinkCreateSchema = z.strictObject({
  email: teamEmail.describe("The new owner's email. Only an account with this verified email can claim the business."),
});

export const apiClaimLinkSchema = z.object({
  invitation: apiTeamInvitationSchema,
  url: z.string().describe("The link that claims the business. It is emailed to the new owner; you can also send it yourself."),
}).describe("A link that hands the business over to its owner.");

const onboardingItems = ["business_details", "knowledge", "greeting", "plan", "phone_number", "full_site_read", "test_call"] as const;
const onboardingSkippableSteps = ["knowledge", "phone_number", "full_site_read", "test_call"] as const;

export const apiOnboardingSchema = z.object({
  stage: z.enum(onboardingStages).describe("The step the dashboard's onboarding shows. phone_number_claiming: a number is being set up. The API doesn't follow these steps in order."),
  complete: z.boolean().describe("true once onboarding is finished, so the dashboard opens on the business itself."),
  checklist: z.array(z.object({
    id: z.enum(onboardingItems).describe("business_details: a name and time zone. knowledge: a website or knowledge the receptionist answers from. greeting: a greeting, the default one included; change it with PATCH /receptionist. plan: a paid plan. phone_number: a live number. full_site_read: the whole website read, beyond the first sample, and done when there is no website. test_call: a call the receptionist answered."),
    status: z.enum(["done", "missing", "skipped"]).describe("skipped: left out through PATCH /onboarding or the dashboard's setup guide. A business on the free plan, or self-hosted, shows plan as skipped."),
    required: z.boolean().describe("true when POST /onboarding/complete needs this done or skipped: the business details, and a phone number on a paid plan."),
  })),
  missing: z.array(z.enum(onboardingItems)).describe("Required items neither done nor skipped, and empty once onboarding is complete. POST /onboarding/complete refuses while any is missing; skip_number covers phone_number."),
}).describe("How far the business is in setting up its receptionist.");

export const apiOnboardingUpdateSchema = z.strictObject({
  skip_steps: z.array(z.enum(onboardingSkippableSteps)).max(onboardingSkippableSteps.length).describe("The steps to skip, out of knowledge, phone_number, full_site_read and test_call. The list replaces the one before, so a step left out is no longer skipped."),
});

export const apiOnboardingCompleteSchema = z.strictObject({
  source: z.string().trim().max(120).optional().describe("How the business heard about the service."),
  referral_code: z.string().trim().min(1).max(64).optional().describe("An affiliate's referral code. Not accepted from a platform key, or for a business a partner onboarded."),
  skip_number: z.boolean().optional().describe("true finishes a paid plan's onboarding without a phone number."),
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
  onboarding_stage: z.enum(onboardingStages).describe("The step the dashboard's onboarding shows, the same as stage in GET /onboarding. complete: onboarding is finished."),
  created_at: timestamp,
}).describe("A business the platform key's partner onboarded.");

export const apiUserCreateSchema = z.strictObject({
  email: teamEmail.describe("The person's email. An address that already has an account is a 409."),
  name: z.string().trim().min(1).max(200).optional(),
  locale: z.enum(interfaceLocales).optional().describe("The language of the account's emails and dashboard: en, fr, es or sr. Defaults to en."),
});

export const apiUserSchema = z.object({
  id,
  email: z.string(),
  name: z.string().nullable(),
  locale: z.string().describe("The language of the account's emails and dashboard."),
  email_verified: z.boolean().describe("false until the person sets a password with the code the setup email leads to, which proves the address is theirs. Only a verified account can claim a business."),
  created_at: timestamp,
}).describe("A dashboard account.");

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

// AI debug traces (ADR 0009): what the receptionist's models were given and did.
export const apiAiTraceSchema = z.object({
  id,
  kind: z.enum(["chat_reply", "voice_session", "voice_delegation"]).describe("chat_reply: one website chat reply. voice_session: the instructions a call's voice model started with. voice_delegation: one request the voice model handed to the backend."),
  channel: z.string().describe("web_chat, web_voice or voice."),
  call_id: id.nullable(),
  conversation_id: id.nullable(),
  message_id: id.nullable().describe("The reply message, for a website chat reply."),
  delegation_id: z.string().nullable(),
  model: z.string().nullable(),
  snapshot_version: z.string().nullable().describe("The business snapshot the turn used."),
  tools: z.array(z.string()).describe("Tools the model called, in order."),
  output: z.string().nullable().describe("The reply sent, or what the voice model was handed."),
  direct_answer: z.boolean().describe("The answer came straight from a tool result, with no model step to phrase it."),
  failed: z.boolean(),
  duration_ms: z.number().int().nullable(),
  input_tokens: z.number().int().nullable(),
  output_tokens: z.number().int().nullable(),
  created_at: timestamp,
  expires_at: timestamp.describe("When the privacy sweep deletes it."),
});

export const apiAiTraceStepSchema = z.object({
  text: z.string().nullable(),
  tool_calls: z.array(z.object({ tool: z.string(), input: z.unknown() })),
  tool_results: z.array(z.object({ tool: z.string(), output: z.unknown() })),
});

export const apiAiTraceDetailSchema = apiAiTraceSchema.extend({
  input: z.string().nullable().describe("What the model was given for this turn: the chat history or the delegation prompt."),
  steps: z.array(apiAiTraceStepSchema).describe("Each model step: its text, the tools it called with their input, and what they returned. Long values are cut."),
  instructions: z.string().nullable().describe("The instructions the model had."),
  snapshot: z.string().nullable().describe("The business snapshot the turn used, as JSON."),
});

const smsConsentStatuses = ["subscribed", "declined", "opted_out"] as const;

export const apiContactSchema = z.object({
  id,
  name: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  locale: z.string().nullable().describe("Language for the contact's reminders and confirmations: en, fr, es or sr. null: the business's default language."),
  timezone: z.string().nullable(),
  passcode: z.object({
    set_at: timestamp,
    locked: z.boolean().describe(`true after ${CONTACT_PASSCODE_LOCK_ATTEMPTS} wrong PINs in a row, even across calls. A locked PIN works again only once a new one is set.`),
  }).nullable().describe("The contact's keypad PIN, which callers type to change appointments when verification_mode is passcode_required: whether there is one, never the PIN itself. null: the contact has no PIN."),
  sms_consent: z.object({
    status: z.enum(smsConsentStatuses).describe("subscribed: agreed to appointment texts. declined: was asked and said no. opted_out: texted STOP."),
    updated_at: nullableTimestamp.describe("When the answer was last recorded."),
  }).nullable().describe("The contact's answer about appointment texts. Only a subscribed contact gets the texts the business starts, such as reminders. null: never asked."),
  blocked_at: nullableTimestamp.describe("When the contact was blocked, from the dashboard or by the receptionist after an abusive call. Calls from a blocked contact are hung up at once, and it gets no texts, whatever sms_consent says. null: not blocked."),
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

const contactPasscode = z.string()
  .regex(new RegExp(`^\\d{${CONTACT_PASSCODE_MIN_LENGTH},${CONTACT_PASSCODE_MAX_LENGTH}}$`), `Use ${CONTACT_PASSCODE_MIN_LENGTH} to ${CONTACT_PASSCODE_MAX_LENGTH} digits.`)
  .refine((value) => !isContactPasscode(value) || !isGuessableContactPasscode(value), "Too easy to guess: avoid one digit repeated or digits in a row, such as 1111 or 1234.");

export const apiContactPasscodesUpdateSchema = z.strictObject({
  passcodes: z.array(z.strictObject({
    contact_id: id,
    passcode: contactPasscode.nullable().describe(`The new PIN: ${CONTACT_PASSCODE_MIN_LENGTH} to ${CONTACT_PASSCODE_MAX_LENGTH} digits, not one digit repeated or digits in a row such as 1111 or 1234. null removes the contact's PIN.`),
  })).min(1).max(CONTACT_PASSCODES_MAX_PER_REQUEST).describe(`Each item has a contact_id and its passcode: the new PIN, or null to remove the PIN. 1 to ${CONTACT_PASSCODES_MAX_PER_REQUEST} contacts, each once.`),
});

export const apiContactPasscodesGenerateSchema = z.strictObject({
  contact_ids: z.array(id).min(1).max(CONTACT_PASSCODES_MAX_PER_REQUEST).optional().describe(`1 to ${CONTACT_PASSCODES_MAX_PER_REQUEST} contacts to give a new PIN, each once, replacing any PIN they have. Leave it out to give one to contacts that have a phone number and no PIN.`),
  length: z.number().int().min(CONTACT_PASSCODE_MIN_LENGTH).max(CONTACT_PASSCODE_MAX_LENGTH).optional().describe(`Digits in each PIN, ${CONTACT_PASSCODE_MIN_LENGTH} to ${CONTACT_PASSCODE_MAX_LENGTH}. Defaults to ${CONTACT_PASSCODE_DEFAULT_LENGTH}.`),
});

export const apiGeneratedContactPasscodesSchema = z.object({
  contacts: z.array(apiContactSchema.extend({
    new_passcode: z.string().describe("The PIN just set. Only a hash of it is kept, so this is the only time it's shown: give it to the contact."),
  })).describe("The contacts that got a new PIN."),
  remaining: z.number().int().describe("Contacts that have a phone number and still no PIN. Without contact_ids, send the request again until this is 0."),
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
  source: z.string().describe("Where the booking came from: voice (a phone call), web_voice (a call from the website), web_chat (the website chat), sms (a text) or api. A booking made before this field existed may show another value."),
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
  staff_id: id.optional().describe("Book with this active staff member. Without it, one who is free is picked."),
  sms_consent: z.boolean().optional().describe("True only if the customer agreed to receive confirmation and reminder texts. Used only when the business texts from its own number: a cloud-mode business without one texts from the deployment's shared number, and only the receptionist can collect that consent, on a call."),
}).refine((value) => Boolean(value.contact_id || value.contact_phone), { error: "Provide contact_id or contact_phone.", path: ["contact_phone"] });

export const apiAppointmentRescheduleSchema = z.strictObject({
  starts_at: inputTimestamp,
  staff_id: id.optional().describe("Move the appointment to this active staff member. Defaults to the current one."),
});

export const apiAvailabilitySlotSchema = z.object({
  starts_at: timestamp,
  ends_at: timestamp,
});

const messageRequests = ["appointment_cancellation"] as const;

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
  request: z.enum(messageRequests).nullable().describe("appointment_cancellation: the caller asked to cancel an appointment. null: an ordinary message."),
  appointment_id: id.nullable().describe("For a cancellation request, the appointment the receptionist matched. The message closes by itself once that appointment is cancelled. null when it couldn't tell which one."),
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
  content_type: z.string().nullable().describe("A file's type, such as application/pdf. Null for a website or a page, and for a file whose type wasn't recorded."),
  tags: z.array(z.string()).describe("The tags given when a file's upload was completed. Empty for a website or a page."),
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
export type ApiUserCreate = z.infer<typeof apiUserCreateSchema>;
export type ApiUser = z.infer<typeof apiUserSchema>;
export type ApiHoursWindow = z.infer<typeof apiHoursWindowSchema>;
export type ApiReceptionist = z.infer<typeof apiReceptionistSchema>;
export type ApiReceptionistUpdate = z.infer<typeof apiReceptionistUpdateSchema>;
export type ApiRule = z.infer<typeof apiRuleSchema>;
export type ApiRuleCreate = z.infer<typeof apiRuleCreateSchema>;
export type ApiRuleUpdate = z.infer<typeof apiRuleUpdateSchema>;
export type ApiRuleReorder = z.infer<typeof apiRuleReorderSchema>;
export type ApiBilling = z.infer<typeof apiBillingSchema>;
export type ApiBillingCatalog = z.infer<typeof apiBillingCatalogSchema>;
export type ApiBillingCatalogApply = z.infer<typeof apiBillingCatalogApplySchema>;
export type ApiBillingCatalogLink = z.infer<typeof apiBillingCatalogLinkSchema>;
export type ApiBillingCatalogPolar = z.infer<typeof apiBillingCatalogPolarSchema>;
export type ApiBillingCheck = z.infer<typeof apiBillingCheckSchema>;
export type ApiBillingCatalogChange = z.infer<typeof apiBillingCatalogChangeSchema>;
export type ApiBillingCatalogPlan = z.infer<typeof apiBillingCatalogPlanSchema>;
export type ApiBillingCatalogPrice = z.infer<typeof apiBillingCatalogPriceSchema>;
export type ApiBillingCatalogRefusal = z.infer<typeof apiBillingCatalogRefusalSchema>;
export type ApiBillingCatalogRun = z.infer<typeof apiBillingCatalogRunSchema>;
export type ApiBillingPlans = z.infer<typeof apiBillingPlansSchema>;
export type ApiBillingUpdate = z.infer<typeof apiBillingUpdateSchema>;
export type ApiBillingCode = z.infer<typeof apiBillingCodeSchema>;
export type ApiBillingCodeCreate = z.infer<typeof apiBillingCodeCreateSchema>;
export type ApiCheckout = z.infer<typeof apiCheckoutSchema>;
export type ApiCheckoutCreate = z.infer<typeof apiCheckoutCreateSchema>;
export type ApiWidgetConfig = z.infer<typeof apiWidgetConfigSchema>;
export type ApiWidgetKey = z.infer<typeof apiWidgetKeySchema>;
export type ApiWidgetKeyCreated = z.infer<typeof apiWidgetKeyCreatedSchema>;
export type ApiWidgetKeyCreate = z.infer<typeof apiWidgetKeyCreateSchema>;
export type ApiWidgetKeyUpdate = z.infer<typeof apiWidgetKeyUpdateSchema>;
export type ApiPublicProfile = z.infer<typeof apiPublicProfileSchema>;
export type ApiPublicProfileUpdate = z.infer<typeof apiPublicProfileUpdateSchema>;
export type ApiCalendarConnection = z.infer<typeof apiCalendarConnectionSchema>;
export type ApiCalendarConnectionUpdate = z.infer<typeof apiCalendarConnectionUpdateSchema>;
export type ApiAccountCalendar = z.infer<typeof apiAccountCalendarSchema>;
export type ApiCalendarConnectLink = z.infer<typeof apiCalendarConnectLinkSchema>;
export type ApiNotificationPreferences = z.infer<typeof apiNotificationPreferencesSchema>;
export type ApiNotificationPreferencesUpdate = z.infer<typeof apiNotificationPreferencesUpdateSchema>;
export type ApiTeam = z.infer<typeof apiTeamSchema>;
export type ApiTeamMember = z.infer<typeof apiTeamMemberSchema>;
export type ApiTeamInvitation = z.infer<typeof apiTeamInvitationSchema>;
export type ApiTeamInvitationCreate = z.infer<typeof apiTeamInvitationCreateSchema>;
export type ApiTeamMemberUpdate = z.infer<typeof apiTeamMemberUpdateSchema>;
export type ApiClaimLinkCreate = z.infer<typeof apiClaimLinkCreateSchema>;
export type ApiClaimLink = z.infer<typeof apiClaimLinkSchema>;
export type ApiOnboarding = z.infer<typeof apiOnboardingSchema>;
export type ApiOnboardingItem = ApiOnboarding["missing"][number];
export type ApiOnboardingUpdate = z.infer<typeof apiOnboardingUpdateSchema>;
export type ApiOnboardingComplete = z.infer<typeof apiOnboardingCompleteSchema>;
export type ApiPhoneNumber = z.infer<typeof apiPhoneNumberSchema>;
export type ApiPhoneNumberSearch = z.infer<typeof apiPhoneNumberSearchSchema>;
export type ApiPhoneNumberOffer = z.infer<typeof apiPhoneNumberOfferSchema>;
export type ApiPhoneNumberClaimCreate = z.infer<typeof apiPhoneNumberClaimCreateSchema>;
export type ApiPhoneNumberClaim = z.infer<typeof apiPhoneNumberClaimSchema>;
export type ApiService = z.infer<typeof apiServiceSchema>;
export type ApiServiceCreate = z.infer<typeof apiServiceCreateSchema>;
export type ApiServiceUpdate = z.infer<typeof apiServiceUpdateSchema>;
export type ApiStaff = z.infer<typeof apiStaffSchema>;
export type ApiCall = z.infer<typeof apiCallSchema>;
export type ApiCallDetail = z.infer<typeof apiCallDetailSchema>;
export type ApiAiTrace = z.infer<typeof apiAiTraceSchema>;
export type ApiAiTraceStep = z.infer<typeof apiAiTraceStepSchema>;
export type ApiAiTraceDetail = z.infer<typeof apiAiTraceDetailSchema>;
export type ApiContact = z.infer<typeof apiContactSchema>;
export type ApiContactCreate = z.infer<typeof apiContactCreateSchema>;
export type ApiContactUpdate = z.infer<typeof apiContactUpdateSchema>;
export type ApiContactPasscodesUpdate = z.infer<typeof apiContactPasscodesUpdateSchema>;
export type ApiContactPasscodesGenerate = z.infer<typeof apiContactPasscodesGenerateSchema>;
export type ApiGeneratedContactPasscodes = z.infer<typeof apiGeneratedContactPasscodesSchema>;
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
