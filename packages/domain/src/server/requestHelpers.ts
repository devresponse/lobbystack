// What the modules that read dashboard and API requests share: an error the
// admin routes answer with its status and code (asApiResponse in the admin
// app), a check that a request body is an object, and a check for a unique
// index's refusal.

/** An error the admin routes answer with this status and code. Its message is the server's own, in English. */
export function failure(message: string, status: number, code: string): Error {
  return Object.assign(new Error(message), { status, code });
}

/** Whether a request body, or a value in one, is an object and not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether a query failed on a unique index: the one named, when constraint is
 * given, else any. Drizzle wraps the driver's error as its cause, and a caller
 * may wrap that again, so the whole chain of causes is read, each error once.
 */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const seen = new Set<object>();
  for (let current: unknown = error; typeof current === "object" && current !== null && !seen.has(current); current = (current as { cause?: unknown }).cause) {
    seen.add(current);
    const { code, constraint: index } = current as { code?: unknown; constraint?: unknown };
    if (code === "23505" && (constraint === undefined || index === constraint)) return true;
  }
  return false;
}
