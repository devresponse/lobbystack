/**
 * Someone choosing a plan, waiting for checkout, or on their way to it is not
 * leaving. The upgrade provider and the promo code entry are the writers, each
 * under its own name so neither clears the other's; surfaces that would read a
 * departure into the pointer leaving the window check this first.
 */
const writers = new Set<string>();

export function setUpgradeInProgress(active: boolean, writer = "upgrade"): void {
  if (active) writers.add(writer);
  else writers.delete(writer);
}

export function isUpgradeInProgress(): boolean {
  return writers.size > 0;
}
