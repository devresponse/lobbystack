import { greetingRecordingFailedKey, greetingRecordingInProgressKey, greetingRecordingKey, recordedGreetingEnabled } from "@lobbystack/agent-core/live/greetingRecording";
import { LIVE_VOICE } from "@lobbystack/agent-core/live/session";
import { callOpening, type BusinessContextSnapshot } from "@lobbystack/shared";

import { getRedis, waitForRedis } from "./redis";

/** The opening a call starts with, greeting and notice, and whether its recording plays (the worker's AttachRequest). */
export type RecordedGreeting = { text: string; play: boolean };

type OpeningSnapshot = Pick<BusinessContextSnapshot, "greeting" | "defaultLocale" | "recordingNotice">;

// The caller is waiting, or hearing a phone call ring, while this runs.
const CHECK_TIMEOUT_MS = 1_000;

// Whatever `check` resolves to, or `fallback` when Redis isn't ready, fails
// or doesn't answer within CHECK_TIMEOUT_MS.
async function withinCheckTimeout<T>(check: () => Promise<T>, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return await Promise.race([
    check().catch(() => fallback),
    new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), CHECK_TIMEOUT_MS); }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * A call opens with a recording of the business greeting and the notice
 * after it (callOpening) once the worker has made one, instead of waiting for
 * GPT-Live to say it. Until then, as after either changes, the call opens as
 * before and the worker records the opening for the next call. Undefined
 * when LIVE_RECORDED_GREETING is false (it's on unless set so) or the call
 * opens with nothing to say. Phone calls follow the same setting, and
 * LIVE_RECORDED_GREETING_PHONE=false turns off only theirs.
 */
export async function recordedGreetingFor(snapshot: OpeningSnapshot, options: { phone?: boolean } = {}): Promise<RecordedGreeting | undefined> {
  if (!recordedGreetingEnabled()) return undefined;
  if (options.phone && process.env.LIVE_RECORDED_GREETING_PHONE === "false") return undefined;
  const text = callOpening(snapshot);
  const redis = getRedis();
  if (!text || !redis) return undefined;
  // A Redis that isn't ready or doesn't answer within a second opens the call as before.
  const play = await withinCheckTimeout(async () => {
    await waitForRedis(redis);
    return await redis.exists(greetingRecordingKey(text, LIVE_VOICE)) > 0;
  }, false);
  return { text, play };
}

/**
 * Where the recording of a call's opening stands, for the dashboard's test
 * call, which waits a little for one under way rather than open without it:
 * - `ready`: recorded, so the call opens with it
 * - `recording`: a worker is recording it now
 * - `missing`: nobody is recording it
 * - `failed`: every try at recording it failed in the last 30 minutes
 * - `off`: no recording will play, because LIVE_RECORDED_GREETING is false,
 *   the call opens with nothing to say, or Redis isn't set up or doesn't
 *   answer within a second
 */
export type GreetingRecordingStatus = "ready" | "recording" | "missing" | "failed" | "off";

export async function greetingRecordingStatus(snapshot: OpeningSnapshot): Promise<GreetingRecordingStatus> {
  if (!recordedGreetingEnabled()) return "off";
  const text = callOpening(snapshot);
  const redis = getRedis();
  if (!text || !redis) return "off";
  const key = greetingRecordingKey(text, LIVE_VOICE);
  return await withinCheckTimeout<GreetingRecordingStatus>(async () => {
    await waitForRedis(redis);
    const [recorded, failed, underWay] = await Promise.all([redis.exists(key), redis.exists(greetingRecordingFailedKey(key)), redis.exists(greetingRecordingInProgressKey(key))]);
    if (recorded > 0) return "ready";
    if (failed > 0) return "failed";
    return underWay > 0 ? "recording" : "missing";
  }, "off");
}
