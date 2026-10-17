// The English text of the opt-in shown at the SMS alert phone step, with the
// deployment's name in place of {{appName}}. It must match
// notifications.phoneVerification.phone.consent in the admin's English
// locale; bump the version whenever the wording changes. The version doesn't
// record the name, which is the deployment's (see docs/branding.md).
export const OPERATOR_SMS_DISCLOSURE_VERSION = "operator-alerts-2026-10-17";

export const OPERATOR_SMS_DISCLOSURE_TEMPLATE = "By sending the code, you agree to get {{appName}} alerts by text. Frequency varies. Msg & data rates may apply. Reply STOP to opt out, HELP for help.";

/** The opt-in as the deployment shows it. */
export function operatorSmsDisclosureText(appName: string): string {
  return OPERATOR_SMS_DISCLOSURE_TEMPLATE.replace("{{appName}}", appName);
}

// Consent recorded under an earlier disclosure stays valid; new consent always
// records the current version.
export const OPERATOR_SMS_ACCEPTED_DISCLOSURE_VERSIONS: readonly string[] = ["operator-alerts-2026-05-22", "operator-alerts-2026-10-03", OPERATOR_SMS_DISCLOSURE_VERSION];
