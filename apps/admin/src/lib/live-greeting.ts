import { greetingRecordingKey } from "@lobbystack/agent-core/live/greetingRecording";
import { LIVE_VOICE } from "@lobbystack/agent-core/live/session";
import { callOpening, type BusinessContextSnapshot } from "@lobbystack/shared";

import { getRedis, waitForRedis } from "./redis";

/** The opening a call starts with, greeting and notice, and whether its recording plays (the worker's AttachRequest). */
export type RecordedGreeting = { text: string; play: boolean };

// The caller is waiting, or hearing a phone call ring, while this runs.
const CHECK_TIMEOUT_MS = 1_000;

/**
 * With LIVE_RECORDED_GREETING=true, a call opens with a recording of the
 * business greeting and the notice after it (callOpening) once the worker
 * has made one, instead of waiting for GPT-Live to say it. Until then, as
 * after either changes, the call opens as before and the worker records the
 * opening for the next call. Undefined when the setting is off or the call
 * opens with nothing to say. Phone calls follow the same setting, and
 * LIVE_RECORDED_GREETING_PHONE=false turns off only theirs.
 */
export async function recordedGreetingFor(snapshot: Pick<BusinessContextSnapshot, "greeting" | "defaultLocale" | "recordingNotice">, options: { phone?: boolean } = {}): Promise<RecordedGreeting | undefined> {
  if (process.env.LIVE_RECORDED_GREETING !== "true") return undefined;
  if (options.phone && process.env.LIVE_RECORDED_GREETING_PHONE === "false") return undefined;
  const text = callOpening(snapshot);
  const redis = getRedis();
  if (!text || !redis) return undefined;
  // A Redis that isn't ready or doesn't answer within a second opens the call as before.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const play = await Promise.race([
    waitForRedis(redis).then(() => redis.exists(greetingRecordingKey(text, LIVE_VOICE))).then((count) => count > 0, () => false),
    new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), CHECK_TIMEOUT_MS); }),
  ]).finally(() => clearTimeout(timer));
  return { text, play };
}
