import { randomInt } from "node:crypto";

import { and, asc, desc, eq, sql, type SQL } from "drizzle-orm";

import { auditLogs, businesses, entryLinkDailyScans, entryLinks, receptionistProfiles, withBusinessTransaction, type DatabaseTransaction } from "@lobbystack/db";
import {
  entryLinkCode,
  entryLinkStatuses,
  isUuid,
  normalizeEntryLinkCode,
  receptionistPagePath,
  ENTRY_LINK_CHART_DAYS,
  ENTRY_LINK_LABEL_MAX_LENGTH,
  ENTRY_LINK_SCAN_RETENTION_MONTHS,
  MAX_ENTRY_LINKS_PER_BUSINESS,
  type EntryLinkStatus,
} from "@lobbystack/shared";

import type { DomainContext } from "./context";
import { receptionistSearchPattern } from "./receptionists";

// QR short links, /q/<code> (migration 0140). A printed sign carries one: it
// opens one receptionist's page, or the business page when the link or its
// receptionist is paused or archived, so a sign always reaches someone. Links
// are paused, never deleted, for the same reason. Scans are counted per link
// and UTC day, with nothing about the visitor, and kept 13 months. Callers
// authorize: reading is for anyone on the team, every change for owners and
// admins.

/** A QR link as the dashboard lists it. */
export type EntryLink = {
  id: string;
  code: string;
  label: string;
  status: EntryLinkStatus;
  /** The receptionist the link names. */
  receptionistId: string;
  /** The receptionist it opens now: the one it names, or the default one when the link or that receptionist is paused or archived. */
  opensReceptionistId: string;
  createdAt: Date;
  updatedAt: Date;
  /** Scans in the last 30 UTC days, today included. */
  scansLast30Days: number;
  /** Scans in the 13 months kept. */
  scansKept: number;
  /** The last UTC day it was scanned, as YYYY-MM-DD. */
  lastScannedOn: string | null;
};

export type EntryLinkPage = { links: EntryLink[]; total: number; page: number; pageSize: number };

/** A new link: who it opens and where its sign hangs. */
export type EntryLinkCreateInput = { receptionistId: string; label: string };

/** What the dashboard changes on a link. */
export type EntryLinkPatch = { receptionistId?: string; label?: string; status?: EntryLinkStatus };

/** One UTC day of a link's scan chart. Days without scans are left out. */
export type EntryLinkScanDay = { day: string; scans: number };

const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 50;
// A clash among 887 million codes is rare; a few tries make one unlikely ever to show.
const CODE_ATTEMPTS = 8;

function failure(message: string, status: number, code: string): Error {
  return Object.assign(new Error(message), { status, code });
}

const notFound = () => failure("QR link not found.", 404, "entry_link_not_found");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readReceptionistId(value: unknown): string {
  if (typeof value !== "string" || !isUuid(value)) throw failure("receptionistId must name a receptionist.", 400, "invalid_receptionist");
  return value.toLowerCase();
}

function readLabel(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") throw failure("label must be a string.", 400, "invalid_label");
  const label = value.replace(/\s+/g, " ").trim();
  if (label.length > ENTRY_LINK_LABEL_MAX_LENGTH) throw failure(`Labels can be up to ${ENTRY_LINK_LABEL_MAX_LENGTH} characters.`, 400, "invalid_label");
  return label;
}

function readStatus(value: unknown): EntryLinkStatus {
  if (!(entryLinkStatuses as readonly unknown[]).includes(value)) throw failure("status must be active or paused.", 400, "invalid_status");
  return value as EntryLinkStatus;
}

/** Reads the body that adds a link. Throws a 400 error naming the first field that is wrong. */
export function readEntryLinkCreateInput(body: unknown): EntryLinkCreateInput {
  if (!isRecord(body)) throw failure("A QR link object is required.", 400, "invalid_body");
  return { receptionistId: readReceptionistId(body.receptionistId), label: readLabel(body.label) };
}

