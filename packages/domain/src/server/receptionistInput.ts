import {
  isReceptionistHandle,
  isRuntimeLocale,
  isUuid,
  receptionistKnowledgeScopes,
  receptionistStatuses,
  MAX_RECEPTIONISTS_PER_REQUEST,
  RECEPTIONIST_DESCRIPTION_MAX_LENGTH,
  RECEPTIONIST_HANDLE_MAX_LENGTH,
  RECEPTIONIST_NAME_MAX_LENGTH,
  type ReceptionistKnowledgeScope,
  type ReceptionistStatus,
  type RuntimeLocale,
} from "@lobbystack/shared";

import { failure, isRecord } from "./requestHelpers";

// What the Receptionists page and its routes send, read before any database
// work. Each reader throws a 400 failure naming the first field that is wrong,
// and the admin routes return it as it is. The rules live apart from
// receptionists.ts so their tests need no database (receptionistInput.test.ts).

/** A new receptionist's fields. Settings it doesn't name come from copyFromId's receptionist, else the default one. */
export type ReceptionistCreateInput = {
  name: string;
  description?: string | undefined;
  /** Its page address, /profile/<slug>/<handle>; made from the name when left out. */
  handle?: string | undefined;
  /** The language its calls open in; null or left out uses the business's. */
  locale?: RuntimeLocale | null | undefined;
  /** New receptionists answer from articles for everyone plus their own unless told otherwise. */
  knowledgeScope?: ReceptionistKnowledgeScope | undefined;
  listed?: boolean | undefined;
  copyFromId?: string | null | undefined;
};

/** Fields the Receptionists page changes; AI settings change the rest (saveReceptionistProfileInTransaction). */
export type ReceptionistIdentityPatch = {
  name?: string;
  description?: string;
  handle?: string;
  locale?: RuntimeLocale | null;
  knowledgeScope?: ReceptionistKnowledgeScope;
  listed?: boolean;
};

function readName(value: unknown): string {
  if (typeof value !== "string") throw failure("name must be a string.", 400, "invalid_name");
  const name = value.replace(/\s+/g, " ").trim();
  if (!name) throw failure("Give the receptionist a name.", 400, "invalid_name");
  if (name.length > RECEPTIONIST_NAME_MAX_LENGTH) throw failure(`Names can be up to ${RECEPTIONIST_NAME_MAX_LENGTH} characters.`, 400, "invalid_name");
  return name;
}

function readDescription(value: unknown): string {
  if (value === null) return "";
  if (typeof value !== "string") throw failure("description must be a string.", 400, "invalid_description");
  const description = value.replace(/\s+/g, " ").trim();
  if (description.length > RECEPTIONIST_DESCRIPTION_MAX_LENGTH) throw failure(`"What it helps with" can be up to ${RECEPTIONIST_DESCRIPTION_MAX_LENGTH} characters.`, 400, "invalid_description");
  return description;
}

function readHandle(value: unknown): string {
  if (typeof value !== "string") throw failure("handle must be a string.", 400, "invalid_handle");
  const handle = value.trim().toLowerCase();
  if (!isReceptionistHandle(handle)) throw failure(`A page address is up to ${RECEPTIONIST_HANDLE_MAX_LENGTH} lower-case letters and digits, joined by single dashes.`, 400, "invalid_handle");
  return handle;
}

function readLocale(value: unknown): RuntimeLocale | null {
  if (value === null || value === "") return null;
  if (!isRuntimeLocale(value)) throw failure("locale is not a language calls support.", 400, "invalid_locale");
  return value;
}

function readScope(value: unknown): ReceptionistKnowledgeScope {
  if (!(receptionistKnowledgeScopes as readonly unknown[]).includes(value)) throw failure("knowledgeScope must be all or audience.", 400, "invalid_knowledge_scope");
  return value as ReceptionistKnowledgeScope;
}

function readBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw failure(`${field} must be true or false.`, 400, `invalid_${field}`);
  return value;
}

/** Reads the body that adds a receptionist. Throws a 400 error naming the first field that is wrong. */
export function readReceptionistCreateInput(body: unknown): ReceptionistCreateInput {
  if (!isRecord(body)) throw failure("A receptionist object is required.", 400, "invalid_body");
  const input: ReceptionistCreateInput = { name: readName(body.name) };
  if (body.description !== undefined) input.description = readDescription(body.description);
  if (body.handle !== undefined && body.handle !== null && body.handle !== "") input.handle = readHandle(body.handle);
  if (body.locale !== undefined) input.locale = readLocale(body.locale);
  if (body.knowledgeScope !== undefined) input.knowledgeScope = readScope(body.knowledgeScope);
  if (body.listed !== undefined) input.listed = readBoolean(body.listed, "listed");
  if (body.copyFromId !== undefined && body.copyFromId !== null) {
    if (!isUuid(body.copyFromId)) throw failure("copyFromId must be a receptionist id.", 400, "invalid_copy_from");
    input.copyFromId = body.copyFromId.toLowerCase();
  }
  return input;
}

/** Reads the body that changes a receptionist's name, page address, language, knowledge or listing. */
export function readReceptionistIdentityPatch(body: unknown): ReceptionistIdentityPatch {
  if (!isRecord(body)) throw failure("A receptionist object is required.", 400, "invalid_body");
  const patch: ReceptionistIdentityPatch = {};
  if (body.name !== undefined) patch.name = readName(body.name);
  if (body.description !== undefined) patch.description = readDescription(body.description);
  if (body.handle !== undefined) patch.handle = readHandle(body.handle);
  if (body.locale !== undefined) patch.locale = readLocale(body.locale);
  if (body.knowledgeScope !== undefined) patch.knowledgeScope = readScope(body.knowledgeScope);
  if (body.listed !== undefined) patch.listed = readBoolean(body.listed, "listed");
  if (!Object.keys(patch).length) throw failure("Send at least one field to change.", 400, "invalid_body");
  return patch;
}

/** Reads a status change: active resumes a paused receptionist, paused pauses it. */
export function readReceptionistStatus(value: unknown): ReceptionistStatus {
  if (!(receptionistStatuses as readonly unknown[]).includes(value)) throw failure("status must be active or paused.", 400, "invalid_status");
  return value as ReceptionistStatus;
}

/** Reads a listing order: every receptionist that isn't archived, once each. */
export function readReceptionistOrder(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > MAX_RECEPTIONISTS_PER_REQUEST) throw failure("receptionistIds must list the receptionists in order.", 400, "invalid_order");
  const ids = value.map((id) => {
    if (!isUuid(id)) throw failure("receptionistIds must list receptionist ids.", 400, "invalid_order");
    return id.toLowerCase();
  });
  if (new Set(ids).size !== ids.length) throw failure("A receptionist appears twice in the order.", 400, "invalid_order");
  return ids;
}

/** Reads the receptionists the business page lists besides the default: receptionist ids, once each, none at all allowed. */
export function readListedReceptionists(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_RECEPTIONISTS_PER_REQUEST) throw failure("receptionistIds must list the receptionists the business page shows.", 400, "invalid_listed");
  const ids = value.map((id) => {
    if (!isUuid(id)) throw failure("receptionistIds must list receptionist ids.", 400, "invalid_listed");
    return id.toLowerCase();
  });
  if (new Set(ids).size !== ids.length) throw failure("A receptionist appears twice.", 400, "invalid_listed");
  return ids;
}
