import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

import OpenAI from "openai";

import { jsonError } from "./api-helpers";
import type { RecordedGreeting } from "./live-greeting";

/** `resume` marks a retried webhook delivery's attach to a call that may be under way. */
// receptionistId: the receptionist answering, whose view of the snapshot the worker's agent uses; the default one without it.
type WorkerAttachInput = { sessionId: string; businessId: string; callId: string; channel: "voice" | "web_voice"; conversationId?: string; callerPhone?: string; maxDurationMs?: number; intakeOnly?: boolean; resume?: boolean; recordedGreeting?: RecordedGreeting; receptionistId?: string };

// A draining worker answers a new attach with 503, and the admin tries the
// worker's other copies at once. When every copy refuses, as when a release
// replaces the only one, these waits come before the next round, giving the
// new copy time to become ready.
const ATTACH_RETRY_DELAYS_MS = [250, 750];

let client: OpenAI | undefined;

export function requireLivePrototype(): void {
  if (process.env.LIVE_PROTOTYPE_ENABLED !== "true") throw jsonError("The GPT-Live prototype is off.", 404, "live_prototype_disabled");
}

export function getLiveClient(): OpenAI {
  if (!process.env.OPENAI_API_KEY) throw jsonError("OPENAI_API_KEY is not set.", 503, "openai_unconfigured");
  client ??= new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    maxRetries: 0,
    ...(process.env.OPENAI_WEBHOOK_SECRET ? { webhookSecret: process.env.OPENAI_WEBHOOK_SECRET } : {}),
  });
  return client;
}

function workerUrl(): string {
  return process.env.WORKER_INTERNAL_URL ?? `http://127.0.0.1:${process.env.WORKER_PORT ?? 3002}`;
}

function shuffled<T>(items: T[]): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[other]] = [copy[other]!, copy[index]!];
  }
  return copy;
}

/** Waits for the promise, unless the budget runs out first. */
async function withinBudget<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  let stop = () => {};
  const ranOut = new Promise<never>((_resolve, reject) => {
    stop = () => reject(signal.reason);
    if (signal.aborted) stop();
    else signal.addEventListener("abort", stop, { once: true });
  });
  try {
    return await Promise.race([promise, ranOut]);
  } finally {
    signal.removeEventListener("abort", stop);
  }
}

/**
 * Where to send a request to the worker: one address for each of its copies,
 * in a new random order each time. Railway's private name for the worker lists
 * every running copy, but fetch connects to the first address and keeps that
 * connection, so every call would go to one copy. An https address, which
 * needs its name for the certificate, an IP, and a name with one address or
 * none are used as they are.
 */
async function workerAddresses(signal: AbortSignal): Promise<string[]> {
  const configured = workerUrl();
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    return [configured];
  }
  if (url.protocol !== "http:" || isIP(url.hostname.replace(/^\[(.*)\]$/, "$1"))) return [configured];
  let found: Array<{ address: string; family: number }>;
  try {
    found = await withinBudget(lookup(url.hostname, { all: true }), signal);
  } catch (error) {
    if (signal.aborted) throw error;
    // fetch looks the name up again and reports what went wrong.
    return [configured];
  }
  // An address with a zone, such as fe80::1%eth0, can't go in a URL.
  const records = found.filter(({ address }, index) => !address.includes("%") && found.findIndex((other) => other.address === address) === index);
  if (records.length < 2) return [configured];
  // The copies in the family fetch would pick (the first address's) come first, then the other family's.
  const family = records[0]!.family;
  const ordered = [...shuffled(records.filter((record) => record.family === family)), ...shuffled(records.filter((record) => record.family !== family))];
  const rest = `${url.port ? `:${url.port}` : ""}${url.pathname.replace(/\/$/, "")}`;
  return ordered.map(({ address, family: kind }) => `http://${kind === 6 ? `[${address}]` : address}${rest}`);
}

/**
 * Resolves to the worker's JSON answer, or undefined when it isn't JSON. A
 * copy that refuses with 503 because it's shutting down, or that can't be
 * reached, passes the request to the next copy. These requests are safe to
 * repeat: one worker answers each session (its attach lock), ending a session
 * twice does nothing, and a recording already under way isn't started again.
 */
async function postToWorker(action: "attach" | "end" | "greeting", body: unknown): Promise<unknown> {
  const token = process.env.INTERNAL_SERVICE_TOKEN;
  if (!token) throw new Error("INTERNAL_SERVICE_TOKEN is not set.");
  // A sleeping staging worker needs a few seconds to wake. Every try shares this budget.
  const signal = AbortSignal.timeout(10_000);
  const init = {
    method: "POST",
    headers: { "content-type": "application/json", "x-internal-service-token": token },
    body: JSON.stringify(body),
    signal,
  } satisfies RequestInit;
  // Only an attach waits for a new copy when every copy refused: a call can't start without one.
  const waits = action === "attach" ? ATTACH_RETRY_DELAYS_MS : [];
  for (let round = 0; ; round += 1) {
    let failure: unknown;
    let refused = false;
    // Looked up each round, so a copy that has just started is found.
    for (const address of await workerAddresses(signal)) {
      let response: Response;
      try {
        response = await fetch(`${address}/internal/live/${action}`, init);
      } catch (error) {
        // The budget running out ends every try.
        if (signal.aborted) throw error;
        failure = error;
        continue;
      }
      if (response.status === 503) {
        await response.body?.cancel();
        failure = new Error(`Worker ${action} failed with status 503.`);
        refused = true;
        continue;
      }
      if (!response.ok) throw new Error(`Worker ${action} failed with status ${response.status}.`);
      return await response.json().catch(() => undefined);
    }
    // No copy took it. A refusal means a release is replacing the worker, so an attach waits for the new copy;
    // a copy out of reach with no other refusing isn't waited for.
    if (!refused || round >= waits.length) throw failure;
    // Rejects when the shared budget runs out first.
    await sleep(waits[round]!, undefined, { signal });
  }
}

// OpenAI replays only the last 3 seconds to a late sideband, so the worker must
// attach right after the session exists. This is a direct call, not a queued job.
export async function attachWorkerToLiveSession(input: WorkerAttachInput): Promise<void> {
  await postToWorker("attach", input);
}

/**
 * Ends a browser session with session.close, sent by the worker over a
 * sideband. OpenAI's hangup endpoint is for SIP calls only.
 */
export async function endLiveBrowserSession(sessionId: string): Promise<void> {
  await postToWorker("end", { sessionId });
}

/**
 * Asks the worker to record a receptionist's opening, the default one's
 * without `receptionistId`, unless it's recorded, being recorded or failed
 * lately. The worker answers before it records: false when it records none,
 * as with LIVE_RECORDED_GREETING=false there or a call that opens with
 * nothing to say.
 */
export async function requestGreetingRecording(input: { businessId: string; receptionistId?: string }): Promise<boolean> {
  const answer = await postToWorker("greeting", input);
  return typeof answer === "object" && answer !== null && (answer as { recording?: unknown }).recording === true;
}
