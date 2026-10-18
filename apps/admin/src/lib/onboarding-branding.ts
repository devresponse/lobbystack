import { canSaveInitialBranding } from "@lobbystack/domain";
import { brandFileMatched, currentBrand } from "@lobbystack/shared";

import { getAppDatabase } from "./api-helpers";
import { reportServerError } from "./error-reporting";

/**
 * Whether the brand step asks this person for the deployment's name and logo:
 * nobody has chosen them, and they own every business on the deployment.
 * Never on a deployment whose brand file sets them.
 */
export async function asksInitialBranding(userId: string): Promise<boolean> {
  if (brandFileMatched(currentBrand())) return false;
  try {
    return await canSaveInitialBranding({ db: getAppDatabase().db }, { userId });
  } catch (error) {
    // Onboarding carries on without the brand step rather than stopping here.
    void reportServerError(error, { operation: "initial_branding_check" });
    return false;
  }
}
