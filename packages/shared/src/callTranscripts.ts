/** Who may get an email after each call, as each business chooses. */
export const callTranscriptRecipientChoices = ["nobody", "owners_and_admins", "team"] as const;
export type CallTranscriptRecipients = (typeof callTranscriptRecipientChoices)[number];

/** What that email holds: the summary and a link to the call, or the whole conversation too. */
export const callTranscriptContentChoices = ["summary", "transcript"] as const;
export type CallTranscriptContent = (typeof callTranscriptContentChoices)[number];

/** Why someone on the team can't get the email: the business turned it off, or sends it to owners and admins alone. */
export type CallTranscriptUnavailableReason = "turned_off" | "owners_and_admins_only";

export function isCallTranscriptRecipients(value: unknown): value is CallTranscriptRecipients {
  return typeof value === "string" && (callTranscriptRecipientChoices as readonly string[]).includes(value);
}

export function isCallTranscriptContent(value: unknown): value is CallTranscriptContent {
  return typeof value === "string" && (callTranscriptContentChoices as readonly string[]).includes(value);
}

/** Null when someone with this role on the team may get the email after each call. */
export function callTranscriptUnavailableReason(recipients: CallTranscriptRecipients, role: string): CallTranscriptUnavailableReason | null {
  if (recipients === "nobody") return "turned_off";
  if (recipients === "owners_and_admins" && role !== "business_owner" && role !== "business_admin") return "owners_and_admins_only";
  return null;
}
