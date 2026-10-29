import { GREETING_RECORDING_TTL_SECONDS, greetingRecordingKey, LIVE_VOICE, recordGreeting, recordingMs } from "@lobbystack/agent-core";
import { getCachedBusinessSnapshot, type DomainContext } from "@lobbystack/domain";
import { callOpening, type BusinessContextSnapshot } from "@lobbystack/shared";
import { logEvent } from "@lobbystack/telemetry/node";
import type OpenAI from "openai";

/** The slice of a Redis client greeting recordings use. */
export type GreetingRecordingStore = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "EX", seconds: number): Promise<unknown>;
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
    const failedKey = `${key}:failed`;
    if (recording.has(key)) return;
    recording.add(key);
    try {
      if (await input.store.exists(key) || await input.store.exists(failedKey)) return;
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
 * Keeps the opening of a business with a phone number recorded ahead of its
 * calls, so its first call after the opening changes, or after a week
 * without calls, still opens with the recording. False when the business
 * has no phone number or its calls open with nothing to say. Throws only
 * when the business can't be loaded.
 */
export async function keepOpeningRecorded(recordings: GreetingRecordings, domain: DomainContext, businessId: string): Promise<boolean> {
  const snapshot = await getCachedBusinessSnapshot(domain, { businessId });
  const opening = snapshot?.contactChannels.phoneNumber ? callOpening(snapshot) : "";
  if (!snapshot || !opening) return false;
  await recordings.keep(opening, snapshot);
  return true;
}
