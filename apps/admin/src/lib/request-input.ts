import { NextResponse } from "next/server";
import type { z } from "zod";

import { parseApiInput } from "@lobbystack/shared";

/**
 * What a dashboard route reads from a request, and how it refuses a caller's mistake.
 * Nothing here touches the database or the session, so a route's tests can use the real checks.
 */

export function jsonError(message: string, status = 400, code?: string): NextResponse {
  return NextResponse.json({ error: message, ...(code ? { code } : {}) }, { status });
}

export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw jsonError("Invalid JSON body.", 400, "invalid_json");
  }
}

/** A caller's mistake, named: 400 with the field that is wrong, never a 500 with an error ID. */
function invalidInput(details: Array<{ path: string; message: string }>): NextResponse {
  const first = details[0];
  const message = !first ? "The request is invalid." : first.path === "(body)" ? first.message : `${first.path}: ${first.message}`;
  return NextResponse.json({ error: message, code: "invalid_request", details }, { status: 400 });
}

/**
 * Reads a JSON body and checks it against a schema, as the v1 API does with its own.
 * A wrong field answers 400 with its name and what to fix, instead of a 500 and an error report.
 */
export async function parseBody<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  const parsed = parseApiInput(schema, await readJson(request));
  if (!parsed.ok) throw invalidInput(parsed.details);
  return parsed.data;
}

/** The same for the query string. Every parameter arrives as text, so numbers need `z.coerce`. */
export function parseQuery<T>(request: Request, schema: z.ZodType<T>): T {
  // An empty parameter means absent, as in the v1 API, so a cleared search box isn't a mistake.
  const parsed = parseApiInput(schema, Object.fromEntries([...new URL(request.url).searchParams].filter(([, value]) => value !== "")));
  if (!parsed.ok) throw invalidInput(parsed.details);
  return parsed.data;
}
