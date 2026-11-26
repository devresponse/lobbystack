import { z } from "zod";

import { billingTopUpSources, billingTopUpStatuses, TOP_UP_MAX_DAYS, TOP_UP_MAX_START_DAYS, TOP_UP_MAX_UNITS, TOP_UP_MAX_VOICE_SECONDS } from "../billingTopUps";
import { id, nullableTimestamp, timestamp } from "./primitives";

// Top-ups in the v1 contract (docs/features/top-ups.md): the top-ups GET
// /billing lists, an operator's grant, and what a top-up code adds.

const topUpAmountFields = {
  voice_seconds: z.number().int().describe("Voice seconds, as calls are counted."),
  alert_sms_segments: z.number().int().describe("Alert text segments: the texts the business gets about calls and messages."),
  outbound_call_attempts: z.number().int().describe("Transfers: calls the receptionist places to pass a caller on."),
  chat_units: z.number().int().describe("Website chats: each chat the receptionist answers uses one."),
};

const apiTopUpAmountsSchema = z.object(topUpAmountFields);

export const apiBillingTopUpSchema = z.object({
  id,
  source: z.enum(billingTopUpSources).describe("grant: an operator's platform key gave it with POST /billing/top-ups. code: someone on the team added it with a top-up code."),
  code: z.string().nullable().describe("The top-up code that added it. Null for a grant."),
  note: z.string().nullable().describe("The operator's note on a grant, such as the promotion it is for, which the business sees too. Null when there is none."),
  gives: apiTopUpAmountsSchema.describe("What it adds on top of the plan."),
  used: apiTopUpAmountsSchema.describe("What uses drew from it, never more than it gives."),
  status: z.enum(billingTopUpStatuses).describe("scheduled until starts_at; active while uses can draw on it; used_up once nothing it gives is left; expired once ends_at passed; revoked once an operator revoked it. Only an active top-up counts."),
  starts_at: timestamp,
  ends_at: nullableTimestamp.describe("When it stops counting, fixed when it was made. Null when it never ends."),
  created_at: timestamp,
  revoked_at: nullableTimestamp,
}).describe("Extra voice minutes, alert texts, transfers and website chats the business has on top of its plan, which stays as it is. A use draws on a top-up only once the plan's own allowance of its kind is used up, on the prepaid plan once its packs hold none, the top-up that ends first first. On Free and on a prepaid pack that is a use made where it would be refused, and on Starter and Pro it is usage the billing provider is never sent, so it is never billed and doesn't count toward the spending cap. Website chats on Starter and Pro are never billed, so they don't draw on one, and on Enterprise and self-hosted deployments, which have no allowances, nothing does.");

const topUpCount = (what: string, max: number) => z.number().int().min(0).max(max).optional().describe(`${what} Up to ${max.toLocaleString("en-US")}.`);

const topUpGivesFields = {
  voice_seconds: topUpCount("Voice seconds it adds: 3600 is an hour of calls.", TOP_UP_MAX_VOICE_SECONDS),
  alert_sms_segments: topUpCount("Alert text segments it adds.", TOP_UP_MAX_UNITS),
  outbound_call_attempts: topUpCount("Transfers it adds.", TOP_UP_MAX_UNITS),
  chat_units: topUpCount("Website chats it adds: each chat the receptionist answers uses one.", TOP_UP_MAX_UNITS),
};

/** At least one amount above 0, on the path of the first amount. */
export function requireTopUpGives(value: { voice_seconds?: number | undefined; alert_sms_segments?: number | undefined; outbound_call_attempts?: number | undefined; chat_units?: number | undefined }, context: z.RefinementCtx, path: string[] = []): void {
  if ((value.voice_seconds ?? 0) + (value.alert_sms_segments ?? 0) + (value.outbound_call_attempts ?? 0) + (value.chat_units ?? 0) > 0) return;
  context.addIssue({ code: "custom", path: [...path, "voice_seconds"], message: "Send at least one of voice_seconds, alert_sms_segments, outbound_call_attempts and chat_units above 0." });
}

export const apiBillingTopUpCreateSchema = z.strictObject({
  ...topUpGivesFields,
  starts_at: z.iso.datetime({ offset: true }).optional().describe(`When it starts counting, up to ${TOP_UP_MAX_START_DAYS} days ahead. Left out, or already past, it starts now.`),
  ends_at: z.iso.datetime({ offset: true }).optional().describe(`When it stops counting: in the future, after starts_at and at most ${TOP_UP_MAX_DAYS.toLocaleString("en-US")} days after it. Not with days.`),
  days: z.number().int().min(1).max(TOP_UP_MAX_DAYS).optional().describe(`How long it lasts from starts_at, in 24-hour days, up to ${TOP_UP_MAX_DAYS.toLocaleString("en-US")}. Not with ends_at. With neither, it never ends.`),
  note: z.string().trim().max(200).optional().describe("Why it was given, such as the promotion it is for. The business sees it in Settings > Plan."),
}).superRefine((value, context) => {
  requireTopUpGives(value, context);
  if (value.ends_at !== undefined && value.days !== undefined) context.addIssue({ code: "custom", path: ["days"], message: "Send ends_at or days, not both." });
});

export const apiBillingCodeTopUpSchema = z.object({
  ...topUpAmountFields,
  days: z.number().int().nullable().describe("How long the top-up lasts from when it is added, in 24-hour days. Null when it never ends."),
}).describe("What a top-up code adds.");

export const apiBillingCodeTopUpCreateSchema = z.strictObject({
  ...topUpGivesFields,
  days: z.number().int().min(1).max(TOP_UP_MAX_DAYS).optional().describe(`How long the top-up lasts from when it is added, in 24-hour days, up to ${TOP_UP_MAX_DAYS.toLocaleString("en-US")}. Left out, it never ends.`),
});

export type ApiBillingTopUp = z.infer<typeof apiBillingTopUpSchema>;
export type ApiBillingTopUpCreate = z.infer<typeof apiBillingTopUpCreateSchema>;
