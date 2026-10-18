import { createHash } from "node:crypto";

import type OpenAI from "openai";

/**
 * A recording of the business greeting, played into a call the moment it
 * connects. GPT-Live waits for the caller by default and skips the greeting
 * command on some calls, so a call that waits for it can open with seconds of
 * silence. OpenAI's guide recommends a recording for predictable greeting
 * playback, and an audio fixture plays one through the session's output.
 */

// OpenAI's speech model renders it, in the voice GPT-Live speaks with.
const RECORDING_MODEL = "gpt-4o-mini-tts";
const RECORDING_STYLE = "Speak warmly and naturally, like a receptionist answering a call.";
// The speech API's raw PCM is 16-bit mono at 24 kHz with no header, the format an audio fixture takes.
const SAMPLES_PER_MS = 24;
// OpenAI plays an audio fixture of at most 30 seconds.
const MAX_RECORDING_MS = 30_000;
// The speech API leaves quiet around the words. This much of it stays on each
// side, so a soft first sound isn't cut.
const EDGE_MS = 100;
const QUIET_AMPLITUDE = 100;

/** A recording stays this long after the last call that played it. */
export const GREETING_RECORDING_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Where a greeting's recording is kept. The key comes from the words and the
 * voice, so a changed greeting gets a new recording, and businesses with the
 * same greeting share one.
 */
export function greetingRecordingKey(greeting: string, voice: string): string {
  const digest = createHash("sha256").update(JSON.stringify([RECORDING_MODEL, RECORDING_STYLE, voice, greeting])).digest("hex");
  return `${process.env.REDIS_PREFIX ?? "lobbystack"}:live:greeting-recording:${digest}`;
}

/** How long a recording plays, in milliseconds. */
export function recordingMs(audio: string): number {
  return Math.round(Buffer.byteLength(audio, "base64") / 2 / SAMPLES_PER_MS);
}

// Cuts the quiet before the first sound and after the last, keeping EDGE_MS of it.
function trimQuiet(pcm: Buffer): Buffer {
  const samples = Math.floor(pcm.length / 2);
  let first = -1;
  let last = -1;
  for (let index = 0; index < samples; index += 1) {
    if (Math.abs(pcm.readInt16LE(index * 2)) < QUIET_AMPLITUDE) continue;
    if (first < 0) first = index;
    last = index;
  }
  if (first < 0) return Buffer.alloc(0);
  const edge = EDGE_MS * SAMPLES_PER_MS;
  return pcm.subarray(Math.max(0, first - edge) * 2, Math.min(samples, last + 1 + edge) * 2);
}

/** Renders the greeting as an audio fixture takes it: base64 16-bit PCM at 24 kHz. */
export async function recordGreeting(client: OpenAI, greeting: string, voice: string, options: { signal?: AbortSignal } = {}): Promise<string> {
  const response = await client.audio.speech.create(
    { model: RECORDING_MODEL, voice, input: greeting, instructions: RECORDING_STYLE, response_format: "pcm" },
    options.signal ? { signal: options.signal } : undefined,
  );
  const pcm = trimQuiet(Buffer.from(await response.arrayBuffer()));
  if (!pcm.length) throw new Error("The greeting recording came back silent.");
  if (pcm.length / 2 / SAMPLES_PER_MS > MAX_RECORDING_MS) throw new Error("The greeting recording is longer than the 30 seconds OpenAI plays.");
  return pcm.toString("base64");
}
