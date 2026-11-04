import { and, asc, desc, eq, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";

import { auditLogs, businesses, enqueueOutbox, receptionistProfiles, withBusinessTransaction, type DatabaseTransaction } from "@lobbystack/db";
import {
  availableReceptionistHandle,
  isReceptionistHandle,
  isRuntimeLocale,
  alphabeticalReceptionistOrder,
  isAlphabeticalReceptionistOrder,
  isUuid,
  maxReceptionistsPerBusiness,
  receptionistAllowance,
  receptionistHandleFrom,
  receptionistKnowledgeScopes,
  receptionistStatuses,
  receptionistUpgrade,
  MAX_RECEPTIONISTS_PER_REQUEST,
  RECEPTIONIST_DESCRIPTION_MAX_LENGTH,
  RECEPTIONIST_HANDLE_MAX_LENGTH,
  RECEPTIONIST_NAME_MAX_LENGTH,
  type BillingPlanSlug,
  type ReceptionistKnowledgeScope,
  type ReceptionistStatus,
  type ReceptionistUpgrade,
  type RuntimeLocale,
} from "@lobbystack/shared";

import type { DomainContext } from "./context";
import { loadReceptionistView, type ReceptionistView } from "./receptionistProfile";
import { failure, isRecord, isUniqueViolation } from "./requestHelpers";
import { loadBusinessPlanLimits } from "./usage";

// Several receptionists per business. Each is a receptionist_profiles row; the
// one with is_default answers whatever names no receptionist, and the entry
// points of a paused or archived one (app.effective_receptionist). Receptionists
// are archived, never deleted, so calls, chats and questions keep pointing at
// them. The plan limit counts receptionists that are active and not archived;
// the deployment's cap (MAX_RECEPTIONISTS_PER_BUSINESS) also bounds how many a
// business keeps that aren't archived, paused ones included. Callers authorize:
// reading is for anyone on the team, every change for owners and admins.

/** A receptionist as dropdowns and pickers list it. */
export type ReceptionistChoice = {
  id: string;
  name: string;
  description: string;
  handle: string | null;
  isDefault: boolean;
  status: ReceptionistStatus;
  listed: boolean;
  sortOrder: number;
  locale: string | null;
  knowledgeScope: ReceptionistKnowledgeScope;
};

/** A row of the Receptionists page: a receptionist and how many entry points name it. */
export type ReceptionistListItem = ReceptionistChoice & {
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  /** Numbers that ring it; a number that names no receptionist rings the default one. */
  phoneNumbers: number;
  /** Widget keys that open it, the same way. */
  widgetKeys: number;
  /** QR links that open it, paused ones too. */
  entryLinks: number;
};

export type ReceptionistListView = "current" | "archived";

export type ReceptionistListPage = {
  receptionists: ReceptionistListItem[];
  /** Rows matching the view, status and search, across every page. */
  total: number;
  page: number;
  pageSize: number;
  /** The business's receptionists by state, whatever the filters. */
  counts: { active: number; paused: number; archived: number };
};

/** How many receptionists the business may have active, and how many it has. */
export type ReceptionistAllowanceState = {
  plan: BillingPlanSlug;
  /** The plan's number, never more than the deployment's cap. */
  limit: number;
  /** The deployment's cap, which also bounds receptionists that aren't archived, paused ones included. */
  cap: number;
  active: number;
  /** Receptionists that aren't archived, paused ones included. */
  current: number;
  /** Whether one more can be added, or resumed, now. */
  canAdd: boolean;
  /** What raises limit: a plan the business can buy, Enterprise through sales, or nothing. */
  upgrade: ReceptionistUpgrade;
};

/** A new receptionist's fields. Settings it doesn't name come from copyFromId's receptionist, else the default one. */
export type ReceptionistCreateInput = {
  name: string;
  description?: string | undefined;
  /** Its page address, /profile/<slug>/<handle>; made from the name when left out. */
  handle?: string | undefined;
  /** The language its calls open in; null or left out uses the business's. */
  locale?: RuntimeLocale | null | undefined;
  /** New receptionists answer from articles for everyone plus their own unless told otherwise. */
  knowledgeScope?: ReceptionistKnowledgeScope | undefined;
  listed?: boolean | undefined;
  copyFromId?: string | null | undefined;
};

/** Fields the Receptionists page changes; AI settings change the rest (saveReceptionistProfileInTransaction). */
export type ReceptionistIdentityPatch = {
  name?: string;
  description?: string;
  handle?: string;
  locale?: RuntimeLocale | null;
  knowledgeScope?: ReceptionistKnowledgeScope;
  listed?: boolean;
};

const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 50;
const MAX_SEARCH_LENGTH = 80;

const notFound = () => failure("Receptionist not found.", 404, "receptionist_not_found");

function readName(value: unknown): string {
  if (typeof value !== "string") throw failure("name must be a string.", 400, "invalid_name");
  const name = value.replace(/\s+/g, " ").trim();
  if (!name) throw failure("Give the receptionist a name.", 400, "invalid_name");
  if (name.length > RECEPTIONIST_NAME_MAX_LENGTH) throw failure(`Names can be up to ${RECEPTIONIST_NAME_MAX_LENGTH} characters.`, 400, "invalid_name");
  return name;
}

function readDescription(value: unknown): string {
  if (value === null) return "";
  if (typeof value !== "string") throw failure("description must be a string.", 400, "invalid_description");
  const description = value.replace(/\s+/g, " ").trim();
  if (description.length > RECEPTIONIST_DESCRIPTION_MAX_LENGTH) throw failure(`"What it helps with" can be up to ${RECEPTIONIST_DESCRIPTION_MAX_LENGTH} characters.`, 400, "invalid_description");
  return description;
}

function readHandle(value: unknown): string {
  if (typeof value !== "string") throw failure("handle must be a string.", 400, "invalid_handle");
  const handle = value.trim().toLowerCase();
  if (!isReceptionistHandle(handle)) throw failure(`A page address is up to ${RECEPTIONIST_HANDLE_MAX_LENGTH} lower-case letters and digits, joined by single dashes.`, 400, "invalid_handle");
  return handle;
}

function readLocale(value: unknown): RuntimeLocale | null {
  if (value === null || value === "") return null;
  if (!isRuntimeLocale(value)) throw failure("locale is not a language calls support.", 400, "invalid_locale");
  return value;
}

function readScope(value: unknown): ReceptionistKnowledgeScope {
  if (!(receptionistKnowledgeScopes as readonly unknown[]).includes(value)) throw failure("knowledgeScope must be all or audience.", 400, "invalid_knowledge_scope");
  return value as ReceptionistKnowledgeScope;
}

function readBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw failure(`${field} must be true or false.`, 400, `invalid_${field}`);
  return value;
}

