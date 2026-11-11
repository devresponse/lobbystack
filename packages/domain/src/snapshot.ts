import type {
  BusinessContextSnapshot,
  AgentRuleSummary,
  ClosureWindow,
  HoursWindow,
  KnowledgeSnippet,
  ServiceSummary,
  SnapshotKnowledgeDocument,
  SnapshotReceptionist,
  TransferPolicy,
  AppointmentChangePolicy,
  BookingMode,
} from "@lobbystack/shared";
import { MAX_DIGEST_DOCUMENTS_PER_RECEPTIONIST, MAX_OTHER_RECEPTIONISTS_IN_PROMPT, MAX_SNIPPETS_PER_RECEPTIONIST, receptionistMayUse, RULE_CONTENT_CALL_MAX_LENGTH, RULE_TITLE_MAX_LENGTH, RULES_CALL_MAX } from "@lobbystack/shared";

import { withinKnowledgeBudget } from "./knowledgeRanking";

type SnapshotBuilderInput = {
  businessId: string;
  version: string;
  generatedAt: string;
  displayName: string;
  legalName?: string;
  timezone: string;
  defaultLocale: BusinessContextSnapshot["defaultLocale"];
  businessType: BusinessContextSnapshot["businessType"];
  telemetryEnabled?: boolean;
  greeting: string;
  recordingNotice?: boolean;
  tone: string;
  bookingPolicy: string;
  voiceInstructions?: string;
  smsInstructions?: string;
  chatInstructions?: string;
  summary: string;
  hours: Array<HoursWindow>;
  closures: Array<ClosureWindow>;
  services: Array<ServiceSummary>;
  rules?: Array<AgentRuleSummary>;
  snippets: Array<KnowledgeSnippet>;
  knowledgeDigest?: string;
  transferPolicy: TransferPolicy;
  appointmentChangePolicy?: AppointmentChangePolicy;
  bookingMode?: BookingMode;
  phoneNumber?: string;
  smsNumber?: string;
  email?: string;
  /** Every receptionist that isn't archived, the default first; the fields above are the default's. */
  receptionists?: Array<SnapshotReceptionist>;
  /** Text entries other receptionists use that `snippets`, the default's, leaves out. */
  extraSnippets?: Array<KnowledgeSnippet>;
  /** The documents the receptionists' digests list, newest first. */
  knowledgeDocuments?: Array<SnapshotKnowledgeDocument>;
  publicPageUrl?: string;
};

export const MAX_AGENT_RULES_PER_SNAPSHOT = RULES_CALL_MAX;
export const MAX_AGENT_RULE_TITLE_CHARS = RULE_TITLE_MAX_LENGTH;
export const MAX_AGENT_RULE_CONTENT_CHARS = RULE_CONTENT_CALL_MAX_LENGTH;
// Knowledge search matches all of these; prompts list only the top few (agent-core's PROMPT_MAX_FAQS).
export const MAX_KNOWLEDGE_SNIPPETS_PER_SNAPSHOT = MAX_SNIPPETS_PER_RECEPTIONIST;

/** Tokens the knowledge digest, the list of documents a prompt names as topics, may take. */
export const KNOWLEDGE_DIGEST_TOKENS = 1_600;

/**
 * The instructions for each channel: the receptionist's own, or the ones the
 * snapshot writes from its tone when it has none.
 */
export function channelInstructions(input: { displayName: string; timezone: string; tone: string; voiceInstructions?: string | null | undefined; smsInstructions?: string | null | undefined; chatInstructions?: string | null | undefined }): { voiceInstructions: string; smsInstructions: string; chatInstructions: string } {
  const commonConstraints = [
    `You are the AI receptionist for ${input.displayName}.`,
    `Use the business timezone ${input.timezone}.`,
    "Use structured business facts as the source of truth for hours, services, and transfer rules.",
    "Never promise a booking until the booking tool confirms success.",
  ].join(" ");
  return {
    voiceInstructions: input.voiceInstructions ?? `${commonConstraints} Speak in a ${input.tone} tone. Keep answers concise and helpful.`,
    smsInstructions: input.smsInstructions ?? `${commonConstraints} Reply clearly in SMS form. Ask one follow-up question at a time.`,
    chatInstructions: input.chatInstructions ?? `${commonConstraints} Be friendly and concise. Use short paragraphs and plain language.`,
  };
}

/** The knowledge digest: one JSON line per document, newest first, within its token budget. */
export function knowledgeDigestOf(documents: ReadonlyArray<Pick<SnapshotKnowledgeDocument, "title" | "sourceUrl" | "tags" | "revision">>): string {
  const rows = documents.map(({ title, sourceUrl, tags, revision }) => ({ title, sourceUrl, tags, revision }));
  return withinKnowledgeBudget(rows, KNOWLEDGE_DIGEST_TOKENS, (row) => JSON.stringify(row)).map((row) => JSON.stringify(row)).join("\n");
}

