// What the Receptionists page says when the server refuses a change, by the
// code it sends, as keys in the receptionists namespace. The server's own
// words are English, so a code the page doesn't know gets a general message,
// with the error ID a logged failure came with.

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

/**
 * Explains a refused receptionist change in the dashboard's language. `limit`
 * is the plan's number of active receptionists, which words the plan refusal.
 */
export function receptionistErrorMessage(error: unknown, t: Translate, action: ReceptionistAction, limit?: number): string {
  const { code, errorId } = typeof error === "object" && error !== null ? error as { code?: unknown; errorId?: unknown } : {};
  if (code === "receptionist_limit") return t(limit === 1 ? "errors.limitOne" : "errors.limit", {});
  if (code === "default_receptionist") return t(defaultReceptionistKeys[action] ?? "errors.generic", {});
  if (typeof code === "string" && Object.hasOwn(keysByCode, code)) return t(keysByCode[code]!, {});
  if (typeof errorId === "string" && errorId) return t("errors.withErrorId", { message: t("errors.generic", {}), errorId });
  return t("errors.generic", {});
}
