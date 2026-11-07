import { and, eq, isNull } from "drizzle-orm";

import { receptionistProfiles, withBusinessTransaction } from "@lobbystack/db";
import { getCachedBusinessSnapshot, snapshotForReceptionist, type DomainContext } from "@lobbystack/domain";
import type { BusinessContextSnapshot } from "@lobbystack/shared";
import { logEvent } from "@lobbystack/telemetry/node";

import { getWorkerDatabase } from "./api-helpers";
import type { WidgetSession } from "./widget-access";
import { verifyReceptionistPageToken } from "./widget-keys";

/**
 * The business's snapshot and the receptionist that answers the widget: the
 * one its session names (from the page the chat is on) or its key names, or
 * the default receptionist when that one is paused or archived. No
 * receptionist when the snapshot names none, as before its first build or
 * one from before receptionists: the visitor's chat then carries on with its
 * own.
 */
export async function loadWidgetReceptionist(
  context: DomainContext,
  session: Pick<WidgetSession, "businessId" | "receptionistId">,
): Promise<{ snapshot: BusinessContextSnapshot | null; receptionistId: string | undefined }> {
  const snapshot = await getCachedBusinessSnapshot(context, { businessId: session.businessId });
  return { snapshot, receptionistId: snapshot ? snapshotForReceptionist(snapshot, session.receptionistId).receptionist?.id : undefined };
}

/**
 * The receptionist a page's signed token names, for the chat's session: only
 * when the token was signed for this business and this widget key, and the
 * receptionist isn't archived. A paused one is kept, and the default
 * receptionist answers for it until it resumes. Anything else is left out,
 * and the widget's key decides, as on any website.
 */
export async function receptionistFromPageToken(token: string, session: Pick<WidgetSession, "businessId" | "widgetKeyId">): Promise<string | undefined> {
  const payload = verifyReceptionistPageToken(token);
  if (!payload || payload.businessId !== session.businessId || payload.widgetKeyId !== session.widgetKeyId) {
    logEvent("warn", "widget.receptionist_token_rejected", { businessId: session.businessId, widgetKeyId: session.widgetKeyId, reason: payload ? "other_widget" : "invalid" });
    return undefined;
  }
  const found = await withBusinessTransaction(getWorkerDatabase().db, { businessId: session.businessId, actorType: "worker" }, async (tx) => (
    await tx.select({ id: receptionistProfiles.id }).from(receptionistProfiles)
      .where(and(eq(receptionistProfiles.businessId, session.businessId), eq(receptionistProfiles.id, payload.receptionistId), isNull(receptionistProfiles.archivedAt)))
      .limit(1)
  )[0]);
  if (!found) logEvent("info", "widget.receptionist_token_archived", { businessId: session.businessId, widgetKeyId: session.widgetKeyId });
  return found?.id;
}
