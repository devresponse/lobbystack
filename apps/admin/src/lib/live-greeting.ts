import { greetingRecordingKey } from "@lobbystack/agent-core/live/greetingRecording";
import { LIVE_VOICE } from "@lobbystack/agent-core/live/session";
import type { BusinessContextSnapshot } from "@lobbystack/shared";

import { getRedis, waitForRedis } from "./redis";

/** The greeting a browser call opens with, and whether its recording plays (the worker's AttachRequest). */
export type RecordedGreeting = { text: string; play: boolean };

/**
 * With LIVE_RECORDED_GREETING=true, a browser call opens with a recording of
 * the business greeting once the worker has made one, instead of waiting for
 * GPT-Live to say it. Until then, as after the greeting changes, the call
 * opens as before and the worker records the greeting for the next call.
 * Undefined when the setting is off or the business has no greeting.
 */
export async function recordedGreetingFor(snapshot: Pick<BusinessContextSnapshot, "greeting">): Promise<RecordedGreeting | undefined> {
  if (process.env.LIVE_RECORDED_GREETING !== "true") return undefined;
  const text = snapshot.greeting?.trim();
  const redis = getRedis();
  if (!text || !redis) return undefined;
  // A Redis that isn't ready or doesn't answer opens the call as before.
  const play = await waitForRedis(redis).then(() => redis.exists(greetingRecordingKey(text, LIVE_VOICE))).then((count) => count > 0, () => false);
  return { text, play };
}
