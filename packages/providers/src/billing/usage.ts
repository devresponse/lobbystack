import type { BillingUsageKind } from "@lobbystack/shared";
import type { OverageKind } from "./types";

/** The usage that overage bills: a call's seconds, alert text segments and call transfers. */
export type MeteredUsageKind = Extract<BillingUsageKind, "voice_seconds" | "alert_sms_segments" | "outbound_call_attempts">;

const overageKinds: Record<MeteredUsageKind, OverageKind> = {
  voice_seconds: "voice",
  alert_sms_segments: "alert_sms",
  outbound_call_attempts: "transfer",
};

export function isMeteredUsageKind(kind: string): kind is MeteredUsageKind {
  return Object.hasOwn(overageKinds, kind);
}

/** The overage a usage row bills as. */
export function overageKindOf(kind: MeteredUsageKind): OverageKind {
  return overageKinds[kind];
}

/** The usage rows that bill as this overage. */
export function usageKindOf(kind: OverageKind): MeteredUsageKind {
  const found = (Object.keys(overageKinds) as MeteredUsageKind[]).find((usageKind) => overageKinds[usageKind] === kind);
  if (!found) throw new Error(`No usage bills as ${kind}.`);
  return found;
}
