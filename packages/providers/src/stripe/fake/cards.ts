import { declined } from "./errors";

// Stripe's test payment methods and what charging each does, which the later
// flows' tests pay with (checkout, plan changes, the overage invoice).

export const fakeCardOutcomes = {
  pm_card_visa: "succeeded",
  pm_card_chargeDeclined: "declined",
  pm_card_authenticationRequired: "requires_action",
} as const;

export type FakeCard = keyof typeof fakeCardOutcomes;

/** Charges a test card: succeeded or requires_action, or the issuer's decline thrown as Stripe throws it. */
export function chargeFakeCard(card: FakeCard): "succeeded" | "requires_action" {
  const outcome = fakeCardOutcomes[card];
  if (outcome === "declined") throw declined();
  return outcome;
}
