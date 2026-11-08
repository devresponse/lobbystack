import type { LegalProcessor } from "./types"

/**
 * The processor the legal pages name, from the landing build's
 * BILLING_PROVIDER: stripe for Stripe, and anything else for Polar, as the
 * admin and the worker read it.
 */
export function legalProcessorOf(value: string | undefined): LegalProcessor {
  return value?.trim().toLowerCase() === "stripe" ? "stripe" : "polar"
}

/** Each processor's name as the pages write it, in every language. */
export const processorNames: Record<LegalProcessor, string> = {
  polar: "Polar",
  stripe: "Stripe",
}
