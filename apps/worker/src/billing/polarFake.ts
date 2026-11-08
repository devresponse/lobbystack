import type { BillingProvider } from "@lobbystack/providers/billing/types";
import { PolarBilling, type PolarBillingClient } from "@lobbystack/providers/polar/adapter";

/**
 * The Polar billing provider over a fake Polar client, so a test keeps
 * asserting on the client's calls. Kept apart from testing.ts, which the
 * mocks of @lobbystack/shared and @lobbystack/domain import.
 */
export function polarFake(client: Partial<PolarBillingClient>): BillingProvider {
  return new PolarBilling(client as PolarBillingClient, { organizationId: "org-test", env: "sandbox" });
}
