import { isUuid } from "@lobbystack/shared";

import { jsonError } from "@/lib/api-helpers";

/**
 * The receptionist a dashboard request names in ?receptionist=, which the
 * pages keep in their address so a filter survives a reload and a shared
 * link. Null when it names none; a 400 for something that can't be one.
 */
export function receptionistIdFromRequest(request: Request, parameter = "receptionist"): string | null {
  const value = new URL(request.url).searchParams.get(parameter)?.trim();
  if (!value) return null;
  if (!isUuid(value)) throw jsonError(`${parameter} must be a receptionist id.`, 400, "invalid_receptionist");
  return value.toLowerCase();
}
