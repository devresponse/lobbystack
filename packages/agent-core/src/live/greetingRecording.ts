import { createHash } from "node:crypto";

import { LIVE_MODEL } from "./session";

/**
 * A recording of the call's opening, played into a call the moment it
 * connects. GPT-Live waits for the caller by default and skips the greeting
 * command on some calls, so a call that waits for it can open with seconds of
 * silence. OpenAI's guide recommends a recording for predictable greeting
 * playback, and an audio fixture plays one through the session's output.
 * greetingRecorder.ts makes them.
 */

// How recordings are made: a short session of the calls' own GPT-Live model
// (greetingRecorder.ts). A new way, or a new model, gets new keys, so every
// opening is recorded again with it.
const RECORDER = ["live-session-1", LIVE_MODEL];
// A recording is 16-bit mono PCM at 24 kHz with no header, the format an audio fixture takes.
const SAMPLES_PER_MS = 24;

/** A recording stays this long after the last call that played it. */
export const GREETING_RECORDING_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Where a greeting's recording is kept. The key comes from the words and the
 * voice, so a changed greeting gets a new recording, and businesses with the
 * same greeting share one.
 */
export function greetingRecordingKey(greeting: string, voice: string): string {
  const digest = createHash("sha256").update(JSON.stringify([...RECORDER, voice, greeting])).digest("hex");
  return `${process.env.REDIS_PREFIX ?? "lobbystack"}:live:greeting-recording:${digest}`;
}

/** How long a recording plays, in milliseconds. */
export function recordingMs(audio: string): number {
  return Math.round(Buffer.byteLength(audio, "base64") / 2 / SAMPLES_PER_MS);
}
