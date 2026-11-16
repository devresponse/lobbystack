import { fetchWithTimeout } from "@lobbystack/shared";

import type { WorkerDependencies } from "./handlers";

/**
 * Sends the worker's product events to PostHog, one batch request per flush,
 * or nothing without POSTHOG_API_KEY. telemetry.flush runs each minute for
 * every business in use, on the maintenance queue, so a stalled PostHog would
 * fill the queue's slots and hold up the jobs that share it: each request
 * gets fetchWithTimeout's 15 seconds, and the job tries again later.
 */
export function createProductAnalytics(env: Record<string, string | undefined> = process.env): WorkerDependencies["productAnalytics"] {
  const apiKey = env.POSTHOG_API_KEY;
  if (!apiKey) return undefined;
  const host = env.POSTHOG_HOST ?? "https://us.i.posthog.com";
  return {
    capture: async (events) => {
      const response = await fetchWithTimeout(`${host.replace(/\/$/, "")}/batch/`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ api_key: apiKey, batch: events.map((event) => ({ event: event.event, distinct_id: event.distinctId, properties: event.properties, timestamp: event.timestamp })) }),
      });
      if (!response.ok) throw new Error(`PostHog product event delivery failed with status ${response.status}.`);
    },
  };
}
