import { sql } from "drizzle-orm";
import { doublePrecision, index, integer, pgTable, primaryKey, smallint, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";

// Everything migration 0154 adds to the schema (docs/features/top-ups.md): the
// top-up tables, and the columns it adds to billing_usage_events and
// billing_codes, which index.ts spreads into those tables. index.ts imports
// this module before it defines its own tables, so nothing here may read one
// of them while this module loads: only the references' callbacks and the
// index builders, which Drizzle calls later, do. Import it through index.ts,
// which exports all of it, never directly: loaded first, it would run
// index.ts before these exist.
import { billingCodes, businesses, users } from "./index";

/** The part of a usage row's quantity a top-up paid for: counted as used, never billed and never past the allowance. */
export const topUpUsageColumns = {
  topUpQuantity: doublePrecision("top_up_quantity").default(0).notNull(),
};

/**
 * What a top-up code adds, in billing_codes beside a plan's code: voice
 * seconds, alert SMS segments, outbound call attempts and chat units, and how
 * long the top-up lasts from when it is added, in 24-hour days (null for no
 * end). All null on a plan's code; a top-up code's plan is null.
 */
export const topUpCodeColumns = {
  voiceSec: integer("voice_sec"),
  smsSeg: integer("sms_seg"),
  callsOut: integer("calls_out"),
  chatUnits: integer("chat_units"),
  days: smallint("days"),
};

/**
 * Top-ups of migration 0154 (docs/features/top-ups.md): extra voice seconds,
 * alert texts, transfers and chat units a business gets on top of its plan,
 * granted by an operator or added by a top-up code. A top-up never changes the
 * plan; uses draw on it only once the plan's own allowance of their kind is
 * used up. Everything it gives and its end are set when it is made; an
 * operator may revoke it, which stops what it still holds.
 */
export const billingTopUps = pgTable(
  "billing_top_ups",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
    /** grant (an operator's platform key) or code (a business typed a top-up code). */
    source: varchar("source", { length: 8 }).notNull(),
    /** The top-up code that added it, and that code as stored, which the business may read where it may not read billing_codes. */
    codeId: uuid("code_id").references(() => billingCodes.id),
    code: varchar("code", { length: 32 }),
    /** The operator platform key that granted it, and its partner. */
    keyId: uuid("key_id"),
    partner: varchar("partner", { length: 40 }),
    /** The person who typed the code. */
    redeemedBy: uuid("redeemed_by").references(() => users.id, { onDelete: "set null" }),
    /** The operator's note, such as the promotion it is for. */
    note: varchar("note", { length: 200 }),
    /** What it gives: voice seconds, alert SMS segments, outbound call attempts (transfers) and website chat AI units. */
    voiceSec: integer("voice_sec").default(0).notNull(),
    smsSeg: integer("sms_seg").default(0).notNull(),
    callsOut: integer("calls_out").default(0).notNull(),
    chatUnits: integer("chat_units").default(0).notNull(),
    /** What uses drew from it; never more than it gives. */
    voiceUsed: integer("voice_used").default(0).notNull(),
    smsUsed: integer("sms_used").default(0).notNull(),
    callsUsed: integer("calls_used").default(0).notNull(),
    chatUsed: integer("chat_used").default(0).notNull(),
    /** When it was granted or added. */
    startsAt: timestamp("starts_at", { withTimezone: true }).defaultNow().notNull(),
    /** When it stops counting, fixed when it is made; null means never. */
    endsAt: timestamp("ends_at", { withTimezone: true }),
    /** active, or revoked by an operator. */
    status: varchar("status", { length: 8 }).default("active").notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    /** Kept to the millisecond, as billing_codes' is. */
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`date_trunc('milliseconds', now())`).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("billing_top_ups_business_idx").on(table.businessId, table.createdAt.desc()),
    index("billing_top_ups_live_idx").on(table.businessId, table.endsAt).where(sql`${table.status} = 'active'`),
    uniqueIndex("billing_top_ups_code_business_unique").on(table.codeId, table.businessId).where(sql`${table.codeId} is not null`),
    uniqueIndex("billing_top_ups_code_person_unique").on(table.codeId, table.redeemedBy).where(sql`${table.codeId} is not null and ${table.redeemedBy} is not null`),
  ],
);

/** Which top-up paid for each use, by the usage row's key, as billing_pack_draws does for packs. */
export const billingTopUpDraws = pgTable(
  "billing_top_up_draws",
  {
    topUpId: uuid("top_up_id").notNull().references(() => billingTopUps.id, { onDelete: "cascade" }),
    businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
    /** The usage row's source_key, such as voice:<call id>. */
    sourceKey: varchar("source_key", { length: 255 }).notNull(),
    /** The usage row's kind: voice_seconds, alert_sms_segments, outbound_call_attempts or chat_ai_tokens. */
    usageKind: varchar("usage_kind", { length: 32 }).notNull(),
    /** What the use took from the top-up: seconds for a call, segments for a text, attempts for a transfer, units for a chat. */
    units: integer("units").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.topUpId, table.sourceKey] }),
    index("billing_top_up_draws_source_idx").on(table.businessId, table.sourceKey),
  ],
);

/** Both tables, for index.ts's schema object. */
export const topUpTables = { billingTopUps, billingTopUpDraws };
