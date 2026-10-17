import { PostHog } from "posthog-node";
import { recordException, redactOtelExceptionText } from "@lobbystack/telemetry/node";

import { releaseVersion } from "@/lib/release-version";

let client: PostHog | undefined;
const reported = new WeakSet<object>();

// Keep the diagnosis a wrapped error carries in `cause`: the database's
// (SQLSTATE, constraint, table) that Drizzle wraps, or a provider's (its HTTP
// status and error code). Skip `detail`, which echoes row values, and mask
// quoted literals in `message` (e.g. `invalid input syntax for type uuid: "<value>"`).
function causeDiagnosis(error: Error): Record<string, string | number> | undefined {
  const cause: unknown = error.cause;
  if (!cause || typeof cause !== "object") return undefined;
  const fields: Record<string, string | number> = {};
  for (const key of ["name", "message", "code", "status", "severity", "constraint", "table", "column", "routine"] as const) {
    const value = (cause as Record<string, unknown>)[key];
    if (typeof value === "string" && value) fields[key] = redactOtelExceptionText(key === "message" ? value.replace(/"[^"]*"/g, '"[value]"') : value);
    else if ((key === "code" || key === "status") && typeof value === "number") fields[key] = value;
  }
  return Object.keys(fields).length ? fields : undefined;
}

export async function reportServerError(error: unknown, context: { operation: string; route?: string; method?: string; digest?: string; errorId?: string }): Promise<void> {
  if (error && typeof error === "object") {
    if (reported.has(error)) return;
    reported.add(error);
  }
  const original = error instanceof Error ? error : new Error("Non-Error exception");
  const safe = new Error(redactOtelExceptionText(original.message));
  safe.name = original.name;
  // V8 copies the message (Drizzle params, possibly multi-line customer text)
  // into the stack header, so keep only the frames below it.
  if (original.stack) safe.stack = [`${safe.name}: ${safe.message}`, ...original.stack.split("\n").slice(original.message.split("\n").length).filter((line) => /^\s+at /.test(line)).slice(0, 29).map(redactOtelExceptionText)].join("\n");
  const cause = causeDiagnosis(original);
  const properties = { ...context, service: "lobbystack-admin", environment: process.env.RAILWAY_ENVIRONMENT_NAME ?? process.env.NODE_ENV, release: releaseVersion(), alertable: true, ...(cause ? { cause } : {}) };
  // One JSON line: the log viewer shows its message, which leads with the
  // error, and can filter on the rest (route, errorId, cause).
  console.error(JSON.stringify({ message: `[admin] exception: ${safe.message}`, ...properties, name: safe.name, stack: safe.stack }));
  recordException(safe);
  const key = process.env.POSTHOG_KEY ?? process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN;
  if (!key) return;
  try {
    client ??= new PostHog(key, { host: process.env.POSTHOG_HOST ?? process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com", flushAt: 1, flushInterval: 0 });
    await client.captureExceptionImmediate(safe, "system:lobbystack-admin", properties);
  } catch {
    console.warn("[admin] exception delivery failed");
  }
}
