// What the Receptionists page says when the server refuses a change, by the
// code it sends, as keys in the receptionists namespace. The server's own
// words are English, so a code the page doesn't know gets a general message,
// with the error ID a logged failure came with.

import type { ReceptionistUpgrade } from "@lobbystack/shared";

type Translate = (key: string, options: Record<string, string>) => string;

/** The change that failed, for the refusals whose meaning depends on it. */
export type ReceptionistAction = "add" | "edit" | "pause" | "resume" | "archive" | "restore" | "make_default" | "order";

const keysByCode: Record<string, string> = {
  handle_taken: "errors.handleTaken",
  receptionist_cap: "errors.cap",
  receptionist_paused: "errors.resumeFirst",
  receptionist_not_found: "errors.notFound",
  invalid_name: "errors.invalid",
  invalid_description: "errors.invalid",
  invalid_handle: "errors.invalid",
  invalid_locale: "errors.invalid",
  invalid_knowledge_scope: "errors.invalid",
  invalid_listed: "errors.invalid",
  invalid_copy_from: "errors.invalid",
  invalid_order: "errors.generic",
};

const defaultReceptionistKeys: Partial<Record<ReceptionistAction, string>> = {
  pause: "errors.defaultPaused",
  archive: "errors.defaultArchived",
  edit: "errors.defaultListed",
};

/** The plan's number of active receptionists, and what raises it, as GET /api/receptionists gives them. */
export type ReceptionistLimit = { limit: number; upgrade: ReceptionistUpgrade };

/**
 * Says the plan's active receptionists are all in use, and what would raise
 * the number: a plan to upgrade to, Enterprise through sales, or nothing.
 */
export function receptionistLimitMessage(allowance: ReceptionistLimit | undefined, t: Translate): string {
  const one = allowance?.limit === 1;
  if (allowance?.upgrade === "sales") return t(one ? "errors.limitOneSales" : "errors.limitSales", {});
  if (allowance?.upgrade === null) return t("errors.limitNone", {});
  return t(one ? "errors.limitOne" : "errors.limit", {});
}

/**
 * Explains a refused receptionist change in the dashboard's language.
 * `allowance` words the plan refusal.
 */
export function receptionistErrorMessage(error: unknown, t: Translate, action: ReceptionistAction, allowance?: ReceptionistLimit): string {
  const { code, errorId } = typeof error === "object" && error !== null ? error as { code?: unknown; errorId?: unknown } : {};
  if (code === "receptionist_limit") return receptionistLimitMessage(allowance, t);
  if (code === "default_receptionist") return t(defaultReceptionistKeys[action] ?? "errors.generic", {});
  if (typeof code === "string" && Object.hasOwn(keysByCode, code)) return t(keysByCode[code]!, {});
  if (typeof errorId === "string" && errorId) return t("errors.withErrorId", { message: t("errors.generic", {}), errorId });
  return t("errors.generic", {});
}

const entryPointCodes = new Set(["receptionist_archived", "receptionist_not_found", "invalid_receptionist", "phone_number_not_found", "widget_key_not_found", "entry_link_not_found"]);

/** Whether the server refused a change to who answers, which entryPointErrorMessage explains. */
export function isEntryPointError(error: unknown): boolean {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && entryPointCodes.has(code);
}

/**
 * Explains a refused change to who answers a phone number, widget key or QR
 * link, as keys in the receptionists namespace (pass a t that reads it).
 */
export function entryPointErrorMessage(error: unknown, t: Translate): string {
  const { code, errorId } = typeof error === "object" && error !== null ? error as { code?: unknown; errorId?: unknown } : {};
  if (code === "receptionist_archived") return t("receptionists:entry.errors.archived", {});
  if (code === "receptionist_not_found") return t("receptionists:errors.notFound", {});
  if (code === "phone_number_not_found" || code === "widget_key_not_found" || code === "entry_link_not_found") return t("receptionists:entry.errors.gone", {});
  if (typeof errorId === "string" && errorId) return t("receptionists:errors.withErrorId", { message: t("receptionists:errors.generic", {}), errorId });
  return t("receptionists:errors.generic", {});
}
