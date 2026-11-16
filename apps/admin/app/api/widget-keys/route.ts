import { NextResponse } from "next/server";
import { z } from "zod";

import { findWidgetKeyInTransaction, insertWidgetKeyInTransaction, listWidgetKeysInTransaction, readEntryPointReceptionist, setWidgetKeyReceptionistInTransaction, updateWidgetKeyInTransaction, type WidgetKeyPatch, type WidgetKeyRow } from "@lobbystack/domain";
import { isWidgetKeyIssuanceEnabled, widgetConfigSchema } from "@lobbystack/shared";

import { asApiResponse, withOperatorTransaction } from "@/lib/api-helpers";
import { jsonError, parseBody, parseQuery } from "@/lib/request-input";
import { normalizeOrigin, serializeWidgetKeyConfig } from "@/lib/widget-keys";

export const dynamic = "force-dynamic";

// Website chat widget keys. Each names the receptionist that answers its
// chats (receptionistId; a new key names the default one unless the body
// names another). The dashboard alone sees and changes it: the API's widget
// key fields stay as they were.

/** A key as the dashboard shows it, with who answers its chats. */
function dashboardRecord(row: WidgetKeyRow) {
  return { ...serializeWidgetKeyConfig(row), receptionistId: row.receptionistId };
}

const labelField = z.string("A label is text.").trim().max(120, "A label can be 120 characters at most.");
const originsField = z.array(z.string("Each allowed origin is a website address, such as https://example.com."), "allowedOrigins must be a list of website addresses.");
// The domain says what a receptionist id is, and answers 400 invalid_receptionist, as the v1 API does.
const receptionistField = z.unknown().optional();

const widgetKeyCreate = z.object({ label: labelField.optional(), allowedOrigins: originsField.optional(), config: widgetConfigSchema.optional(), receptionistId: receptionistField });
const widgetKeyUpdate = z.object({ label: labelField.nullish(), allowedOrigins: originsField.optional(), config: widgetConfigSchema.optional(), status: z.enum(["active", "disabled", "revoked"], "status is active, disabled or revoked.").optional(), receptionistId: receptionistField })
  .refine((body) => Object.values(body).some((value) => value !== undefined), { error: "Name at least one field to change." });
const widgetKeyId = z.object({ id: z.string("A widget key id is required.").trim().min(1, "A widget key id is required.") });

/** The origins the key may be used from: blank entries dropped, each written the one way, each once. */
function allowedOrigins(value: string[]): string[] {
  return [...new Set(value.filter((item) => item.trim().length > 0).map((item) => normalizeOrigin(item.trim())))];
}

export async function GET(request: Request) {
  try {
    return NextResponse.json(await withOperatorTransaction(request, async ({ businessId, tx }) => {
      const rows = await listWidgetKeysInTransaction(tx, { businessId });
      // The key is public (it sits in the website's script tag), so the dashboard can show its snippet again. Older keys kept only a hash.
      return { keys: rows.map((row) => ({ ...dashboardRecord(row), key: row.status === "revoked" ? null : row.keyValue })) };
    }));
  } catch (error) { return asApiResponse(error); }
}

export async function POST(request: Request) {
  try {
    return NextResponse.json(await withOperatorTransaction(request, async ({ session, businessId, tx }) => {
      if (!isWidgetKeyIssuanceEnabled(process.env)) throw jsonError("New website chat widgets are not available yet.", 403, "widget_issuance_disabled");
      const body = await parseBody(request, widgetKeyCreate);
      const config = (body.config ?? {}) as Record<string, unknown>;
      const label = body.label || undefined;
      const receptionistId = body.receptionistId === undefined || body.receptionistId === null ? undefined : readEntryPointReceptionist(body.receptionistId);
      const { row, key } = await insertWidgetKeyInTransaction(tx, { businessId, label, allowedOrigins: allowedOrigins(body.allowedOrigins ?? []), config });
      if (receptionistId === undefined) return { ok: true, key: { id: row.id, key }, record: dashboardRecord(row) };
      const answering = await setWidgetKeyReceptionistInTransaction(tx, { businessId, actorUserId: session.user.id, widgetKeyId: row.id, receptionistId });
      return { ok: true, key: { id: row.id, key }, record: { ...dashboardRecord(row), receptionistId: answering.receptionistId } };
    }, { minimumRole: "business_admin" }));
  } catch (error) { return asApiResponse(error); }
}

export async function PATCH(request: Request) {
  try {
    return NextResponse.json(await withOperatorTransaction(request, async ({ session, businessId, tx }) => {
      const { id } = parseQuery(request, widgetKeyId);
      const body = await parseBody(request, widgetKeyUpdate);
      const existing = await findWidgetKeyInTransaction(tx, { businessId, widgetKeyId: id });
      if (!existing) throw jsonError("The widget key was not found.", 404, "not_found");
      // A revoked key may sit on a page someone else controls, so it stays off, as through the API.
      if (existing.status === "revoked" && body.status !== undefined && body.status !== "revoked") throw jsonError("A revoked widget key can't be turned back on. Create a new one.", 409);
      const patch: WidgetKeyPatch = {};
      if (body.status !== undefined) patch.status = body.status;
      if (body.allowedOrigins !== undefined) patch.allowedOrigins = allowedOrigins(body.allowedOrigins);
      if (body.config !== undefined) patch.config = body.config as Record<string, unknown>;
      if (body.label !== undefined) patch.label = body.label === null ? null : body.label;
      const receptionistId = body.receptionistId === undefined ? undefined : readEntryPointReceptionist(body.receptionistId);
      if (Object.keys(patch).length === 0 && receptionistId === undefined) throw jsonError("Name at least one field to change.", 400, "invalid_request");
      // Who answers first, so the row the update returns names it.
      if (receptionistId !== undefined) await setWidgetKeyReceptionistInTransaction(tx, { businessId, actorUserId: session.user.id, widgetKeyId: existing.id, receptionistId });
      const row = Object.keys(patch).length
        ? await updateWidgetKeyInTransaction(tx, { businessId, widgetKeyId: id, patch })
        : await findWidgetKeyInTransaction(tx, { businessId, widgetKeyId: existing.id });
      if (!row) throw new Error("The widget key could not be updated.");
      return { ok: true, record: dashboardRecord(row) };
    }, { minimumRole: "business_admin" }));
  } catch (error) { return asApiResponse(error); }
}
