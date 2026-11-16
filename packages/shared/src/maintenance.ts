import { envFlag } from "./env";

/** Maintenance is deliberately opt-in: unset keeps normal operation. */
export function isMaintenanceMode(environment: Readonly<Record<string, string | undefined>>): boolean {
  return envFlag(environment, "LOBBYSTACK_MAINTENANCE_MODE");
}
