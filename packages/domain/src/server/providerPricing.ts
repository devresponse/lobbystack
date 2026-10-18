import { enqueueOutbox, withBusinessTransaction, type NewOutboxMessage } from "@lobbystack/db";

import type { DomainContext } from "./context";

// Twilio fills in a text's or call's price some time after it ends, and
// doesn't say how long that takes. A price check that finds none looks again
// a minute later, then waits twice as long after each miss: 1 + 2 + 4 + … +
// 512 minutes, about 17 hours in all.
export const PROVIDER_PRICE_RECHECKS = 10;
const PROVIDER_PRICE_FIRST_RECHECK_MS = 60_000;

type ProviderPriceRecheck = {
  topic: "sms.syncPrice" | "call.syncPrice";
  businessId: string;
  /** Twilio's message SID for a text; our call ID, or Twilio's call SID, for a call. */
  entityId: string;
  /** The price check's own payload, which the recheck repeats. */
  payload: Record<string, unknown>;
  /** Which recheck this is, from 1 to PROVIDER_PRICE_RECHECKS. */
  recheck: number;
};

/**
 * The outbox job that checks a text's or call's price again: the same check,
 * with `priceRecheck` counting the rechecks. The dedupe key names the text or
 * call rather than the status that queued the check, so a text's "sent" and
 * "delivered" checks share one chain of rechecks.
 */
export function providerPriceRecheckJob(input: ProviderPriceRecheck): NewOutboxMessage {
  const aggregateType = input.topic === "sms.syncPrice" ? "message" : "call";
  return {
    topic: input.topic,
    businessId: input.businessId,
    aggregateType,
    dedupeKey: `${aggregateType}:${input.entityId}:price:recheck:${input.recheck}`,
    payload: { ...input.payload, priceRecheck: input.recheck },
    availableAt: new Date(Date.now() + PROVIDER_PRICE_FIRST_RECHECK_MS * 2 ** (input.recheck - 1)),
  };
}

/** Checks a text's or call's price again later, when Twilio hasn't filled it in yet. */
export async function recheckProviderPrice(context: DomainContext, input: ProviderPriceRecheck): Promise<void> {
  await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, async (tx) => {
    await enqueueOutbox(tx, providerPriceRecheckJob(input));
  });
}
