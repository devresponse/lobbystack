/**
 * A switch of the database command line: on for true, 1, yes or on, in any
 * case, and off for anything else, unset included.
 *
 * The services read their true/false settings with `envFlag` from the shared
 * package, which this package does not depend on. Each switch here used to be
 * its own comparison with the text "true", so `VERIFY_RLS_BEHAVIOR=1` skipped
 * the behaviour checks without saying so (AUDIT-017). A word this does not know
 * stays off, as it always was, instead of stopping the command that runs before
 * every deployment.
 */
export function switchOn(value: string | undefined): boolean {
  return ["true", "1", "yes", "on"].includes((value ?? "").trim().toLowerCase());
}
