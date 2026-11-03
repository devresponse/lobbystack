import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { CliError, exitCodes } from "./errors";

// Saves each knowledge search in a folder, one JSON file per search, for
// troubleshooting: what was asked, of which dashboard and business, and what
// the API answered, so a run can be looked at again or compared with a later one.

/** Saves every search without --log-dir. */
export const LOG_DIR_VARIABLE = "LOBBYSTACK_KNOWLEDGE_LOG_DIR";

/** How much of the question a file name keeps, in characters. */
const NAME_LENGTH = 60;
/** Searches of one question in one millisecond, as parallel runs can make, before giving up. */
const MAX_ATTEMPTS = 100;

/**
 * The folder to save searches in, made when it's missing, or undefined to save
 * nothing. --log-dir wins over LOBBYSTACK_KNOWLEDGE_LOG_DIR, and an empty
 * --log-dir saves nothing even when the variable is set. Checked before the
 * search is sent, so a folder that can't be written costs no search.
 */
export async function logFolder(flag: string | undefined, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const chosen = (flag ?? env[LOG_DIR_VARIABLE])?.trim();
  if (!chosen) return undefined;
  const folder = resolve(chosen);
  try {
    await mkdir(folder, { recursive: true });
  } catch (error) {
    throw new CliError(`Couldn't make ${folder}, which ${flag === undefined ? LOG_DIR_VARIABLE : "--log-dir"} names, to save the search in: ${(error as Error).message}`);
  }
  return folder;
}

/**
 * The file a search is saved in: when it was asked, then the question's words,
 * such as 2026-11-03T18-45-12-345Z-parking-fees.json. Names sort in the order
 * the searches ran, and one question gets the same ending in every run. Only
 * letters, digits and hyphens, so the name works on Windows too.
 */
export function logFileName(query: string, at: Date, attempt = 1): string {
  const words = query.normalize("NFC").toLowerCase().split(/[^\p{L}\p{M}\p{N}]+/u).filter(Boolean);
  const name = Array.from(words.join("-")).slice(0, NAME_LENGTH).join("").replace(/-$/, "") || "search";
  return `${at.toISOString().replace(/[:.]/g, "-")}-${name}${attempt > 1 ? `_${attempt}` : ""}.json`;
}

/** Writes one search as a new file, never over another, and returns its path. */
export async function saveLog(folder: string, query: string, at: Date, record: unknown): Promise<string> {
  const text = `${JSON.stringify(record, null, 2)}\n`;
  for (let attempt = 1; ; attempt += 1) {
    const path = join(folder, logFileName(query, at, attempt));
    try {
      // wx: a second search of the same question in the same millisecond gets _2, not the first one's file.
      await writeFile(path, text, { flag: "wx" });
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt >= MAX_ATTEMPTS) throw new CliError(`Couldn't save the search in ${folder}: ${(error as Error).message}`, exitCodes.failed);
    }
  }
}
