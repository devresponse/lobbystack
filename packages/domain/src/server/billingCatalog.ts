import { createHash } from "node:crypto";

import { eq, getTableColumns, sql, type SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

import { billingPlans, billingPrices, billingRuns, withBusinessTransaction, type DatabaseTransaction } from "@lobbystack/db";
import {
  billingProfileHash,
  canonicalBillingProfileJson,
  normalizeBillingProfile,
  planTermsJson,
  polarEnvForBaseUrl,
  resolveBillingPlans,
  type ApiBillingCatalog,
  type ApiBillingCatalogApply,
  type ApiBillingCatalogChange,
  type ApiBillingCatalogLink,
  type ApiBillingCatalogPlan,
  type ApiBillingCatalogPolar,
  type ApiBillingCatalogPrice,
  type ApiBillingCatalogRefusal,
  type ApiBillingCatalogRun,
  type ApiBillingCheck,
  type BillingInterval,
  type BillingProfile,
  type PolarEnv,
  type ResolvedBillingPlan,
} from "@lobbystack/shared";

import type { DomainContext } from "./context";
import { PublicApiError, invalidRequest } from "./publicApi/errors";
import { idempotencyRequestHash } from "./publicApi/idempotency";
import { decodeCursor, pageSize, toPage, type Page, type PageRequest } from "./publicApi/resources";

// The billing catalog: a brand's billing.json written into billing_plans and
// billing_prices, with a billing_runs row for every apply (migration 0108).
// One apply seeds an empty deployment and updates a filled one alike: it
// resolves the rows the file describes, compares them with the rows Postgres
// holds, and writes the difference in one transaction. A link then records
// which Polar product sells each live price, and the worker records a verify
// run each day. Nothing here calls Polar, and nothing at run time reads these
// tables yet.

// One apply or link at a time, across every admin process.
const CATALOG_LOCK = sql`select pg_advisory_xact_lock(hashtext('lobbystack.billing_catalog'))`;

type PlanStatus = "draft" | "active" | "retired";

/** A billing_plans row as the diff reads it: every column, times as ISO strings. */
export type StoredBillingPlan = Omit<ResolvedBillingPlan, "prices"> & {
  status: PlanStatus;
  src: "file" | "api";
  polar_disc: string | null;
  terms_hash: string;
  frozen_at: string | null;
  run_id: string | null;
  retired_at: string | null;
  created_at: string;
  updated_at: string;
};

/** A billing_prices row as the diff reads it. */
export type StoredBillingPrice = {
  id: string;
  plan: string;
  period: BillingInterval;
  currency: string;
  cents: number;
  per_month: number;
  polar_id: string | null;
  run_id: string | null;
  retired_at: string | null;
  created_at: string;
  updated_at: string;
};

/** A resolved plan with the hash of its terms, as the file wants the row to be. */
export type DesiredBillingPlan = ResolvedBillingPlan & { terms_hash: string };

/** One row an apply writes: what the changes list shows, and the columns it sets. */
export type BillingCatalogWrite = {
  change: ApiBillingCatalogChange;
  /** The price row it changes; absent for a plan, which its code names, and for an insert. */
  id?: string;
  set: Record<string, unknown>;
};

export type BillingCatalogDiff = { writes: BillingCatalogWrite[]; refusals: ApiBillingCatalogRefusal[] };

// The plan columns an apply sets from the file. terms_hash covers all but the last four.
const planValueColumns = ["tier", "sold", "custom", "overage", "voice_sec", "sms_seg", "calls_out", "chat_units", "kb_bytes", "numbers", "voice_rate", "sms_rate", "call_rate", "months", "ends", "discount", "terms_hash", "names", "access", "offer_end", "sort"] as const;
const allowanceColumns = ["voice_sec", "sms_seg", "calls_out", "chat_units", "kb_bytes", "numbers"] as const;
const rateColumns = ["voice_rate", "sms_rate", "call_rate"] as const;
const actionOrder: Record<ApiBillingCatalogChange["action"], number> = { retire: 0, update: 1, restore: 2, insert: 3 };

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, entry]) => [key, stable(entry)]));
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(stable(a ?? null)) === JSON.stringify(stable(b ?? null));
}

