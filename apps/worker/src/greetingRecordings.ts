import { GREETING_RECORDING_TTL_SECONDS, greetingRecordingFailedKey, greetingRecordingInProgressKey, greetingRecordingKey, LIVE_VOICE, recordGreeting, recordingMs } from "@lobbystack/agent-core";
import { getCachedBusinessSnapshot, snapshotForReceptionist, type DomainContext } from "@lobbystack/domain";
import { callOpening, type BusinessContextSnapshot } from "@lobbystack/shared";
import { logEvent } from "@lobbystack/telemetry/node";
import type OpenAI from "openai";

/** The slice of a Redis client greeting recordings use. */
export type GreetingRecordingStore = {
  get(key: string): Promise<string | null>;
  /** With "NX", sets only a key that doesn't exist, and answers "OK" when it did. */
  set(key: string, value: string, mode: "EX", seconds: number, condition?: "NX"): Promise<unknown>;
  expire(key: string, seconds: number): Promise<unknown>;
  exists(key: string): Promise<number>;
};

// A recording loads while the caller's browser connects. Past this, the call
// opens with the greeting command instead.
const LOAD_TIMEOUT_MS = 1_000;
// How long GPT-Live gets to record one, over all its tries.
const RECORD_TIMEOUT_MS = 90_000;
// After every try failed, the same opening isn't tried again for this long,
// so the calls of a business whose opening GPT-Live won't say don't each
// start three more sessions.
const FAILED_RETRY_SECONDS = 6 * 60 * 60;
// The mark a worker sets while it records an opening, so another worker
// doesn't record it too, outlasts the recording's own time limit.
const IN_PROGRESS_SECONDS = Math.ceil(RECORD_TIMEOUT_MS / 1_000) + 30;

export type GreetingRecordings = ReturnType<typeof createGreetingRecordings>;

/**
 * Recordings of business greetings, kept in Redis where the admin checks for
 * them (packages/agent-core/src/live/greetingRecording.ts).
 */
export function createGreetingRecordings(input: { store: GreetingRecordingStore; client: OpenAI }) {
  // Greetings this worker is recording, so calls that overlap render each once.
  const recording = new Set<string>();
  /**
   * Records the greeting for the calls after this one, unless it already is,
   * in a session with the business's instructions. Never throws.
   */
  async function record(greeting: string, snapshot: BusinessContextSnapshot): Promise<void> {
    const key = greetingRecordingKey(greeting, LIVE_VOICE);
    const failedKey = greetingRecordingFailedKey(key);
    if (recording.has(key)) return;
    recording.add(key);
    try {
      if (await input.store.exists(key) || await input.store.exists(failedKey)) return;
      // Another worker is recording it. The mark also tells the dashboard's
      // test call that the recording is coming.
      if (await input.store.set(greetingRecordingInProgressKey(key), "1", "EX", IN_PROGRESS_SECONDS, "NX") !== "OK") return;
      const startedAt = performance.now();
      const recorded = await recordGreeting(input.client, { greeting, voice: LIVE_VOICE, snapshot }, { signal: AbortSignal.timeout(RECORD_TIMEOUT_MS) }).catch(async (error: unknown) => {
        await input.store.set(failedKey, "1", "EX", FAILED_RETRY_SECONDS).catch(() => undefined);
        throw error;
      });
      await input.store.set(key, recorded.audio, "EX", GREETING_RECORDING_TTL_SECONDS);
      logEvent("info", "live.greeting_recorded", { recordingMs: recordingMs(recorded.audio), renderMs: Math.round(performance.now() - startedAt), tries: recorded.tries });
    } catch (error) {
      logEvent("warn", "live.greeting_recording_failed", { error });
    } finally {
      recording.delete(key);
    }
  }
  return {
    /**
     * The greeting's recording, kept another week because a call plays it.
     * Undefined when it's gone or Redis doesn't answer in time.
     */
    async load(greeting: string): Promise<string | undefined> {
      const key = greetingRecordingKey(greeting, LIVE_VOICE);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const audio = await Promise.race([
          input.store.get(key),
          new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), LOAD_TIMEOUT_MS); }),
        ]);
        if (!audio) return undefined;
        void input.store.expire(key, GREETING_RECORDING_TTL_SECONDS).catch(() => undefined);
        return audio;
      } catch (error) {
        logEvent("warn", "live.greeting_recording_unread", { error });
        return undefined;
      } finally {
        clearTimeout(timer);
      }
    },
    record,
    /**
     * Keeps the greeting recorded for calls to come: another week for a
     * recording already made, or a new one. Never throws.
     */
    async keep(greeting: string, snapshot: BusinessContextSnapshot): Promise<void> {
      // EXPIRE answers 0 for a recording that's gone.
      const kept = await input.store.expire(greetingRecordingKey(greeting, LIVE_VOICE), GREETING_RECORDING_TTL_SECONDS).then((count) => Number(count) === 1, () => false);
      if (!kept) await record(greeting, snapshot);
    },
  };
}

/**
 * Keeps the openings of a business's receptionists recorded ahead of their
 * calls, so the first call after an opening changes, or after a week without
 * calls, still opens with the recording. Every active receptionist takes
 * browser calls, from the dashboard's test call, its page, a widget key or a
 * QR link, and those that answer a number take phone calls, each opening
 * with its own greeting in its own language: the default one's first, then
 * the others in the Receptionists page's order, each opening once. A paused
 * receptionist's calls go to the default one. With `phoneOnly`, as in the
 * daily sweep, a business without a phone number is left out: it takes only
 * browser calls, and the dashboard's test calls ask for their opening while
 * a website call after a quiet week records it for the next one. False when
 * the business has nothing to keep. Throws only when the business can't be
 * loaded.
 */
export async function keepOpeningsRecorded(recordings: GreetingRecordings, domain: DomainContext, businessId: string, options: { phoneOnly?: boolean } = {}): Promise<boolean> {
  const snapshot = await getCachedBusinessSnapshot(domain, { businessId });
  if (!snapshot || (options.phoneOnly && !snapshot.contactChannels.phoneNumber)) return false;
  const active = (snapshot.receptionists ?? [])
    .filter((receptionist) => receptionist.status === "active")
    .sort((left, right) => Number(right.isDefault) - Number(left.isDefault) || left.order - right.order);
  // A snapshot from before receptionists is the default's view.
  const answering: Array<string | undefined> = active.length ? active.map((receptionist) => receptionist.id) : [undefined];
  const kept = new Set<string>();
  // One at a time, like the businesses of the daily sweep.
  for (const receptionistId of answering) {
    const view = snapshotForReceptionist(snapshot, receptionistId);
    const opening = callOpening(view);
    if (!opening || kept.has(opening)) continue;
    kept.add(opening);
    await recordings.keep(opening, view);
  }
  return kept.size > 0;
}

/**
 * Starts recording one receptionist's opening, unless it's recorded, being
 * recorded or failed in the last 6 hours, for the dashboard's test call,
 * which asks as the dashboard opens and waits a little for it. Doesn't wait
 * for the recording. False when the business can't be loaded or its calls
 * open with nothing to say.
 */
export async function startOpeningRecording(recordings: GreetingRecordings, domain: DomainContext, input: { businessId: string; receptionistId?: string }): Promise<boolean> {
  const snapshot = await getCachedBusinessSnapshot(domain, { businessId: input.businessId });
  if (!snapshot) return false;
  // A paused or archived receptionist's calls go to the default one, whose opening this records.
  const view = snapshotForReceptionist(snapshot, input.receptionistId);
  const opening = callOpening(view);
  if (!opening) return false;
  void recordings.record(opening, view);
  return true;
}
