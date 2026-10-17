import type { BusinessContextSnapshot, TransferPolicy } from "./index";
import { openStatus } from "./openStatus";
import { transferModes } from "./receptionist";

export function normalizeTransferMode(value: string | null | undefined): TransferPolicy["mode"] {
  if (value == null) return "on_request";
  return (transferModes as readonly string[]).includes(value) ? value as TransferPolicy["mode"] : "never";
}

/** Authoritative transfer gate, including automated provider-failure fallbacks. */
export function isTransferPermitted(
  snapshot: Pick<BusinessContextSnapshot, "transferPolicy" | "timezone" | "hours" | "closures">,
  evidence: { callerRequested?: boolean; urgent?: boolean; now?: Date } = {},
): boolean {
  if (!snapshot.transferPolicy.transferNumber) return false;
  switch (snapshot.transferPolicy.mode) {
    case "always": return true;
    case "on_request": return evidence.callerRequested === true;
    case "on_urgent": return evidence.urgent === true;
    case "during_business_hours": return isBusinessOpen(snapshot, evidence.now);
    default: return false;
  }
}

/** Whether the business is open at `now` in its own timezone: inside a weekly window and outside every closure. */
export function isBusinessOpen(snapshot: Pick<BusinessContextSnapshot, "timezone" | "hours" | "closures">, now: Date = new Date()): boolean {
  return openStatus(snapshot.hours, snapshot.closures, snapshot.timezone, now).openNow;
}
