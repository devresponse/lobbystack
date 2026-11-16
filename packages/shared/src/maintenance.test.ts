import { expect, it } from "vitest";

import { isMaintenanceMode } from "./maintenance";

// AUDIT-017: "TRUE" used to leave maintenance off, because the comparison was with "true" alone.
it("turns maintenance on however the setting is written, and off when it isn't set", () => {
  for (const value of ["true", "TRUE", " on ", "1", "yes"]) {
    expect(isMaintenanceMode({ LOBBYSTACK_MAINTENANCE_MODE: value }), value).toBe(true);
  }
  for (const value of ["false", "OFF", "0", "no", ""]) {
    expect(isMaintenanceMode({ LOBBYSTACK_MAINTENANCE_MODE: value }), value).toBe(false);
  }
  expect(isMaintenanceMode({})).toBe(false);
});

it("refuses a value that is neither, so the mistake isn't silence", () => {
  expect(() => isMaintenanceMode({ LOBBYSTACK_MAINTENANCE_MODE: "maintenance" })).toThrow("LOBBYSTACK_MAINTENANCE_MODE must be");
});
