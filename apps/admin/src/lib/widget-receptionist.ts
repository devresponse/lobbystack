import { getCachedBusinessSnapshot, snapshotForReceptionist, type DomainContext } from "@lobbystack/domain";
import type { BusinessContextSnapshot } from "@lobbystack/shared";

import type { WidgetSession } from "./widget-access";

/**
 * The business's snapshot and the receptionist that answers the widget: the
 * one its key (or, later, its page) names, or the default receptionist when
 * that one is paused or archived. No receptionist when the snapshot names
 * none, as before its first build or one from before receptionists: the
 * visitor's chat then carries on with its own.
 */
export async function loadWidgetReceptionist(
  context: DomainContext,
  session: Pick<WidgetSession, "businessId" | "receptionistId">,
): Promise<{ snapshot: BusinessContextSnapshot | null; receptionistId: string | undefined }> {
  const snapshot = await getCachedBusinessSnapshot(context, { businessId: session.businessId });
  return { snapshot, receptionistId: snapshot ? snapshotForReceptionist(snapshot, session.receptionistId).receptionist?.id : undefined };
}