export function buildBusinessContextSnapshot(
  input: SnapshotBuilderInput,
): BusinessContextSnapshot {
  const instructions = channelInstructions(input);

  return {
    businessId: input.businessId,
    version: input.version,
    generatedAt: input.generatedAt,
    displayName: input.displayName,
    ...(input.legalName ? { legalName: input.legalName } : {}),
    timezone: input.timezone,
    defaultLocale: input.defaultLocale,
    businessType: input.businessType,
    ...(input.telemetryEnabled !== undefined ? { telemetryEnabled: input.telemetryEnabled } : {}),
    greeting: input.greeting,
    recordingNotice: input.recordingNotice ?? true,
    ...instructions,
    summary: input.summary,
    bookingPolicy: input.bookingPolicy,
    knowledgeDigest: input.knowledgeDigest ?? "",
    transferPolicy: input.transferPolicy,
    ...(input.appointmentChangePolicy ? { appointmentChangePolicy: input.appointmentChangePolicy } : {}),
    ...(input.bookingMode ? { bookingMode: input.bookingMode } : {}),
    hours: input.hours,
    closures: input.closures,
    services: input.services,
    rules: (input.rules ?? [])
      .slice()
      .sort((left, right) => left.order - right.order)
      .slice(0, MAX_AGENT_RULES_PER_SNAPSHOT)
      .map((rule) => ({
        ...rule,
        title: rule.title.slice(0, MAX_AGENT_RULE_TITLE_CHARS),
        content: rule.content.slice(0, MAX_AGENT_RULE_CONTENT_CHARS),
      })),
    knowledgeSnippets: input.snippets
      .slice()
      .sort((left, right) => right.priority - left.priority)
      .slice(0, MAX_KNOWLEDGE_SNIPPETS_PER_SNAPSHOT),
    contactChannels: {
      ...(input.phoneNumber ? { phoneNumber: input.phoneNumber } : {}),
      ...(input.smsNumber ? { smsNumber: input.smsNumber } : {}),
      ...(input.email ? { email: input.email } : {}),
    },
    ...(input.receptionists?.length ? { receptionists: input.receptionists } : {}),
    ...(input.extraSnippets?.length ? { extraKnowledgeSnippets: input.extraSnippets } : {}),
    ...(input.knowledgeDocuments ? { knowledgeDocuments: input.knowledgeDocuments } : {}),
    ...(input.publicPageUrl ? { publicPageUrl: input.publicPageUrl } : {}),
  };
}

/**
 * One receptionist's view of a stored snapshot, in the shape calls and chats
 * have always read: its own greeting, instructions, booking and transfer
 * settings and language, the settings every receptionist shares, its text
 * entries and the documents it may use, its name, and the other listed
 * receptionists it can send visitors to (12 at most, in the Receptionists
 * page's order). A receptionist that is paused, archived or unknown gets the
 * default's view, as its entry points answer as the default; so does null. A
 * snapshot built before receptionists is already the default's view. Nothing
 * about other receptionists' settings or entries is left in the view.
 */
export function snapshotForReceptionist(snapshot: BusinessContextSnapshot, receptionistId?: string | null): BusinessContextSnapshot {
  const { receptionists, extraKnowledgeSnippets, knowledgeDocuments, receptionist: _receptionist, otherReceptionists: _others, moreReceptionists: _more, ...base } = snapshot;
  const fallback = receptionists?.find((entry) => entry.isDefault) ?? receptionists?.[0];
  if (!receptionists || !fallback) return base;
  const named = receptionistId ? receptionists.find((entry) => entry.id === receptionistId) : undefined;
  const chosen = named?.status === "active" ? named : fallback;
  const entries = new Map([...(base.knowledgeSnippets ?? []), ...(extraKnowledgeSnippets ?? [])].map((entry) => [entry.id, entry]));
  const knowledgeSnippets = chosen.snippetIds.flatMap((id) => {
    const entry = entries.get(id);
    return entry ? [entry] : [];
  });
  const knowledgeDigest = knowledgeDocuments
    ? knowledgeDigestOf(knowledgeDocuments.filter((document) => receptionistMayUse(chosen, document)).slice(0, MAX_DIGEST_DOCUMENTS_PER_RECEPTIONIST))
    : base.knowledgeDigest;
  const listedOthers = receptionists.filter((entry) => entry.id !== chosen.id && entry.listed && entry.status === "active");
  const otherReceptionists = listedOthers.slice(0, MAX_OTHER_RECEPTIONISTS_IN_PROMPT)
    .map((entry) => ({ name: entry.name, description: entry.description, ...(entry.pageUrl ? { pageUrl: entry.pageUrl } : {}) }));
  return {
    ...base,
    defaultLocale: chosen.locale ?? base.defaultLocale,
    greeting: chosen.greeting,
    voiceInstructions: chosen.voiceInstructions,
    smsInstructions: chosen.smsInstructions,
    chatInstructions: chosen.chatInstructions,
    bookingPolicy: chosen.bookingPolicy,
    bookingMode: chosen.bookingMode,
    transferPolicy: chosen.transferPolicy,
    knowledgeSnippets,
    knowledgeDigest,
    receptionist: { id: chosen.id, name: chosen.name, description: chosen.description, isDefault: chosen.isDefault },
    ...(otherReceptionists.length ? { otherReceptionists } : {}),
    ...(listedOthers.length > otherReceptionists.length ? { moreReceptionists: listedOthers.length - otherReceptionists.length } : {}),
  };
}