/** Reads the body that changes a link: at least one of its receptionist, label and status. */
export function readEntryLinkPatch(body: unknown): EntryLinkPatch {
  if (!isRecord(body)) throw failure("A QR link object is required.", 400, "invalid_body");
  const patch: EntryLinkPatch = {
    ...(body.receptionistId !== undefined ? { receptionistId: readReceptionistId(body.receptionistId) } : {}),
    ...(body.label !== undefined ? { label: readLabel(body.label) } : {}),
    ...(body.status !== undefined ? { status: readStatus(body.status) } : {}),
  };
  if (!Object.keys(patch).length) throw failure("Change the receptionist, the label or the status.", 400, "invalid_body");
  return patch;
}

/** Holds the business's links until the transaction ends, so two adds can't both take the last place. */
async function lockEntryLinks(tx: DatabaseTransaction, businessId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`entry_links:${businessId}`}, 0))`);
}

/** A receptionist a link may name: the business's own, not archived. Paused ones are allowed, and their links open the default one until they resume. */
async function requireLinkableReceptionist(tx: DatabaseTransaction, businessId: string, receptionistId: string): Promise<void> {
  const [row] = await tx.select({ id: receptionistProfiles.id }).from(receptionistProfiles)
    .where(and(eq(receptionistProfiles.businessId, businessId), eq(receptionistProfiles.id, receptionistId), sql`${receptionistProfiles.archivedAt} is null`))
    .limit(1);
  if (!row) throw failure("The receptionist was not found, or is archived.", 404, "receptionist_not_found");
}

const todayUtc = (now: Date) => now.toISOString().slice(0, 10);

/** The link columns every list reads, with its scan counts. */
function linkColumns(today: string) {
  return {
    id: entryLinks.id,
    code: entryLinks.code,
    label: entryLinks.label,
    status: entryLinks.status,
    receptionistId: entryLinks.receptionistId,
    opensReceptionistId: sql<string>`app.effective_receptionist(${entryLinks.businessId}, case when ${entryLinks.status} = 'active' then ${entryLinks.receptionistId} end)`,
    createdAt: entryLinks.createdAt,
    updatedAt: entryLinks.updatedAt,
    scansLast30Days: sql<number>`coalesce((select sum(scan.scans) from public.entry_link_daily_scans scan where scan.entry_link_id = ${entryLinks.id} and scan.day > ${today}::date - 30), 0)::int`,
    scansKept: sql<number>`coalesce((select sum(scan.scans) from public.entry_link_daily_scans scan where scan.entry_link_id = ${entryLinks.id}), 0)::int`,
    lastScannedOn: sql<string | null>`(select max(scan.day)::text from public.entry_link_daily_scans scan where scan.entry_link_id = ${entryLinks.id})`,
  };
}

/**
 * A page of the business's QR links, newest first, optionally those of one
 * receptionist, by status and a search of the label and code.
 */
export async function listEntryLinksInTransaction(
  tx: DatabaseTransaction,
  input: { businessId: string; receptionistId?: string | undefined; status?: EntryLinkStatus | undefined; search?: string | undefined; page?: number | undefined; pageSize?: number | undefined; now?: Date },
): Promise<EntryLinkPage> {
  const pageSize = Math.min(Math.max(Math.trunc(input.pageSize ?? DEFAULT_PAGE_SIZE), 1), MAX_PAGE_SIZE);
  const page = Math.max(Math.trunc(input.page ?? 1), 1);
  const search = input.search?.trim();
  const filters: SQL[] = [eq(entryLinks.businessId, input.businessId)];
  if (input.receptionistId) filters.push(eq(entryLinks.receptionistId, input.receptionistId));
  if (input.status) filters.push(eq(entryLinks.status, input.status));
  if (search) {
    const pattern = receptionistSearchPattern(search);
    filters.push(sql`(${entryLinks.label} ilike ${pattern} or ${entryLinks.code} ilike ${pattern})`);
  }
  const where = and(...filters);
  const [counted] = await tx.select({ total: sql<number>`count(*)::int` }).from(entryLinks).where(where);
  const links = await tx.select(linkColumns(todayUtc(input.now ?? new Date()))).from(entryLinks)
    .where(where)
    .orderBy(desc(entryLinks.createdAt), asc(entryLinks.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  return { links, total: counted?.total ?? 0, page, pageSize };
}

async function readEntryLink(tx: DatabaseTransaction, input: { businessId: string; linkId: string; now?: Date }): Promise<EntryLink | null> {
  if (!isUuid(input.linkId)) return null;
  const [link] = await tx.select(linkColumns(todayUtc(input.now ?? new Date()))).from(entryLinks)
    .where(and(eq(entryLinks.businessId, input.businessId), eq(entryLinks.id, input.linkId)))
    .limit(1);
  return link ?? null;
}

/** One link, or null for one the business doesn't have. */
export async function getEntryLinkInTransaction(tx: DatabaseTransaction, input: { businessId: string; linkId: string; now?: Date }): Promise<EntryLink | null> {
  return await readEntryLink(tx, input);
}

async function writeAudit(tx: DatabaseTransaction, input: { businessId: string; actorUserId: string | null; eventType: string; linkId: string; payload: Record<string, unknown> }): Promise<void> {
  await tx.insert(auditLogs).values({ businessId: input.businessId, ...(input.actorUserId ? { actorUserId: input.actorUserId } : {}), eventType: input.eventType, entityType: "entry_link", entityId: input.linkId, payload: input.payload });
}

/**
 * Adds a link with a new code for a receptionist that isn't archived. A 409
 * error once the business keeps the most links it may; a 503 error in the
 * unlikely case that every code tried was taken.
 */
export async function createEntryLinkInTransaction(
  tx: DatabaseTransaction,
  input: { businessId: string; actorUserId: string | null; link: EntryLinkCreateInput; randomIndex?: (size: number) => number },
): Promise<EntryLink> {
  const { businessId, link } = input;
  await lockEntryLinks(tx, businessId);
  await requireLinkableReceptionist(tx, businessId, link.receptionistId);
  const [counted] = await tx.select({ total: sql<number>`count(*)::int` }).from(entryLinks).where(eq(entryLinks.businessId, businessId));
  if ((counted?.total ?? 0) >= MAX_ENTRY_LINKS_PER_BUSINESS) throw failure(`A business can keep up to ${MAX_ENTRY_LINKS_PER_BUSINESS} QR links. Change a paused one instead.`, 409, "entry_link_limit");
  const randomIndex = input.randomIndex ?? ((size: number) => randomInt(size));
  for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt += 1) {
    const code = entryLinkCode(randomIndex);
    // Codes are unique across the deployment: one taken by any business is skipped without failing the transaction.
    const [created] = await tx.insert(entryLinks).values({
      businessId,
      receptionistId: link.receptionistId,
      code,
      label: link.label,
      status: "active",
      ...(input.actorUserId ? { createdByUserId: input.actorUserId } : {}),
    }).onConflictDoNothing({ target: entryLinks.code }).returning({ id: entryLinks.id });
    if (!created) continue;
    await writeAudit(tx, { businessId, actorUserId: input.actorUserId, eventType: "entry_link.created", linkId: created.id, payload: { code, receptionistId: link.receptionistId, label: link.label } });
    const view = await readEntryLink(tx, { businessId, linkId: created.id });
    if (!view) throw new Error("QR link could not be read back.");
    return view;
  }
  throw failure("No free code was found. Try again.", 503, "entry_link_code_unavailable");
}

/** Changes a link's receptionist, label or status. Its code never changes, so printed signs keep working. */
export async function updateEntryLinkInTransaction(
  tx: DatabaseTransaction,
  input: { businessId: string; actorUserId: string | null; linkId: string; patch: EntryLinkPatch },
): Promise<EntryLink> {
  const { businessId, patch } = input;
  if (!isUuid(input.linkId)) throw notFound();
  const [current] = await tx.select({ id: entryLinks.id, receptionistId: entryLinks.receptionistId, label: entryLinks.label, status: entryLinks.status })
    .from(entryLinks)
    .where(and(eq(entryLinks.businessId, businessId), eq(entryLinks.id, input.linkId)))
    .limit(1)
    .for("update");
  if (!current) throw notFound();
  if (patch.receptionistId !== undefined && patch.receptionistId !== current.receptionistId) await requireLinkableReceptionist(tx, businessId, patch.receptionistId);
  const changes = Object.fromEntries(Object.entries(patch).filter(([field, value]) => current[field as keyof typeof current] !== value)) as EntryLinkPatch;
  if (Object.keys(changes).length) {
    await tx.update(entryLinks).set({ ...changes, updatedAt: new Date() }).where(and(eq(entryLinks.businessId, businessId), eq(entryLinks.id, current.id)));
    await writeAudit(tx, {
      businessId,
      actorUserId: input.actorUserId,
      eventType: "entry_link.updated",
      linkId: current.id,
      payload: Object.fromEntries(Object.entries(changes).map(([field, value]) => [field, { from: current[field as keyof typeof current], to: value }])),
    });
  }
  const view = await readEntryLink(tx, { businessId, linkId: current.id });
  if (!view) throw notFound();
  return view;
}

/** A link's scans per UTC day over the chart's days, today included. */
export async function listEntryLinkScansInTransaction(tx: DatabaseTransaction, input: { businessId: string; linkId: string; days?: number; now?: Date }): Promise<EntryLinkScanDay[]> {
  if (!isUuid(input.linkId)) return [];
  const days = Math.min(Math.max(Math.trunc(input.days ?? ENTRY_LINK_CHART_DAYS), 1), 400);
  const today = todayUtc(input.now ?? new Date());
  return await tx.select({ day: entryLinkDailyScans.day, scans: entryLinkDailyScans.scans }).from(entryLinkDailyScans)
    .where(and(eq(entryLinkDailyScans.businessId, input.businessId), eq(entryLinkDailyScans.entryLinkId, input.linkId), sql`${entryLinkDailyScans.day} > ${today}::date - ${days}::int`))
    .orderBy(asc(entryLinkDailyScans.day));
}

/** Where a scan of a code goes. */
export type EntryLinkDestination = {
  businessId: string;
  entryLinkId: string;
  /** The receptionist it opens now. */
  receptionistId: string;
  /** /profile/<slug>/<handle>, or /profile/<slug> for the default receptionist. */
  path: string;
};

/**
 * Follows a scan of /q/<code>: finds the link without a business context
 * (app.resolve_entry_link, which leaves out inactive businesses), counts the
 * scan when asked, and gives the page to open. Null for a code that isn't a
 * link. Runs as the worker; context.db must be the worker database.
 */
export async function followEntryLink(context: DomainContext, input: { code: string; count?: boolean; now?: Date }): Promise<EntryLinkDestination | null> {
  const code = normalizeEntryLinkCode(input.code);
  if (!code) return null;
  const resolved = await context.db.execute<{ business_id: string | null; entry_link_id: string | null; receptionist_id: string | null }>(sql`select business_id, entry_link_id, receptionist_id from app.resolve_entry_link(${code})`);
  const match = resolved.rows[0];
  if (!match?.business_id || !match.entry_link_id || !match.receptionist_id) return null;
  const { business_id: businessId, entry_link_id: entryLinkId, receptionist_id: receptionistId } = match;
  const day = todayUtc(input.now ?? new Date());
  const target = await withBusinessTransaction(context.db, { businessId, actorType: "worker" }, async (tx) => {
    if (input.count !== false) {
      await tx.insert(entryLinkDailyScans).values({ businessId, entryLinkId, day, scans: 1 })
        .onConflictDoUpdate({ target: [entryLinkDailyScans.entryLinkId, entryLinkDailyScans.day], set: { scans: sql`${entryLinkDailyScans.scans} + 1` } });
    }
    const [row] = await tx.select({ slug: businesses.slug, handle: receptionistProfiles.handle, isDefault: receptionistProfiles.isDefault })
      .from(businesses)
      .innerJoin(receptionistProfiles, and(eq(receptionistProfiles.businessId, businesses.id), eq(receptionistProfiles.id, receptionistId)))
      .where(eq(businesses.id, businessId))
      .limit(1);
    return row ?? null;
  });
  if (!target) return null;
  return { businessId, entryLinkId, receptionistId, path: receptionistPagePath(target.slug, target.isDefault ? null : target.handle) };
}

/** Scan days older than the 13 months kept, for the privacy sweep. */
export async function deleteExpiredEntryLinkScansInTransaction(tx: DatabaseTransaction, input: { businessId: string; now: Date }): Promise<number> {
  const deleted = await tx.delete(entryLinkDailyScans)
    .where(and(eq(entryLinkDailyScans.businessId, input.businessId), sql`${entryLinkDailyScans.day} < (${todayUtc(input.now)}::date - make_interval(months => ${ENTRY_LINK_SCAN_RETENTION_MONTHS}))::date`))
    .returning({ day: entryLinkDailyScans.day });
  return deleted.length;
}