/** Reads the body that adds a receptionist. Throws a 400 error naming the first field that is wrong. */
export function readReceptionistCreateInput(body: unknown): ReceptionistCreateInput {
  if (!isRecord(body)) throw failure("A receptionist object is required.", 400, "invalid_body");
  const input: ReceptionistCreateInput = { name: readName(body.name) };
  if (body.description !== undefined) input.description = readDescription(body.description);
  if (body.handle !== undefined && body.handle !== null && body.handle !== "") input.handle = readHandle(body.handle);
  if (body.locale !== undefined) input.locale = readLocale(body.locale);
  if (body.knowledgeScope !== undefined) input.knowledgeScope = readScope(body.knowledgeScope);
  if (body.listed !== undefined) input.listed = readBoolean(body.listed, "listed");
  if (body.copyFromId !== undefined && body.copyFromId !== null) {
    if (!isUuid(body.copyFromId)) throw failure("copyFromId must be a receptionist id.", 400, "invalid_copy_from");
    input.copyFromId = body.copyFromId.toLowerCase();
  }
  return input;
}

/** Reads the body that changes a receptionist's name, page address, language, knowledge or listing. */
export function readReceptionistIdentityPatch(body: unknown): ReceptionistIdentityPatch {
  if (!isRecord(body)) throw failure("A receptionist object is required.", 400, "invalid_body");
  const patch: ReceptionistIdentityPatch = {};
  if (body.name !== undefined) patch.name = readName(body.name);
  if (body.description !== undefined) patch.description = readDescription(body.description);
  if (body.handle !== undefined) patch.handle = readHandle(body.handle);
  if (body.locale !== undefined) patch.locale = readLocale(body.locale);
  if (body.knowledgeScope !== undefined) patch.knowledgeScope = readScope(body.knowledgeScope);
  if (body.listed !== undefined) patch.listed = readBoolean(body.listed, "listed");
  if (!Object.keys(patch).length) throw failure("Send at least one field to change.", 400, "invalid_body");
  return patch;
}

/** Reads a status change: active resumes a paused receptionist, paused pauses it. */
export function readReceptionistStatus(value: unknown): ReceptionistStatus {
  if (!(receptionistStatuses as readonly unknown[]).includes(value)) throw failure("status must be active or paused.", 400, "invalid_status");
  return value as ReceptionistStatus;
}

/** Reads a listing order: every receptionist that isn't archived, once each. */
export function readReceptionistOrder(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > MAX_RECEPTIONISTS_PER_REQUEST) throw failure("receptionistIds must list the receptionists in order.", 400, "invalid_order");
  const ids = value.map((id) => {
    if (!isUuid(id)) throw failure("receptionistIds must list receptionist ids.", 400, "invalid_order");
    return id.toLowerCase();
  });
  if (new Set(ids).size !== ids.length) throw failure("A receptionist appears twice in the order.", 400, "invalid_order");
  return ids;
}

/** Reads the receptionists the business page lists besides the default: receptionist ids, once each, none at all allowed. */
export function readListedReceptionists(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_RECEPTIONISTS_PER_REQUEST) throw failure("receptionistIds must list the receptionists the business page shows.", 400, "invalid_listed");
  const ids = value.map((id) => {
    if (!isUuid(id)) throw failure("receptionistIds must list receptionist ids.", 400, "invalid_listed");
    return id.toLowerCase();
  });
  if (new Set(ids).size !== ids.length) throw failure("A receptionist appears twice.", 400, "invalid_listed");
  return ids;
}

/**
 * Holds the business's receptionists until the transaction ends, so two adds,
 * or an add and a resume, can't both take the last place the plan allows, and
 * two orders don't interleave.
 */
