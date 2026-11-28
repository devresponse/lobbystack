import { sql } from "drizzle-orm";
import { bigint, char, doublePrecision, index, integer, jsonb, pgTable, pgView, primaryKey, smallint, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";

// Everything migrations 0154 and 0155 add to the schema (docs/features/top-ups.md):
// the top-up tables; the columns 0154 adds to billing_usage_events and
// billing_codes and 0155 to billing_pack_plans and billing_pack_checkouts,
// which index.ts spreads into those tables; and billing_pack_offers, the view
// 0155 makes again to show the top-ups on sale beside the packs. index.ts imports
// this module before it defines its own tables, so nothing here may read one
// of them while this module loads: only the references' callbacks and the
// index builders, which Drizzle calls later, do. Import it through index.ts,
// which exports all of it, never directly: loaded first, it would run
// index.ts before these exist.
import { billingCodes, billingPackPlans, billingPackPrices, billingTransactions, businesses, users } from "./index";

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

/** What 0155 adds to billing_pack_plans, which holds the top-ups on sale beside the packs. */
export const topUpPackPlanColumns = {
  /** pack, or top_up: extra allowances on top of the plan, whose limit columns are 0 since it changes no limit. */
  kind: varchar("kind", { length: 8 }).default("pack").notNull(),
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
    /** grant (an operator's platform key), code (a business typed a top-up code) or purchase (a business paid for one on sale, 0155). */
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
    /** active; frozen while a dispute holds its payment; revoked by an operator; refunded once its whole payment went back. Only active counts. */
    status: varchar("status", { length: 8 }).default("active").notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    /** A purchase's top-up on sale (its code in billing.json's topUps) and the price it was bought at (0155). */
    offer: varchar("offer", { length: 48 }).references(() => billingPackPlans.code),
    priceId: uuid("price_id").references(() => billingPackPrices.id),
    /** The billing provider that took the payment, and the payment: a Stripe PaymentIntent or a Polar order. */
    provider: varchar("provider", { length: 8 }),
    providerRef: text("provider_ref"),
    /** The payment's order row. */
    transactionId: uuid("transaction_id").references(() => billingTransactions.id, { onDelete: "set null" }),
    /** What was paid and what of it was refunded, in currency; 0 for a grant or a code, whose currency is null. */
    amountCents: integer("amount_cents").default(0).notNull(),
    refundedCents: integer("refunded_cents").default(0).notNull(),
    currency: char("currency", { length: 3 }),
    /** When its whole payment went back; set exactly when status is refunded. */
    refundedAt: timestamp("refunded_at", { withTimezone: true }),
    /** Kept to the millisecond, as billing_codes' is. */
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`date_trunc('milliseconds', now())`).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("billing_top_ups_business_idx").on(table.businessId, table.createdAt.desc()),
    index("billing_top_ups_live_idx").on(table.businessId, table.endsAt).where(sql`${table.status} = 'active'`),
    uniqueIndex("billing_top_ups_code_business_unique").on(table.codeId, table.businessId).where(sql`${table.codeId} is not null`),
    uniqueIndex("billing_top_ups_code_person_unique").on(table.codeId, table.redeemedBy).where(sql`${table.codeId} is not null and ${table.redeemedBy} is not null`),
    // One top-up per payment; grants and codes have none.
    uniqueIndex("billing_top_ups_payment_unique").on(table.provider, table.providerRef),
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

/** What 0155 adds to billing_pack_checkouts, which a top-up on sale is bought through as a pack is. */
export const topUpCheckoutColumns = {
  /** The top-up the checkout's payment added, once it arrived. */
  topUpId: uuid("top_up_id").references(() => billingTopUps.id, { onDelete: "set null" }),
};

/** The packs and top-ups on sale now, each with its live price and kind. Reads with the caller's row-level security. */
export const billingPackOffers = pgView("billing_pack_offers", {
  code: varchar("code", { length: 48 }).notNull(),
  names: jsonb("names").$type<Record<string, string>>().notNull(),
  voiceSec: integer("voice_sec").notNull(),
  days: smallint("days"),
  smsSeg: integer("sms_seg").notNull(),
  callsOut: integer("calls_out").notNull(),
  chatUnits: integer("chat_units").notNull(),
  kbBytes: bigint("kb_bytes", { mode: "number" }).notNull(),
  numbers: smallint("numbers").notNull(),
  receptionists: smallint("receptionists").notNull(),
  sort: smallint("sort").notNull(),
  priceId: uuid("price_id").notNull(),
  currency: char("currency", { length: 3 }).notNull(),
  cents: integer("cents").notNull(),
  providerRef: text("provider_ref"),
  /** pack or top_up (0155). */
  kind: varchar("kind", { length: 8 }).notNull(),
}).existing();