function byKey(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const priceKey = (price: { plan: string; period: string; currency: string }) => `${price.plan}/${price.period}/${price.currency}`;
const planPath = (code: string) => `billing_file.plans.${code}`;

function goesDown(from: unknown, to: unknown): boolean {
  return typeof from === "number" && typeof to === "number" && to < from;
}

function goesUp(from: unknown, to: unknown): boolean {
  return typeof from === "number" && typeof to === "number" && to > from;
}

/** The rows a file's plans resolve to, each with its terms hash. */
export function desiredBillingPlans(profile: BillingProfile): DesiredBillingPlan[] {
  return resolveBillingPlans(profile).map((plan) => ({ ...plan, terms_hash: sha256(planTermsJson(plan)) }));
}

/**
 * What an apply writes to make the tables match the file, and the refusals
 * that need the tables to find. Only rows from the file take part: a plan
 * made through the API is never matched, changed or retired. Pure, so the
 * rules are tested without a database.
 */
export function diffBillingCatalog(input: { plans: DesiredBillingPlan[]; currency: string; current: { plans: StoredBillingPlan[]; prices: StoredBillingPrice[] }; now: string }): BillingCatalogDiff {
  const writes: BillingCatalogWrite[] = [];
  const refusals: ApiBillingCatalogRefusal[] = [];
  const stored = new Map(input.current.plans.map((plan) => [plan.code, plan]));
  const filePlanCodes = new Set(input.current.plans.filter((plan) => plan.src === "file").map((plan) => plan.code));
  const write = (change: Omit<ApiBillingCatalogChange, "lowers_allowance" | "raises_price"> & Partial<Pick<ApiBillingCatalogChange, "lowers_allowance" | "raises_price">>, set: Record<string, unknown>, id?: string) => {
    writes.push({ change: { lowers_allowance: false, raises_price: false, ...change }, set, ...(id ? { id } : {}) });
  };

  // Plans: matched by code.
  const applied = new Map<string, DesiredBillingPlan>();
  for (const plan of input.plans) {
    const existing = stored.get(plan.code);
    if (existing?.src === "api") {
      refusals.push({ code: "code_taken", message: `${plan.code} is a plan an operator made through the API, so the file can't use its code. Pick another code.`, path: planPath(plan.code) });
      continue;
    }
    applied.set(plan.code, plan);
    const values: Record<string, unknown> = Object.fromEntries(planValueColumns.map((column) => [column, plan[column]]));
    if (!existing) {
      // Polar must sell a sold plan before it is active; an unsold plan has nothing to sell.
      write({ table: "billing_plans", key: plan.code, action: "insert", fields: {} }, { code: plan.code, ...values, status: plan.sold ? "draft" : "active", src: "file" });
      continue;
    }
    const retired = existing.status === "retired";
    const termsChanged = existing.terms_hash !== plan.terms_hash;
    if (termsChanged && existing.frozen_at !== null) {
      refusals.push({ code: "plan_frozen", message: `${plan.code} has had subscribers since ${existing.frozen_at}, so its terms can't change, directly or through its tier. Put new terms under a new code, or write the values it inherits into its entry.`, path: planPath(plan.code) });
    }
    const set: Record<string, unknown> = {};
    const fields: ApiBillingCatalogChange["fields"] = {};
    for (const column of planValueColumns) {
      if (same(existing[column], values[column])) continue;
      set[column] = values[column];
      fields[column] = { from: existing[column], to: values[column] };
    }
    // A sold plan whose terms change goes back to draft until Polar sells it as defined again.
    let status: PlanStatus = existing.status;
    if (retired) status = plan.sold ? "draft" : "active";
    else if (termsChanged) status = !plan.sold ? "active" : status === "active" ? "draft" : status;
    if (status !== existing.status) {
      set.status = status;
      fields.status = { from: existing.status, to: status };
    }
    if (retired) {
      set.retired_at = null;
      fields.retired_at = { from: existing.retired_at, to: null };
    }
    if (!Object.keys(fields).length) continue;
    write({
      table: "billing_plans",
      key: plan.code,
      action: retired ? "restore" : "update",
      fields,
      lowers_allowance: allowanceColumns.some((column) => column in fields && goesDown(fields[column]!.from, fields[column]!.to)),
      raises_price: rateColumns.some((column) => column in fields && goesUp(fields[column]!.from, fields[column]!.to)),
    }, set);
  }
  for (const existing of input.current.plans) {
    if (existing.src !== "file" || existing.status === "retired" || applied.has(existing.code)) continue;
    // Businesses may still be on it and Polar keeps its products, so it is retired, never deleted.
    write({ table: "billing_plans", key: existing.code, action: "retire", fields: {} }, { status: "retired", retired_at: input.now });
  }

  // Prices: matched by plan, period and currency.
  const livePrices = input.current.prices.filter((price) => price.retired_at === null && filePlanCodes.has(price.plan));
  const lockedCurrencies = [...new Set(livePrices.filter((price) => price.currency !== input.currency && price.polar_id !== null).map((price) => price.currency))].sort();
  if (lockedCurrencies.length) {
    refusals.push({ code: "currency_locked", message: `Polar already sells live prices in ${lockedCurrencies.join(", ")}, so the currency can't change to ${input.currency} until Polar has products in it.`, path: "billing_file.currency" });
  }
  const kept = new Set<string>();
  for (const plan of applied.values()) {
    for (const price of plan.prices) {
      const rows = input.current.prices.filter((row) => row.plan === plan.code && row.period === price.period);
      const live = rows.find((row) => row.retired_at === null && row.currency === price.currency);
      const key = priceKey({ plan: plan.code, ...price });
      if (live) {
        kept.add(live.id);
        // A price change keeps the row and its Polar product: Polar adds a price to the same product.
        if (live.cents !== price.cents) write({ table: "billing_prices", key, action: "update", fields: { cents: { from: live.cents, to: price.cents } }, raises_price: price.cents > live.cents }, { cents: price.cents }, live.id);
        continue;
      }
      // A period back in the file brings back its latest row, so the next PR can bring back the same product.
      const [latest] = rows.filter((row) => row.retired_at !== null && row.currency === price.currency).sort((a, b) => byKey(b.retired_at!, a.retired_at!) || byKey(b.updated_at, a.updated_at));
      if (latest) {
        const fields: ApiBillingCatalogChange["fields"] = { retired_at: { from: latest.retired_at, to: null } };
        if (latest.cents !== price.cents) fields.cents = { from: latest.cents, to: price.cents };
        write({ table: "billing_prices", key, action: "restore", fields, raises_price: price.cents > latest.cents }, { cents: price.cents, retired_at: null }, latest.id);
      } else {
        write({ table: "billing_prices", key, action: "insert", fields: {} }, { plan: plan.code, period: price.period, currency: price.currency, cents: price.cents });
      }
    }
  }
  for (const price of livePrices) {
    // Its period or currency left the file, or its plan did.
    if (!kept.has(price.id)) write({ table: "billing_prices", key: priceKey(price), action: "retire", fields: {} }, { retired_at: input.now }, price.id);
  }

  writes.sort((a, b) => byKey(a.change.table, b.change.table) || byKey(a.change.key, b.change.key) || actionOrder[a.change.action] - actionOrder[b.change.action]);
  return { writes, refusals };
}

/**
 * The order the writes run in: plans before prices, for the foreign key, and
 * within each table retirements first, so the live price index never sees
 * two live rows for one plan and period.
 */
export function billingCatalogWriteOrder(writes: readonly BillingCatalogWrite[]): BillingCatalogWrite[] {
  return [...writes].sort((a, b) => byKey(a.change.table, b.change.table) || actionOrder[a.change.action] - actionOrder[b.change.action] || byKey(a.change.key, b.change.key));
}

// Reading rows back.

type Row = Record<string, unknown>;

const iso = (value: unknown): string => (value instanceof Date ? value : new Date(String(value))).toISOString();
const isoOrNull = (value: unknown): string | null => (value === null || value === undefined ? null : iso(value));
const numberOrNull = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

function storedPlan(row: Row): StoredBillingPlan {
  return {
    code: String(row.code),
    tier: row.tier as StoredBillingPlan["tier"],
    status: row.status as PlanStatus,
    access: row.access as StoredBillingPlan["access"],
    sold: Boolean(row.sold),
    custom: Boolean(row.custom),
    overage: Boolean(row.overage),
    src: row.src as StoredBillingPlan["src"],
    names: (row.names ?? null) as StoredBillingPlan["names"],
    voice_sec: numberOrNull(row.voice_sec),
    sms_seg: numberOrNull(row.sms_seg),
    calls_out: numberOrNull(row.calls_out),
    chat_units: numberOrNull(row.chat_units),
    // bigint arrives as text.
    kb_bytes: numberOrNull(row.kb_bytes),
    numbers: numberOrNull(row.numbers),
    voice_rate: numberOrNull(row.voice_rate),
    sms_rate: numberOrNull(row.sms_rate),
    call_rate: numberOrNull(row.call_rate),
    months: numberOrNull(row.months),
    ends: (row.ends ?? null) as StoredBillingPlan["ends"],
    offer_end: isoOrNull(row.offer_end),
    discount: (row.discount ?? null) as StoredBillingPlan["discount"],
    polar_disc: (row.polar_disc ?? null) as string | null,
    terms_hash: String(row.terms_hash),
    frozen_at: isoOrNull(row.frozen_at),
    sort: Number(row.sort),
    run_id: (row.run_id ?? null) as string | null,
    retired_at: isoOrNull(row.retired_at),
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

function storedPrice(row: Row): StoredBillingPrice {
  return {
    id: String(row.id),
    plan: String(row.plan),
    period: row.period as BillingInterval,
    currency: String(row.currency),
    cents: Number(row.cents),
    per_month: Number(row.per_month),
    polar_id: (row.polar_id ?? null) as string | null,
    run_id: (row.run_id ?? null) as string | null,
    retired_at: isoOrNull(row.retired_at),
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

function runResource(row: Row): ApiBillingCatalogRun {
  return {
    id: String(row.id),
    kind: row.kind as ApiBillingCatalogRun["kind"],
    status: row.status as ApiBillingCatalogRun["status"],
    brand: String(row.brand),
    ver: Number(row.ver),
    hash: String(row.hash),
    prev_hash: (row.prev_hash ?? null) as string | null,
    code_hash: (row.code_hash ?? null) as string | null,
    changes: row.changes as ApiBillingCatalogChange[],
    problems: row.problems as ApiBillingCheck[],
    // A refused apply stores nothing, so a stored run was never blocked.
    blocked_by: [],
    polar_env: (row.polar_env ?? null) as ApiBillingCatalogRun["polar_env"],
    polar_org: (row.polar_org ?? null) as string | null,
    key_id: (row.key_id ?? null) as string | null,
    partner: (row.partner ?? null) as string | null,
    started_at: iso(row.started_at),
    ended_at: isoOrNull(row.ended_at),
  };
}

type CatalogState = { plans: StoredBillingPlan[]; prices: StoredBillingPrice[]; latest: Row | null; latestLink: Row | null };

async function latestRun(tx: DatabaseTransaction, kind: "catalog" | "polar" | "verify"): Promise<Row | null> {
  const [row] = (await tx.execute<Row>(sql`select * from public.billing_runs where kind = ${kind} order by started_at desc, id desc limit 1`)).rows;
  return row ?? null;
}

// The whole catalog, retired rows too, the latest catalog run and the latest link: section 7.5's Q9 and Q6.
async function readCatalog(tx: DatabaseTransaction): Promise<CatalogState> {
  const plans = (await tx.execute<Row>(sql`select * from public.billing_plans order by sort, code`)).rows.map(storedPlan);
  const prices = (await tx.execute<Row>(sql`select * from public.billing_prices order by plan, period, retired_at nulls first`)).rows.map(storedPrice);
  return { plans, prices, latest: await latestRun(tx, "catalog"), latestLink: await latestRun(tx, "polar") };
}

/** A run's start: when it holds the lock, to the millisecond, and after the latest run of its kind, so that run is always the last one written. */
function runStart(latest: Row | null): Date {
  const latestStart = latest ? iso(latest.started_at) : null;
  return sql`greatest(date_trunc('milliseconds', clock_timestamp()), ${latestStart}::timestamptz + interval '1 millisecond')` as unknown as Date;
}

// Writing rows: the diff speaks in column names, drizzle in its field names.

function fieldNames(table: PgTable): Map<string, string> {
  return new Map(Object.entries(getTableColumns(table)).map(([field, column]) => [column.name, field]));
}

const planFields = fieldNames(billingPlans);
const priceFields = fieldNames(billingPrices);
const timeColumns = new Set(["offer_end", "retired_at"]);

function toFields(fields: Map<string, string>, set: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(set).map(([column, value]) => {
    const field = fields.get(column);
    if (!field) throw new Error(`billing catalog: no column ${column}`);
    return [field, timeColumns.has(column) && typeof value === "string" ? new Date(value) : value];
  }));
}

async function runWrite(tx: DatabaseTransaction, write: BillingCatalogWrite, runId: string): Promise<void> {
  const stamp = { runId, updatedAt: sql`now()` as unknown as Date };
  if (write.change.table === "billing_plans") {
    const values = { ...toFields(planFields, write.set), ...stamp };
    if (write.change.action === "insert") await tx.insert(billingPlans).values(values as typeof billingPlans.$inferInsert);
    else await tx.update(billingPlans).set(values).where(eq(billingPlans.code, write.change.key));
    return;
  }
  const values = { ...toFields(priceFields, write.set), ...stamp };
  if (write.change.action === "insert") await tx.insert(billingPrices).values(values as typeof billingPrices.$inferInsert);
  else await tx.update(billingPrices).set(values).where(eq(billingPrices.id, write.id!));
}

// The operations.

/** The Polar settings a process runs with, from its environment. */
export type BillingDeploymentPolar = {
  env: PolarEnv;
  org: string | null;
  /** SHA-256 of POLAR_WEBHOOK_SECRET; null where it isn't set, as on the worker. */
  secretSha256: string | null;
  /** The four POLAR_<PLAN>_<INTERVAL>_PRODUCT_ID values checkout reads, by plan/period. */
  productVars: Record<string, string | null>;
};

export type BillingCatalogDeployment = {
  /** The brand this deployment shows, as the sidebar resolves it. */
  brand: string;
  /** Each brand's billing.json hash in the running code. Defaults to the build's BILLING_PROFILE_HASHES. */
  codeHashes?: Record<string, string>;
  /** Defaults to an instance with no Polar settings. */
  polar?: BillingDeploymentPolar;
};

const productVarKeys = ["starter/monthly", "starter/annual", "pro/monthly", "pro/annual"] as const;

/** POLAR_API_BASE_URL, POLAR_ORGANIZATION_ID, POLAR_WEBHOOK_SECRET (as its hash) and the four product ids, as a process's environment has them. */
export function billingDeploymentPolar(env: Record<string, string | undefined>, options: { withSecret: boolean } = { withSecret: true }): BillingDeploymentPolar {
  const value = (name: string) => env[name]?.trim() || null;
  const secret = options.withSecret ? value("POLAR_WEBHOOK_SECRET") : null;
  return {
    env: polarEnvForBaseUrl(value("POLAR_API_BASE_URL")),
    org: value("POLAR_ORGANIZATION_ID"),
    secretSha256: secret ? sha256(secret) : null,
    productVars: Object.fromEntries(productVarKeys.map((key) => {
      const [plan, period] = key.split("/") as [string, string];
      return [key, value(`POLAR_${plan.toUpperCase()}_${period.toUpperCase()}_PRODUCT_ID`)];
    })),
  };
}

const noPolar: BillingDeploymentPolar = { env: "production", org: null, secretSha256: null, productVars: Object.fromEntries(productVarKeys.map((key) => [key, null])) };

/** The operator key that asks for an apply. */
export type BillingCatalogCaller = { platformKeyId: string; partnerId: string };

function missingKey(): PublicApiError {
  return new PublicApiError(400, "invalid_request", "Send an Idempotency-Key header with this request, so a retry can't do it twice. A dry run needs none.", [{ path: "Idempotency-Key", message: "Required." }]);
}

/**
 * Applies a billing.json, or with dry_run shows what applying it would do.
 * A real apply needs an Idempotency-Key: the same key and request return the
 * run it made, and the same key with another request is a 422. Any refusal
 * stops it with a 409 that lists every refusal found, and nothing is written.
 */
export async function applyBillingCatalogForApi(context: DomainContext, input: { caller: BillingCatalogCaller; idempotencyKey: string | null; body: ApiBillingCatalogApply; deployment: BillingCatalogDeployment }): Promise<{ run: ApiBillingCatalogRun; replayed: boolean; status: 200 | 201 }> {
  const { body, caller, deployment } = input;
  const dryRun = body.dry_run === true;
  if (!dryRun && !input.idempotencyKey) throw missingKey();
  const profile = body.billing_file;
  const hash = sha256(canonicalBillingProfileJson(profile));
  const codeHash = billingProfileHash(body.brand, deployment.codeHashes);
  const allowUndeployed = body.allow_undeployed === true;
  // One key can never stand for two requests; dry_run is left out because a dry run never stores a key.
  const requestHash = idempotencyRequestHash({ operation: "applyBillingCatalog", brand: body.brand, hash, replaces: body.replaces_hash !== undefined, replaces_hash: body.replaces_hash ?? null, allow_undeployed: allowUndeployed });

  return await withBusinessTransaction(context.db, { actorType: "worker" }, async (tx) => {
    if (!dryRun) {
      await tx.execute(CATALOG_LOCK);
      // After the lock, so two requests with one key can't both write.
      const [reused] = (await tx.execute<Row>(sql`select * from public.billing_runs where key_id = ${caller.platformKeyId}::uuid and idem_key = ${input.idempotencyKey}`)).rows;
      if (reused) {
        if (reused.req_hash !== requestHash) throw new PublicApiError(422, "idempotency_key_reused", "This Idempotency-Key was used with a different request.");
        return { run: runResource(reused), replayed: true, status: 201 as const };
      }
    }
    const current = await readCatalog(tx);
    const latestHash = (current.latest?.hash ?? null) as string | null;
    const refusals: ApiBillingCatalogRefusal[] = [];
    if (body.brand !== deployment.brand) refusals.push({ code: "brand_mismatch", message: `This deployment shows the ${deployment.brand} brand, so it takes brands/${deployment.brand}/billing.json, not ${body.brand}'s.`, path: "brand" });
    if (codeHash !== hash && !allowUndeployed) {
      refusals.push({ code: "file_not_deployed", message: codeHash === null ? `The running code has no billing.json for ${body.brand}. Deploy it first, or send allow_undeployed: true to try the file on a sandbox.` : `This file isn't the one the running code was built with (${codeHash.slice(0, 12)}). Deploy the merged file first, or send allow_undeployed: true to try it on a sandbox.`, path: "billing_file" });
    }
    if (body.replaces_hash !== undefined && body.replaces_hash !== latestHash) {
      refusals.push({ code: "catalog_changed", message: latestHash === null ? "Nothing was applied yet, so there is no run to replace. Run a dry run again." : `The latest catalog run has hash ${latestHash}, so someone applied in between. Run a dry run again.`, path: "replaces_hash" });
    }
    const now = new Date().toISOString();
    const diff = diffBillingCatalog({ plans: desiredBillingPlans(profile), currency: profile.currency, current, now });
    refusals.push(...diff.refusals);
    const changes = diff.writes.map((write) => write.change);
    const base = {
      kind: "catalog" as const,
      brand: body.brand,
      ver: profile.version,
      hash,
      prev_hash: latestHash,
      code_hash: codeHash,
      changes,
      problems: [],
      polar_env: null,
      polar_org: null,
      key_id: caller.platformKeyId,
      partner: caller.partnerId,
    };
    if (dryRun) return { run: { id: null, status: "preview" as const, ...base, blocked_by: refusals, started_at: now, ended_at: now }, replayed: false, status: 200 as const };
    if (refusals.length) throw new PublicApiError(409, "conflict", `The billing.json can't be applied: ${refusals.map((refusal) => refusal.code).join(", ")}. details lists each reason.`, refusals.map((refusal) => ({ path: refusal.path, message: refusal.message, code: refusal.code })));

    // The run goes in first: every row written references it. It starts when it holds
    // the lock, not when its transaction began, and after the run before it, so the
    // latest run is always the last one applied, even for two that began together.
    const [run] = await tx.insert(billingRuns).values({
      kind: "catalog",
      startedAt: runStart(current.latest),
      // A file whose only edit is its polar settings is applied with no changes: the latest run's profile is the current one.
      status: changes.length === 0 && latestHash === hash ? "unchanged" : "applied",
      brand: body.brand,
      ver: profile.version,
      hash,
      prevHash: latestHash,
      codeHash,
      profile: normalizeBillingProfile(profile) as unknown as Record<string, unknown>,
      changes,
      problems: [],
      keyId: caller.platformKeyId,
      partner: caller.partnerId,
      idemKey: input.idempotencyKey,
      reqHash: requestHash,
    }).returning({ id: billingRuns.id });
    for (const write of billingCatalogWriteOrder(diff.writes)) await runWrite(tx, write, run!.id);
    const [finished] = (await tx.execute<Row>(sql`update public.billing_runs set ended_at = clock_timestamp() where id = ${run!.id}::uuid returning *`)).rows;
    return { run: runResource(finished!), replayed: false, status: 201 as const };
  }, dryRun ? { accessMode: "read only" } : {});
}

// Links: which Polar product sells each live price.

/**
 * The rows a link writes, and the refusals the tables alone can find. A link
 * names every live price of every sold plan that isn't retired, each with its
 * product, and each plan's discount. A row that has no product gets the one
 * sent; a row with another product keeps it unless replace_ids is sent, which
 * retires the row with its product and puts a new live row beside it, so a
 * subscriber on the old product can still be matched. A sold plan in draft
 * becomes active, since the link is complete. Pure, like the catalog diff.
 */
export function diffBillingLinks(input: { body: Pick<ApiBillingCatalogLink, "plans" | "replace_ids">; current: { plans: StoredBillingPlan[]; prices: StoredBillingPrice[] }; now: string }): BillingCatalogDiff {
  const writes: BillingCatalogWrite[] = [];
  const refusals: ApiBillingCatalogRefusal[] = [];
  const replace = input.body.replace_ids === true;
  const refuse = (code: ApiBillingCatalogRefusal["code"], path: string, message: string) => refusals.push({ code, message, path });
  const targets = new Map(input.current.plans.filter((plan) => plan.sold && plan.status !== "retired").map((plan) => [plan.code, plan]));
  const livePrices = (code: string) => input.current.prices.filter((price) => price.plan === code && price.retired_at === null);
  const owner = (polarId: string) => input.current.prices.find((price) => price.polar_id === polarId);
  const sentIds = new Map<string, number>();
  for (const plan of input.body.plans) for (const price of plan.prices) sentIds.set(price.polar_id, (sentIds.get(price.polar_id) ?? 0) + 1);
  const sentDiscounts = new Map<string, number>();
  for (const plan of input.body.plans) if (plan.polar_disc !== null) sentDiscounts.set(plan.polar_disc, (sentDiscounts.get(plan.polar_disc) ?? 0) + 1);

  // Every sold plan, and every live price of it, is named: a half-linked plan could be sold at a price nobody linked.
  const named = new Set(input.body.plans.map((plan) => plan.code));
  for (const plan of targets.values()) {
    if (!named.has(plan.code)) {
      refuse("links_incomplete", "plans", `${plan.code} is sold and isn't in the link. Name every live price of every sold plan.`);
      continue;
    }
    const sent = input.body.plans.find((entry) => entry.code === plan.code)!;
    for (const price of livePrices(plan.code)) {
      if (!sent.prices.some((entry) => entry.period === price.period && entry.currency === price.currency)) refuse("links_incomplete", `plans.${plan.code}`, `${priceKey(price)} is a live price of ${plan.code} and has no product in the link.`);
    }
  }

  const seen = new Set<string>();
  input.body.plans.forEach((sent, index) => {
    const path = `plans[${index}]`;
    const plan = targets.get(sent.code);
    if (seen.has(sent.code)) {
      refuse("unknown_price", `${path}.code`, `${sent.code} is named twice.`);
      return;
    }
    seen.add(sent.code);
    if (!plan) {
      const stored = input.current.plans.find((entry) => entry.code === sent.code);
      refuse("unknown_price", `${path}.code`, !stored ? `There's no plan ${sent.code}.` : stored.status === "retired" ? `${sent.code} is retired, so nothing sells it.` : `${sent.code} isn't sold through Polar.`);
      return;
    }
    if (sent.terms_hash !== plan.terms_hash) refuse("terms_changed", `${path}.terms_hash`, `${plan.code}'s terms are ${plan.terms_hash.slice(0, 12)} now, not ${sent.terms_hash.slice(0, 12)}: its Polar objects were made from other terms. Set Polar up from the latest file again.`);
    if ((plan.discount === null) !== (sent.polar_disc === null)) refuse("discount_mismatch", `${path}.polar_disc`, plan.discount === null ? `${plan.code} has no discount, so it takes no Polar discount.` : `${plan.code} has a discount, so name its Polar discount.`);

    const periods = new Set<string>();
    const set: Record<string, unknown> = {};
    const fields: ApiBillingCatalogChange["fields"] = {};
    sent.prices.forEach((price, priceIndex) => {
      const pricePath = `${path}.prices[${priceIndex}]`;
      const row = livePrices(plan.code).find((entry) => entry.period === price.period && entry.currency === price.currency);
      if (periods.has(price.period) || !row) {
        refuse("unknown_price", pricePath, periods.has(price.period) ? `${plan.code} ${price.period} is named twice.` : `${plan.code} has no live ${price.period} price in ${price.currency}.`);
        return;
      }
      periods.add(price.period);
      const taken = owner(price.polar_id);
      if ((taken && taken.id !== row.id) || (sentIds.get(price.polar_id) ?? 0) > 1) {
        refuse("id_taken", `${pricePath}.polar_id`, taken && taken.id !== row.id ? `Product ${price.polar_id} is already linked to ${priceKey(taken)}${taken.retired_at ? ", a retired price" : ""}. One product sells one price.` : `Product ${price.polar_id} is named for more than one price. One product sells one price.`);
        return;
      }
      if (row.polar_id === price.polar_id) return;
      if (row.polar_id === null) {
        writes.push({ change: { table: "billing_prices", key: priceKey(row), action: "update", fields: { polar_id: { from: null, to: price.polar_id } }, lowers_allowance: false, raises_price: false }, set: { polar_id: price.polar_id }, id: row.id });
        return;
      }
      if (!replace) {
        refuse("id_changed", `${pricePath}.polar_id`, `${priceKey(row)} is sold by product ${row.polar_id}. Send replace_ids to retire that row with its product and link ${price.polar_id} to a new one.`);
        return;
      }
      writes.push({ change: { table: "billing_prices", key: priceKey(row), action: "retire", fields: {}, lowers_allowance: false, raises_price: false }, set: { retired_at: input.now }, id: row.id });
      writes.push({ change: { table: "billing_prices", key: priceKey(row), action: "insert", fields: { polar_id: { from: row.polar_id, to: price.polar_id } }, lowers_allowance: false, raises_price: false }, set: { plan: row.plan, period: row.period, currency: row.currency, cents: row.cents, polar_id: price.polar_id } });
    });

    if (sent.polar_disc !== null && plan.discount !== null && sent.polar_disc !== plan.polar_disc) {
      const taken = input.current.plans.find((entry) => entry.polar_disc === sent.polar_disc);
      if (taken || (sentDiscounts.get(sent.polar_disc) ?? 0) > 1) refuse("id_taken", `${path}.polar_disc`, `Discount ${sent.polar_disc} is already ${taken ? `linked to ${taken.code}` : "named for another plan"}. One discount belongs to one plan.`);
      else if (plan.polar_disc !== null && !replace) refuse("id_changed", `${path}.polar_disc`, `${plan.code} has discount ${plan.polar_disc}. Send replace_ids to link ${sent.polar_disc} instead.`);
      else {
        set.polar_disc = sent.polar_disc;
        fields.polar_disc = { from: plan.polar_disc, to: sent.polar_disc };
      }
    }
    if (plan.status === "draft") {
      set.status = "active";
      fields.status = { from: "draft", to: "active" };
    }
    if (Object.keys(fields).length) writes.push({ change: { table: "billing_plans", key: plan.code, action: "update", fields, lowers_allowance: false, raises_price: false }, set });
  });

  writes.sort((a, b) => byKey(a.change.table, b.change.table) || byKey(a.change.key, b.change.key) || actionOrder[a.change.action] - actionOrder[b.change.action]);
  return { writes, refusals };
}

/**
 * Records the Polar products and discounts that sell the catalog, or with
 * dry_run shows what it would record. It refuses a link made from another
 * file than the latest catalog run, from another Polar organization than the
 * deployment's or the first link's, or that leaves a sold plan half linked;
 * each reason is a detail of one 409. Idempotency as for an apply.
 */
export async function linkBillingCatalogForApi(context: DomainContext, input: { caller: BillingCatalogCaller; idempotencyKey: string | null; body: ApiBillingCatalogLink; deployment: BillingCatalogDeployment }): Promise<{ run: ApiBillingCatalogRun; replayed: boolean; status: 200 | 201 }> {
  const { body, caller, deployment } = input;
  const dryRun = body.dry_run === true;
  if (!dryRun && !input.idempotencyKey) throw missingKey();
  const polar = deployment.polar ?? noPolar;
  const codeHash = billingProfileHash(body.brand, deployment.codeHashes);
  const requestHash = idempotencyRequestHash({ operation: "linkBillingCatalog", brand: body.brand, hash: body.hash, polar_env: body.polar_env, polar_org: body.polar_org, plans: body.plans, replace_ids: body.replace_ids === true });

  return await withBusinessTransaction(context.db, { actorType: "worker" }, async (tx) => {
    if (!dryRun) {
      // The catalog apply's lock: a link never interleaves with an apply or another link.
      await tx.execute(CATALOG_LOCK);
      const [reused] = (await tx.execute<Row>(sql`select * from public.billing_runs where key_id = ${caller.platformKeyId}::uuid and idem_key = ${input.idempotencyKey}`)).rows;
      if (reused) {
        if (reused.req_hash !== requestHash) throw new PublicApiError(422, "idempotency_key_reused", "This Idempotency-Key was used with a different request.");
        return { run: runResource(reused), replayed: true, status: 201 as const };
      }
    }
    const current = await readCatalog(tx);
    const latestHash = (current.latest?.hash ?? null) as string | null;
    const refusals: ApiBillingCatalogRefusal[] = [];
    if (body.brand !== deployment.brand) refusals.push({ code: "brand_mismatch", message: `This deployment shows the ${deployment.brand} brand, not ${body.brand}.`, path: "brand" });
    if (body.hash !== latestHash) refusals.push({ code: "catalog_changed", message: latestHash === null ? "Nothing was applied yet. Apply the file before linking Polar to it." : `The latest catalog run has hash ${latestHash}, so Polar was set up from another file. Run pnpm billing apply again.`, path: "hash" });
    if (polar.org === null) refusals.push({ code: "polar_org_mismatch", message: "POLAR_ORGANIZATION_ID isn't set on this deployment, so it can't take products from any Polar organization.", path: "polar_org" });
    else if (body.polar_env !== polar.env || body.polar_org !== polar.org) refusals.push({ code: "polar_org_mismatch", message: `This deployment uses Polar ${polar.env} organization ${polar.org}, not ${body.polar_env} ${body.polar_org}.`, path: body.polar_env !== polar.env ? "polar_env" : "polar_org" });
    const latestLink = current.latestLink;
    if (latestLink && (latestLink.polar_env !== body.polar_env || latestLink.polar_org !== body.polar_org)) {
      refusals.push({ code: "polar_org_changed", message: `This deployment was linked to Polar ${String(latestLink.polar_env)} organization ${String(latestLink.polar_org)}, and it stays with it. Live payments get a deployment of their own.`, path: "polar_org" });
    }
    const now = new Date().toISOString();
    const diff = diffBillingLinks({ body, current, now });
    refusals.push(...diff.refusals);
    const changes = diff.writes.map((write) => write.change);
    const base = {
      kind: "polar" as const,
      brand: body.brand,
      ver: Number(current.latest?.ver ?? 1),
      hash: body.hash,
      prev_hash: (latestLink?.hash ?? null) as string | null,
      code_hash: codeHash,
      changes,
      problems: [],
      polar_env: body.polar_env,
      polar_org: body.polar_org,
      key_id: caller.platformKeyId,
      partner: caller.partnerId,
    };
    if (dryRun) return { run: { id: null, status: "preview" as const, ...base, blocked_by: refusals, started_at: now, ended_at: now }, replayed: false, status: 200 as const };
    if (refusals.length) throw new PublicApiError(409, "conflict", `Polar's products can't be linked: ${[...new Set(refusals.map((refusal) => refusal.code))].join(", ")}. details lists each reason.`, refusals.map((refusal) => ({ path: refusal.path, message: refusal.message, code: refusal.code })));

    const [run] = await tx.insert(billingRuns).values({
      kind: "polar",
      startedAt: runStart(latestLink),
      status: changes.length ? "applied" : "unchanged",
      brand: body.brand,
      ver: base.ver,
      hash: body.hash,
      prevHash: base.prev_hash,
      codeHash,
      // The catalog run with the same hash holds the profile.
      profile: {},
      changes,
      problems: [],
      polarEnv: body.polar_env,
      polarOrg: body.polar_org,
      keyId: caller.platformKeyId,
      partner: caller.partnerId,
      idemKey: input.idempotencyKey,
      reqHash: requestHash,
    }).returning({ id: billingRuns.id });
    for (const write of billingCatalogWriteOrder(diff.writes)) await runWrite(tx, write, run!.id);
    const [finished] = (await tx.execute<Row>(sql`update public.billing_runs set ended_at = clock_timestamp() where id = ${run!.id}::uuid returning *`)).rows;
    return { run: runResource(finished!), replayed: false, status: 201 as const };
  }, dryRun ? { accessMode: "read only" } : {});
}

/**
 * Stores the worker's daily check as a verify run against the catalog run it
 * read, with no key: no one asked for it. Returns the run and the status of
 * the verify before it, so a recovery can be told apart from a pass.
 */
export async function recordBillingVerifyRun(context: DomainContext, input: { catalog: { brand: string; ver: number; hash: string }; codeHash: string | null; status: "passed" | "drift" | "failed"; problems: ApiBillingCheck[]; polarEnv: PolarEnv; polarOrg: string }): Promise<{ run: ApiBillingCatalogRun; previousStatus: string | null }> {
  return await withBusinessTransaction(context.db, { actorType: "worker" }, async (tx) => {
    await tx.execute(CATALOG_LOCK);
    const previous = await latestRun(tx, "verify");
    const [run] = await tx.insert(billingRuns).values({
      kind: "verify",
      startedAt: runStart(previous),
      status: input.status,
      brand: input.catalog.brand,
      ver: input.catalog.ver,
      hash: input.catalog.hash,
      prevHash: (previous?.hash ?? null) as string | null,
      codeHash: input.codeHash,
      profile: {},
      changes: [],
      problems: input.problems,
      polarEnv: input.polarEnv,
      polarOrg: input.polarOrg,
    }).returning({ id: billingRuns.id });
    const [finished] = (await tx.execute<Row>(sql`update public.billing_runs set ended_at = clock_timestamp() where id = ${run!.id}::uuid returning *`)).rows;
    return { run: runResource(finished!), previousStatus: (previous?.status ?? null) as string | null };
  });
}

function priceResource(price: StoredBillingPrice): ApiBillingCatalogPrice {
  const { plan: _plan, run_id: _runId, ...rest } = price;
  return rest;
}

function planResource(plan: StoredBillingPlan, prices: StoredBillingPrice[]): ApiBillingCatalogPlan {
  const { run_id: _runId, ...rest } = plan;
  // Live prices first, then the retired ones, latest first.
  const ordered = prices.filter((price) => price.plan === plan.code).sort((a, b) => Number(a.retired_at !== null) - Number(b.retired_at !== null) || byKey(b.retired_at ?? "", a.retired_at ?? "") || byKey(a.period, b.period));
  return { ...rest, discount: rest.discount as Record<string, unknown> | null, prices: ordered.map(priceResource) };
}

/** Every plan and price the deployment holds, the latest apply, whether it matches the file in the running code, and the Polar settings it runs with. */
export async function getBillingCatalogForApi(context: DomainContext, input: { deployment: BillingCatalogDeployment }): Promise<ApiBillingCatalog> {
  const current = await withBusinessTransaction(context.db, { actorType: "worker" }, readCatalog, { accessMode: "read only" });
  const codeHash = billingProfileHash(input.deployment.brand, input.deployment.codeHashes);
  const latest = current.latest ? runResource(current.latest) : null;
  const polar = input.deployment.polar ?? noPolar;
  const polarBlock: ApiBillingCatalogPolar = { env: polar.env, org: polar.org, secret_sha256: polar.secretSha256, product_vars: polar.productVars, last_link: current.latestLink ? runResource(current.latestLink) : null };
  return {
    brand: input.deployment.brand,
    code_hash: codeHash,
    hash: latest?.hash ?? null,
    matches_code: Boolean(codeHash && latest && codeHash === latest.hash),
    last_run: latest,
    profile: (current.latest?.profile ?? null) as Record<string, unknown> | null,
    currency: current.prices.find((price) => price.retired_at === null)?.currency ?? null,
    plans: current.plans.map((plan) => planResource(plan, current.prices)),
    polar: polarBlock,
  };
}

const runKinds = ["catalog", "polar", "verify"] as const;

/** Every run, newest first, with the rows it changed: section 7.5's Q8, one row comparison per page. */
export async function listBillingCatalogRunsForApi(context: DomainContext, input: PageRequest & { kind?: string | undefined }): Promise<Page<ApiBillingCatalogRun>> {
  const limit = pageSize(input.limit);
  const cursor = decodeCursor(input.cursor);
  if (input.kind !== undefined && !(runKinds as readonly string[]).includes(input.kind)) throw invalidRequest("kind must be catalog, polar or verify.", [{ path: "kind", message: "One of catalog, polar or verify." }]);
  // Run times are stored to the millisecond, as the cursor carries them, so the comparison is exact.
  const conditions: SQL[] = [];
  if (input.kind !== undefined) conditions.push(sql`kind = ${input.kind}`);
  if (cursor) conditions.push(sql`(started_at, id) < (${cursor.at.toISOString()}::timestamptz, ${cursor.id}::uuid)`);
  const where = conditions.length ? sql`where ${sql.join(conditions, sql` and `)}` : sql``;
  const rows = await withBusinessTransaction(context.db, { actorType: "worker" }, async (tx) => (await tx.execute<Row>(sql`select * from public.billing_runs ${where} order by started_at desc, id desc limit ${limit + 1}`)).rows, { accessMode: "read only" });
  return toPage(rows, limit, runResource, (row) => ({ at: new Date(iso(row.started_at)), id: String(row.id) }));
}