export async function lockReceptionistsInTransaction(tx: DatabaseTransaction, businessId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`receptionists:${businessId}`}, 0))`);
}

const choiceColumns = {
  id: receptionistProfiles.id,
  name: receptionistProfiles.name,
  description: receptionistProfiles.description,
  handle: receptionistProfiles.handle,
  isDefault: receptionistProfiles.isDefault,
  status: receptionistProfiles.status,
  listed: receptionistProfiles.listed,
  sortOrder: receptionistProfiles.sortOrder,
  locale: receptionistProfiles.locale,
  knowledgeScope: receptionistProfiles.knowledgeScope,
};

/** The order every list uses: the default receptionist first, then the order the Receptionists page sets, then by name. */
const listOrder = [desc(receptionistProfiles.isDefault), asc(receptionistProfiles.sortOrder), sql`lower(${receptionistProfiles.name})`, asc(receptionistProfiles.id)] as const;

type LiveReceptionist = { id: string; name: string; isDefault: boolean; sortOrder: number; handle: string | null };

/** The receptionists that aren't archived, in list order: for ordering, and the page addresses they hold. */
async function liveOrder(tx: DatabaseTransaction, businessId: string): Promise<LiveReceptionist[]> {
  return await tx.select({ id: receptionistProfiles.id, name: receptionistProfiles.name, isDefault: receptionistProfiles.isDefault, sortOrder: receptionistProfiles.sortOrder, handle: receptionistProfiles.handle }).from(receptionistProfiles)
    .where(and(eq(receptionistProfiles.businessId, businessId), isNull(receptionistProfiles.archivedAt)))
    .orderBy(...listOrder);
}

/** The page addresses of these receptionists, but except's. */
function handlesOf(live: readonly LiveReceptionist[], except?: string): string[] {
  return live.flatMap((row) => (row.handle && row.id !== except ? [row.handle] : []));
}

/** The place after the last of these receptionists. */
function placeAfter(live: readonly LiveReceptionist[]): number {
  return live.reduce((highest, row) => Math.max(highest, row.sortOrder), 0) + 1;
}

/** The business's language, which names are sorted in. */
async function businessLocale(tx: DatabaseTransaction, businessId: string): Promise<string> {
  const [row] = await tx.select({ locale: businesses.defaultLocale }).from(businesses).where(eq(businesses.id, businessId)).limit(1);
  return row?.locale ?? "en";
}

/**
 * Numbers the receptionists 1, 2, 3… in the order given, in one statement
 * that writes only those whose place changes (up to the deployment's cap,
 * 500 by default). Whether any moved.
 */
async function writeOrder(tx: DatabaseTransaction, businessId: string, receptionistIds: readonly string[], current: ReadonlyMap<string, number>): Promise<boolean> {
  const moves = receptionistIds.flatMap((id, index) => (current.get(id) === index + 1 ? [] : [{ id, sortOrder: index + 1 }]));
  if (!moves.length) return false;
  const places = sql.join(moves.map((move) => sql`when ${move.id}::uuid then ${move.sortOrder}::integer`), sql` `);
  await tx.update(receptionistProfiles).set({ sortOrder: sql`case ${receptionistProfiles.id} ${places} end`, updatedAt: new Date() })
    .where(and(eq(receptionistProfiles.businessId, businessId), inArray(receptionistProfiles.id, moves.map((move) => move.id))));
  return true;
}

/**
 * Puts the receptionists after the default in name order, numbered from 1;
 * the default is first whatever its number. live is the business's
 * receptionists in list order, as liveOrder reads them. Whether any moved.
 * Callers hold the lock.
 */
async function orderByName(tx: DatabaseTransaction, businessId: string, live: readonly LiveReceptionist[], locale: string): Promise<boolean> {
  const defaults = new Set(live.filter((row) => row.isDefault).map((row) => row.id));
  const others = alphabeticalReceptionistOrder(live, locale).filter((id) => !defaults.has(id));
  return await writeOrder(tx, businessId, others, new Map(live.map((row) => [row.id, row.sortOrder])));
}

/** The business's receptionists for dropdowns and pickers, archived ones left out unless asked for. */
export async function listReceptionistChoicesInTransaction(tx: DatabaseTransaction, input: { businessId: string; includeArchived?: boolean }): Promise<ReceptionistChoice[]> {
  return await tx.select(choiceColumns).from(receptionistProfiles)
    .where(and(eq(receptionistProfiles.businessId, input.businessId), input.includeArchived ? undefined : isNull(receptionistProfiles.archivedAt)))
    .orderBy(...listOrder);
}

/** A search term as a LIKE pattern that matches it anywhere, its wildcards taken literally. */
export function receptionistSearchPattern(search: string): string {
  return `%${search.trim().slice(0, MAX_SEARCH_LENGTH).replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

/**
 * A page of the Receptionists page: the receptionists that aren't archived
 * (current) or the archived ones, optionally by status and a search of the
 * name and "What it helps with", in list order, with how many numbers, widget
 * keys and QR links name each.
 */
export async function listReceptionistsInTransaction(
  tx: DatabaseTransaction,
  input: { businessId: string; view?: ReceptionistListView; status?: ReceptionistStatus | undefined; search?: string | undefined; page?: number | undefined; pageSize?: number | undefined },
): Promise<ReceptionistListPage> {
  const pageSize = Math.min(Math.max(Math.trunc(input.pageSize ?? DEFAULT_PAGE_SIZE), 1), MAX_PAGE_SIZE);
  const page = Math.max(Math.trunc(input.page ?? 1), 1);
  const conditions: Array<SQL | undefined> = [
    eq(receptionistProfiles.businessId, input.businessId),
    input.view === "archived" ? isNotNull(receptionistProfiles.archivedAt) : isNull(receptionistProfiles.archivedAt),
    input.status ? eq(receptionistProfiles.status, input.status) : undefined,
  ];
  const search = input.search?.trim();
  if (search) {
    const pattern = receptionistSearchPattern(search);
    conditions.push(or(sql`${receptionistProfiles.name} ilike ${pattern}`, sql`${receptionistProfiles.description} ilike ${pattern}`));
  }
  const where = and(...conditions);
  // A number or widget key naming none means the default one, as
  // app.effective_receptionist reads it. The subqueries name their tables in
  // full: in a one-table select Drizzle prints the columns of a sql`` field
  // without their table, which a correlated subquery would read as its own
  // (as in contacts.ts).
  const namesThis = (alias: string) =>
    sql.raw(`("${alias}"."receptionist_id" = "receptionist_profiles"."id" or ("${alias}"."receptionist_id" is null and "receptionist_profiles"."is_default"))`);
  const rows = await tx.select({
    ...choiceColumns,
    archivedAt: receptionistProfiles.archivedAt,
    createdAt: receptionistProfiles.createdAt,
    updatedAt: receptionistProfiles.updatedAt,
    phoneNumbers: sql<number>`(select count(*)::int from "phone_numbers" as "receptionist_numbers" where "receptionist_numbers"."business_id" = ${input.businessId} and "receptionist_numbers"."status" <> 'reclaimed' and ${namesThis("receptionist_numbers")})`,
    widgetKeys: sql<number>`(select count(*)::int from "widget_keys" as "receptionist_widget_keys" where "receptionist_widget_keys"."business_id" = ${input.businessId} and "receptionist_widget_keys"."status" = 'active' and ${namesThis("receptionist_widget_keys")})`,
    entryLinks: sql<number>`(select count(*)::int from "entry_links" as "receptionist_entry_links" where "receptionist_entry_links"."business_id" = ${input.businessId} and "receptionist_entry_links"."receptionist_id" = "receptionist_profiles"."id")`,
  }).from(receptionistProfiles).where(where).orderBy(...listOrder).limit(pageSize).offset((page - 1) * pageSize);
  const [matching] = await tx.select({ total: sql<number>`count(*)::int` }).from(receptionistProfiles).where(where);
  const [counts] = await tx.select({
    active: sql<number>`count(*) filter (where ${receptionistProfiles.archivedAt} is null and ${receptionistProfiles.status} = 'active')::int`,
    paused: sql<number>`count(*) filter (where ${receptionistProfiles.archivedAt} is null and ${receptionistProfiles.status} = 'paused')::int`,
    archived: sql<number>`count(*) filter (where ${receptionistProfiles.archivedAt} is not null)::int`,
  }).from(receptionistProfiles).where(eq(receptionistProfiles.businessId, input.businessId));
  return {
    receptionists: rows,
    total: matching?.total ?? 0,
    page,
    pageSize,
    counts: { active: counts?.active ?? 0, paused: counts?.paused ?? 0, archived: counts?.archived ?? 0 },
  };
}

/** The business's plan limit on active receptionists, the deployment's cap, and how many it has. */
export async function receptionistAllowanceInTransaction(tx: DatabaseTransaction, input: { businessId: string; env?: Record<string, string | undefined> }): Promise<ReceptionistAllowanceState> {
  const cap = maxReceptionistsPerBusiness(input.env ?? process.env);
  const { plan, limits, tiers } = await loadBusinessPlanLimits(tx, input.businessId);
  const limit = receptionistAllowance(limits.includedReceptionists, cap);
  const [counts] = await tx.select({
    active: sql<number>`count(*) filter (where ${receptionistProfiles.status} = 'active')::int`,
    current: sql<number>`count(*)::int`,
  }).from(receptionistProfiles).where(and(eq(receptionistProfiles.businessId, input.businessId), isNull(receptionistProfiles.archivedAt)));
  const active = counts?.active ?? 0;
  const current = counts?.current ?? 0;
  return { plan, limit, cap, active, current, canAdd: active < limit && current < cap, upgrade: receptionistUpgrade(plan, limit, cap, tiers) };
}

/** The plan's active receptionists are all in use, and what would raise the number. */
function planLimitReached({ limit, upgrade }: Pick<ReceptionistAllowanceState, "limit" | "upgrade">): Error {
  const message = limit === 1
    ? `Your plan includes one receptionist.${upgrade === "plan" ? " Upgrade to add more." : upgrade === "sales" ? " Contact sales about Enterprise to add more." : ""}`
    : `Your plan includes ${limit} active receptionists. Pause one${upgrade === "plan" ? " or upgrade" : upgrade === "sales" ? " or contact sales about Enterprise" : ""} to add another.`;
  return failure(message, 409, "receptionist_limit");
}

/** The business keeps the deployment's cap of receptionists that aren't archived. */
function capReached(cap: number): Error {
  return failure(`A business can keep up to ${cap} receptionists. Archive one to add another.`, 409, "receptionist_cap");
}

const handleTaken = () => failure("Another receptionist already uses this page address.", 409, "handle_taken");

async function writeAudit(tx: DatabaseTransaction, input: { businessId: string; actorUserId: string | null; eventType: string; receptionistId: string; payload: Record<string, unknown> }): Promise<void> {
  await tx.insert(auditLogs).values({ businessId: input.businessId, ...(input.actorUserId ? { actorUserId: input.actorUserId } : {}), eventType: input.eventType, entityType: "receptionist", entityId: input.receptionistId, payload: input.payload });
}

/** The snapshot lists every receptionist for the agent, so any change refreshes it. */
export async function refreshSnapshotForReceptionists(tx: DatabaseTransaction, businessId: string, reason: string, receptionistId?: string): Promise<void> {
  await enqueueOutbox(tx, {
    topic: "snapshot.refresh",
    businessId,
    aggregateType: "receptionist_profile",
    ...(receptionistId ? { aggregateId: receptionistId } : {}),
    dedupeKey: `snapshot:${businessId}:receptionists:${reason}:${receptionistId ?? "all"}:${Date.now()}`,
    payload: { businessId, reason },
  });
}

/**
 * Adds a receptionist with the settings of copyFromId's receptionist, or of
 * the default one, its own name and page address: by name while the
 * receptionists go by name, else last in the list. A 409
 * error when the plan's active receptionists are all in use, or the business
 * keeps the deployment's cap already.
 */
export async function createReceptionistInTransaction(
  tx: DatabaseTransaction,
  input: { businessId: string; actorUserId: string | null; receptionist: ReceptionistCreateInput; env?: Record<string, string | undefined> },
): Promise<ReceptionistView> {
  const { businessId } = input;
  await lockReceptionistsInTransaction(tx, businessId);
  const allowance = await receptionistAllowanceInTransaction(tx, { businessId, ...(input.env ? { env: input.env } : {}) });
  if (allowance.current >= allowance.cap) throw capReached(allowance.cap);
  if (allowance.active >= allowance.limit) throw planLimitReached(allowance);

  const source = await loadReceptionistView(tx, { businessId, receptionistId: input.receptionist.copyFromId ?? null });
  if (!source) throw input.receptionist.copyFromId ? failure("The receptionist to copy from was not found.", 404, "receptionist_not_found") : notFound();

  // One read of the receptionists and the language their names sort in, for the address, the place and the name order.
  const live = await liveOrder(tx, businessId);
  const locale = await businessLocale(tx, businessId);
  const taken = handlesOf(live);
  let handle: string;
  if (input.receptionist.handle) {
    if (taken.includes(input.receptionist.handle)) throw handleTaken();
    handle = input.receptionist.handle;
  } else {
    handle = availableReceptionistHandle(receptionistHandleFrom(input.receptionist.name), taken);
  }
  const byName = isAlphabeticalReceptionistOrder(live, locale);
  const sortOrder = placeAfter(live);

  let created: { id: string } | undefined;
  try {
    [created] = await tx.insert(receptionistProfiles).values({
      businessId,
      name: input.receptionist.name,
      description: input.receptionist.description ?? "",
      handle,
      // The business has its default receptionist already.
      isDefault: false,
      knowledgeScope: input.receptionist.knowledgeScope ?? "audience",
      listed: input.receptionist.listed ?? true,
      sortOrder,
      locale: input.receptionist.locale ?? null,
      status: "active",
      greeting: source.greeting,
      tone: source.tone,
      bookingPolicy: source.bookingPolicy,
      voiceInstructions: source.voiceInstructions,
      smsInstructions: source.smsInstructions,
      chatInstructions: source.chatInstructions,
      transferMode: source.transferMode,
      transferNumber: source.transferNumber,
      bookingMode: source.bookingMode,
    }).returning({ id: receptionistProfiles.id });
  } catch (error) {
    if (isUniqueViolation(error, "receptionist_profiles_business_handle_unique")) throw handleTaken();
    throw error;
  }
  if (!created) throw new Error("Receptionist could not be created.");
  // While the receptionists go by name, the new one takes its place by name;
  // else it goes last. Its place is after every other, so it is last in list
  // order too.
  if (byName) await orderByName(tx, businessId, [...live, { id: created.id, name: input.receptionist.name, isDefault: false, sortOrder, handle }], locale);
  await writeAudit(tx, { businessId, actorUserId: input.actorUserId, eventType: "receptionist.created", receptionistId: created.id, payload: { name: input.receptionist.name, handle, copiedFrom: source.id } });
  await refreshSnapshotForReceptionists(tx, businessId, "receptionist_created", created.id);
  const view = await loadReceptionistView(tx, { businessId, receptionistId: created.id });
  if (!view) throw new Error("Receptionist could not be read back.");
  return view;
}

async function lockReceptionist(tx: DatabaseTransaction, input: { businessId: string; receptionistId: string; archived?: boolean }) {
  if (!isUuid(input.receptionistId)) throw notFound();
  const [row] = await tx.select({
    id: receptionistProfiles.id,
    name: receptionistProfiles.name,
    handle: receptionistProfiles.handle,
    isDefault: receptionistProfiles.isDefault,
    status: receptionistProfiles.status,
    listed: receptionistProfiles.listed,
    archivedAt: receptionistProfiles.archivedAt,
  }).from(receptionistProfiles)
    .where(and(eq(receptionistProfiles.businessId, input.businessId), eq(receptionistProfiles.id, input.receptionistId), input.archived ? isNotNull(receptionistProfiles.archivedAt) : isNull(receptionistProfiles.archivedAt)))
    .limit(1)
    .for("update");
  if (!row) throw notFound();
  return row;
}

/**
 * Changes a receptionist's name, "What it helps with", page address,
 * language, knowledge or listing. The default receptionist answers the
 * business page, so it stays listed.
 */
export async function updateReceptionistInTransaction(
  tx: DatabaseTransaction,
  input: { businessId: string; actorUserId: string | null; receptionistId: string; patch: ReceptionistIdentityPatch },
): Promise<ReceptionistView> {
  const { businessId, patch } = input;
  // A new name can move it in a list that goes by name, and a new page address must be free: both need every receptionist held.
  if (patch.handle !== undefined || patch.name !== undefined) await lockReceptionistsInTransaction(tx, businessId);
  const current = await lockReceptionist(tx, input);
  if (current.isDefault && patch.listed === false) throw failure("The default receptionist answers the business page, so it stays listed.", 409, "default_receptionist");
  const renamed = patch.name !== undefined && patch.name !== current.name;
  const newHandle = patch.handle !== undefined && patch.handle !== current.handle;
  const live = renamed || newHandle ? await liveOrder(tx, businessId) : [];
  const locale = renamed ? await businessLocale(tx, businessId) : "";
  const byName = renamed && isAlphabeticalReceptionistOrder(live, locale);
  if (newHandle && handlesOf(live, current.id).includes(patch.handle!)) throw handleTaken();
  const values = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
  try {
    await tx.update(receptionistProfiles).set({ ...values, updatedAt: new Date() })
      .where(and(eq(receptionistProfiles.businessId, businessId), eq(receptionistProfiles.id, current.id)));
  } catch (error) {
    if (isUniqueViolation(error, "receptionist_profiles_business_handle_unique")) throw handleTaken();
    throw error;
  }
  // Read again: a new name can move it among receptionists in the same place.
  if (byName) await orderByName(tx, businessId, await liveOrder(tx, businessId), locale);
  await writeAudit(tx, { businessId, actorUserId: input.actorUserId, eventType: "receptionist.updated", receptionistId: current.id, payload: { fields: Object.keys(values).sort() } });
  await refreshSnapshotForReceptionists(tx, businessId, "receptionist_updated", current.id);
  const view = await loadReceptionistView(tx, { businessId, receptionistId: current.id });
  if (!view) throw notFound();
  return view;
}

/**
 * Pauses a receptionist, whose numbers, widget keys and links then answer as
 * the default one, or resumes it while the plan has room. The default
 * receptionist is never paused.
 */
export async function setReceptionistStatusInTransaction(
  tx: DatabaseTransaction,
  input: { businessId: string; actorUserId: string | null; receptionistId: string; status: ReceptionistStatus; env?: Record<string, string | undefined> },
): Promise<ReceptionistView> {
  const { businessId } = input;
  await lockReceptionistsInTransaction(tx, businessId);
  const current = await lockReceptionist(tx, input);
  if (current.isDefault && input.status === "paused") throw failure("The default receptionist always answers. Make another one the default first.", 409, "default_receptionist");
  if (current.status !== input.status) {
    if (input.status === "active") {
      const allowance = await receptionistAllowanceInTransaction(tx, { businessId, ...(input.env ? { env: input.env } : {}) });
      if (allowance.active >= allowance.limit) throw planLimitReached(allowance);
    }
    await tx.update(receptionistProfiles).set({ status: input.status, updatedAt: new Date() })
      .where(and(eq(receptionistProfiles.businessId, businessId), eq(receptionistProfiles.id, current.id)));
    await writeAudit(tx, { businessId, actorUserId: input.actorUserId, eventType: input.status === "paused" ? "receptionist.paused" : "receptionist.resumed", receptionistId: current.id, payload: { reason: "operator" } });
    await refreshSnapshotForReceptionists(tx, businessId, `receptionist_${input.status}`, current.id);
  }
  const view = await loadReceptionistView(tx, { businessId, receptionistId: current.id });
  if (!view) throw notFound();
  return view;
}

/**
 * Archives a receptionist: it leaves every list and its entry points answer
 * as the default one, while its calls, chats and questions keep it. The
 * default receptionist is never archived.
 */
export async function archiveReceptionistInTransaction(
  tx: DatabaseTransaction,
  input: { businessId: string; actorUserId: string | null; receptionistId: string },
): Promise<void> {
  const { businessId } = input;
  await lockReceptionistsInTransaction(tx, businessId);
  const current = await lockReceptionist(tx, input);
  if (current.isDefault) throw failure("The default receptionist can't be archived. Make another one the default first.", 409, "default_receptionist");
  await tx.update(receptionistProfiles).set({ archivedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(receptionistProfiles.businessId, businessId), eq(receptionistProfiles.id, current.id)));
  await writeAudit(tx, { businessId, actorUserId: input.actorUserId, eventType: "receptionist.archived", receptionistId: current.id, payload: { name: current.name } });
  await refreshSnapshotForReceptionists(tx, businessId, "receptionist_archived", current.id);
}

/**
 * Brings an archived receptionist back. It comes back paused when the plan's
 * active receptionists are all in use, and with a numbered page address when
 * another receptionist took its own meanwhile.
 */
export async function restoreReceptionistInTransaction(
  tx: DatabaseTransaction,
  input: { businessId: string; actorUserId: string | null; receptionistId: string; env?: Record<string, string | undefined> },
): Promise<ReceptionistView> {
  const { businessId } = input;
  await lockReceptionistsInTransaction(tx, businessId);
  const current = await lockReceptionist(tx, { ...input, archived: true });
  const allowance = await receptionistAllowanceInTransaction(tx, { businessId, ...(input.env ? { env: input.env } : {}) });
  if (allowance.current >= allowance.cap) throw capReached(allowance.cap);
  const status: ReceptionistStatus = current.status === "active" && allowance.active < allowance.limit ? "active" : "paused";
  const live = await liveOrder(tx, businessId);
  const locale = await businessLocale(tx, businessId);
  const handle = availableReceptionistHandle(current.handle ?? receptionistHandleFrom(current.name), handlesOf(live, current.id));
  const byName = isAlphabeticalReceptionistOrder(live, locale);
  const sortOrder = placeAfter(live);
  await tx.update(receptionistProfiles).set({ archivedAt: null, status, handle, sortOrder, updatedAt: new Date() })
    .where(and(eq(receptionistProfiles.businessId, businessId), eq(receptionistProfiles.id, current.id)));
  // Last in list order, like a new one.
  if (byName) await orderByName(tx, businessId, [...live, { id: current.id, name: current.name, isDefault: current.isDefault, sortOrder, handle }], locale);
  await writeAudit(tx, { businessId, actorUserId: input.actorUserId, eventType: "receptionist.restored", receptionistId: current.id, payload: { status, ...(handle !== current.handle ? { handle } : {}) } });
  await refreshSnapshotForReceptionists(tx, businessId, "receptionist_restored", current.id);
  const view = await loadReceptionistView(tx, { businessId, receptionistId: current.id });
  if (!view) throw notFound();
  return view;
}

/**
 * Sets the order pickers and the business page list receptionists in: every
 * receptionist that isn't archived, once each. The default one is listed
 * first wherever visitors choose, whatever its place here.
 */
export async function reorderReceptionistsInTransaction(tx: DatabaseTransaction, input: { businessId: string; receptionistIds: string[] }): Promise<void> {
  const { businessId } = input;
  await lockReceptionistsInTransaction(tx, businessId);
  const rows = await tx.select({ id: receptionistProfiles.id, sortOrder: receptionistProfiles.sortOrder }).from(receptionistProfiles)
    .where(and(eq(receptionistProfiles.businessId, businessId), isNull(receptionistProfiles.archivedAt)));
  const known = new Map(rows.map((row) => [row.id, row.sortOrder]));
  if (rows.length !== input.receptionistIds.length || input.receptionistIds.some((id) => !known.has(id))) {
    throw failure("The order must list every receptionist that isn't archived, once each.", 400, "invalid_order");
  }
  await writeOrder(tx, businessId, input.receptionistIds, known);
  await refreshSnapshotForReceptionists(tx, businessId, "receptionists_reordered");
}

/**
 * Sets which receptionists the business page lists under "You're talking
 * to": receptionistIds' ones, and no other. The default receptionist
 * answers the business page, so it stays listed whether named or not. An
 * unlisted receptionist still opens from its own links, widget keys and page
 * address. A 404 for a receptionist the business doesn't have or archived.
 */
export async function setListedReceptionistsInTransaction(
  tx: DatabaseTransaction,
  input: { businessId: string; actorUserId: string | null; receptionistIds: readonly string[] },
): Promise<void> {
  const { businessId } = input;
  await lockReceptionistsInTransaction(tx, businessId);
  const live = await tx.select({ id: receptionistProfiles.id, isDefault: receptionistProfiles.isDefault, listed: receptionistProfiles.listed }).from(receptionistProfiles)
    .where(and(eq(receptionistProfiles.businessId, businessId), isNull(receptionistProfiles.archivedAt)));
  const known = new Set(live.map((row) => row.id));
  if (input.receptionistIds.some((id) => !known.has(id))) throw notFound();
  const wanted = new Set(input.receptionistIds);
  const changed = live.filter((row) => !row.isDefault && row.listed !== wanted.has(row.id));
  if (!changed.length) return;
  // One statement for those now listed, one for those not, and one for the audit rows.
  const now = new Date();
  for (const listed of [true, false]) {
    const ids = changed.filter((row) => wanted.has(row.id) === listed).map((row) => row.id);
    if (ids.length) {
      await tx.update(receptionistProfiles).set({ listed, updatedAt: now })
        .where(and(eq(receptionistProfiles.businessId, businessId), inArray(receptionistProfiles.id, ids)));
    }
  }
  await tx.insert(auditLogs).values(changed.map((row) => ({
    businessId,
    ...(input.actorUserId ? { actorUserId: input.actorUserId } : {}),
    eventType: "receptionist.updated",
    entityType: "receptionist",
    entityId: row.id,
    payload: { fields: ["listed"], listed: wanted.has(row.id) },
  })));
  await refreshSnapshotForReceptionists(tx, businessId, "receptionists_listed");
}

/**
 * Lists the receptionists by name after the default ("Sort A–Z", and
 * "Alphabetical" on the business page). From then on one added, restored or
 * renamed takes its place by name, until the owner moves one.
 */
export async function sortReceptionistsByNameInTransaction(tx: DatabaseTransaction, input: { businessId: string }): Promise<void> {
  const { businessId } = input;
  await lockReceptionistsInTransaction(tx, businessId);
  if (await orderByName(tx, businessId, await liveOrder(tx, businessId), await businessLocale(tx, businessId))) await refreshSnapshotForReceptionists(tx, businessId, "receptionists_reordered");
}

/**
 * Makes an active receptionist the default one: it answers the business page
 * and whatever names no receptionist. The previous default keeps its numbers,
 * widget keys and links, and gets a page address if it had none. The
 * business's shared settings don't move: they are the business's.
 */
export async function makeDefaultReceptionistInTransaction(
  tx: DatabaseTransaction,
  input: { businessId: string; actorUserId: string | null; receptionistId: string },
): Promise<ReceptionistView> {
  const { businessId } = input;
  await lockReceptionistsInTransaction(tx, businessId);
  const target = await lockReceptionist(tx, input);
  if (target.isDefault) {
    const view = await loadReceptionistView(tx, { businessId, receptionistId: target.id });
    if (!view) throw notFound();
    return view;
  }
  if (target.status !== "active") throw failure("Resume the receptionist before making it the default.", 409, "receptionist_paused");
  const [previous] = await tx.select({ id: receptionistProfiles.id, name: receptionistProfiles.name, handle: receptionistProfiles.handle }).from(receptionistProfiles)
    .where(and(eq(receptionistProfiles.businessId, businessId), eq(receptionistProfiles.isDefault, true)))
    .limit(1)
    .for("update");
  const now = new Date();
  // The default speaks the business's language (AI settings offers it no
  // language of its own), so the new default gives up the one it had.
  await tx.update(receptionistProfiles).set({ locale: null, updatedAt: now })
    .where(and(eq(receptionistProfiles.businessId, businessId), eq(receptionistProfiles.id, target.id)));
  if (previous) {
    const handle = previous.handle ?? availableReceptionistHandle(receptionistHandleFrom(previous.name), handlesOf(await liveOrder(tx, businessId), previous.id));
    await tx.update(receptionistProfiles).set({ isDefault: false, handle, updatedAt: now })
      .where(and(eq(receptionistProfiles.businessId, businessId), eq(receptionistProfiles.id, previous.id)));
  }
  await tx.update(receptionistProfiles).set({ isDefault: true, listed: true, updatedAt: now })
    .where(and(eq(receptionistProfiles.businessId, businessId), eq(receptionistProfiles.id, target.id)));
  await writeAudit(tx, { businessId, actorUserId: input.actorUserId, eventType: "receptionist.default_changed", receptionistId: target.id, payload: { from: previous?.id ?? null, to: target.id } });
  await refreshSnapshotForReceptionists(tx, businessId, "receptionist_default_changed", target.id);
  const view = await loadReceptionistView(tx, { businessId, receptionistId: target.id });
  if (!view) throw notFound();
  return view;
}

/**
 * After the business's plan changes, pauses the newest active receptionists
 * past what the plan allows, the default one never. Their numbers, widget
 * keys and links answer as the default one, nothing is deleted, and the owner
 * picks which to keep. Returns the ids it paused.
 */
export async function enforceReceptionistAllowanceInTransaction(
  tx: DatabaseTransaction,
  input: { businessId: string; env?: Record<string, string | undefined> },
): Promise<string[]> {
  const { businessId } = input;
  await lockReceptionistsInTransaction(tx, businessId);
  const allowance = await receptionistAllowanceInTransaction(tx, { businessId, ...(input.env ? { env: input.env } : {}) });
  const over = allowance.active - allowance.limit;
  if (over <= 0) return [];
  const newest = await tx.select({ id: receptionistProfiles.id }).from(receptionistProfiles)
    .where(and(eq(receptionistProfiles.businessId, businessId), isNull(receptionistProfiles.archivedAt), eq(receptionistProfiles.status, "active"), eq(receptionistProfiles.isDefault, false)))
    .orderBy(desc(receptionistProfiles.createdAt), desc(receptionistProfiles.id))
    .limit(over);
  if (!newest.length) return [];
  const ids = newest.map((row) => row.id);
  await tx.update(receptionistProfiles).set({ status: "paused", updatedAt: new Date() })
    .where(and(eq(receptionistProfiles.businessId, businessId), inArray(receptionistProfiles.id, ids)));
  await tx.insert(auditLogs).values(ids.map((id) => ({ businessId, eventType: "receptionist.paused", entityType: "receptionist", entityId: id, payload: { reason: "plan_limit", plan: allowance.plan, limit: allowance.limit } })));
  await refreshSnapshotForReceptionists(tx, businessId, "receptionists_plan_limit");
  return ids;
}

/**
 * Queues the check that pauses receptionists past the plan's number, for a
 * plan change. It runs as its own job (receptionists.enforceAllowance), so a
 * problem with receptionists never holds up the billing change that queued it.
 */
export async function enqueueReceptionistAllowanceCheck(tx: DatabaseTransaction, businessId: string, reason: string): Promise<void> {
  await enqueueOutbox(tx, {
    topic: "receptionists.enforceAllowance",
    businessId,
    aggregateType: "business",
    aggregateId: businessId,
    dedupeKey: `receptionists-allowance:${businessId}:${reason}:${Date.now()}`,
    payload: { businessId, reason },
  });
}

/** The receptionists.enforceAllowance job: the check above, as the worker. */
export async function enforceReceptionistAllowance(context: DomainContext, input: { businessId: string; env?: Record<string, string | undefined> }): Promise<string[]> {
  return await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, (tx) => enforceReceptionistAllowanceInTransaction(tx, input));
}
