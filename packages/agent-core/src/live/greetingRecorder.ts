import { withoutSoundTags, type BusinessContextSnapshot } from "@lobbystack/shared";
import type OpenAI from "openai";
import type { SessionConfig } from "openai/resources/live/live";
import { LiveWS } from "openai/resources/live/ws";

import { buildPhoneSessionConfig } from "./session";

/**
 * Makes the recordings calls open with (greetingRecording.ts). A short
 * GPT-Live session, started with a phone call's session config, says the
 * opening to silence, so the recording sounds like the call it opens: the
 * same model, voice and instructions. A recording is kept only when
 * GPT-Live's transcript matches the opening, so one that leaves out part of
 * the notice that the call is with an AI and recorded never plays.
 */

// The session's audio: 16-bit mono PCM at 24 kHz, the format an audio fixture takes.
const RATE = 24_000;
const SAMPLES_PER_MS = RATE / 1000;
// GPT-Live expects caller audio all the time, so it hears silence, in chunks this long.
const CHUNK_MS = 100;
const SILENCE = Buffer.alloc(CHUNK_MS * SAMPLES_PER_MS * 2).toString("base64");
const TRIES = 3;
const START_TIMEOUT_MS = 10_000;
// The greeting command in the starting history makes GPT-Live speak about 2 seconds in (greeting.ts).
const SPEECH_TIMEOUT_MS = 8_000;
// GPT-Live sends no event when it stops speaking, so the recording ends on
// quiet. A pause between sentences can last over a second: the recording
// ends after this much quiet once the transcript has the whole opening, and
// after the longer wait otherwise.
const DONE_QUIET_MS = 1_500;
const QUIET_MS = 4_000;
// OpenAI plays an audio fixture of at most 30 seconds. A session still
// speaking well past that is given up on.
const MAX_RECORDING_MS = 30_000;
const MAX_SPEAKING_MS = MAX_RECORDING_MS + 10_000;
// GPT-Live streams silence between sentences and after them, so only a chunk
// louder than this, on a 16-bit scale, is speech.
const VOICE_RMS = 300;
// The quiet around the words is cut, keeping this much of it on each side so
// a soft first sound or a fading last one stays. Quieter than -45 dBFS over
// 20 ms is quiet.
const WINDOW_MS = 20;
const QUIET_RMS = 184;
const LEAD_MS = 100;
const TAIL_MS = 250;
// GPT-Live gets this long to end the session before the socket closes.
const CLOSE_DELAY_MS = 500;
// A transcript has to start and end with the opening's first and last few letters.
const EDGE_LETTERS = 3;
// The most characters of GPT-Live's words a failed try reports.
const REPORTED_CHARACTERS = 80;

function rms(pcm: Buffer): number {
  const samples = Math.floor(pcm.length / 2);
  if (!samples) return 0;
  let sum = 0;
  for (let index = 0; index < samples; index += 1) sum += pcm.readInt16LE(index * 2) ** 2;
  return Math.sqrt(sum / samples);
}

// Cuts the quiet before the first sound and after the last, keeping LEAD_MS and TAIL_MS of it.
function trimQuiet(audio: Buffer): Buffer {
  const pcm = audio.subarray(0, audio.length - (audio.length % 2));
  const windowBytes = WINDOW_MS * SAMPLES_PER_MS * 2;
  let first = -1;
  let last = -1;
  for (let offset = 0; offset < pcm.length; offset += windowBytes) {
    if (rms(pcm.subarray(offset, offset + windowBytes)) < QUIET_RMS) continue;
    if (first < 0) first = offset;
    last = Math.min(pcm.length, offset + windowBytes);
  }
  if (first < 0) return Buffer.alloc(0);
  return pcm.subarray(Math.max(0, first - LEAD_MS * SAMPLES_PER_MS * 2), Math.min(pcm.length, last + TAIL_MS * SAMPLES_PER_MS * 2));
}

// Letters, marks and digits in any script, so case, punctuation, spacing and
// the sounds GPT-Live marks in square brackets don't count.
const letters = (text: string): string[] => Array.from(withoutSoundTags(text).normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{M}\p{N}]/gu, ""));

function editDistance(said: string[], expected: string[]): number {
  let previous = Array.from({ length: expected.length + 1 }, (_, index) => index);
  for (let row = 1; row <= said.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= expected.length; column += 1) {
      current[column] = Math.min(previous[column]! + 1, current[column - 1]! + 1, previous[column - 1]! + (said[row - 1] === expected[column - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[expected.length]!;
}

/**
 * Whether GPT-Live's transcript is the opening. It starts and ends as the
 * opening does, so a recording cut short at either end fails, and one letter
 * in twenty may differ, up to six, as when it says "you are" for "you're". A
 * word left out of the notice, such as "transcribed", is more than that.
 */
export function saidOpening(transcript: string, greeting: string): boolean {
  const expected = letters(greeting);
  const said = letters(transcript);
  const edge = (text: string[]) => [text.slice(0, EDGE_LETTERS).join(""), text.slice(-EDGE_LETTERS).join("")].join(" ");
  return expected.length > 0 && edge(said) === edge(expected) && editDistance(said, expected) <= Math.min(6, Math.max(2, Math.floor(expected.length / 20)));
}

/** One session that says the opening: all its audio and its transcript, once it has gone quiet. */
async function sayOpening(client: OpenAI, session: SessionConfig, greeting: string, signal: AbortSignal | undefined): Promise<{ pcm: Buffer; transcript: string }> {
  const ws = new LiveWS(client);
  const chunks: Buffer[] = [];
  let transcript = "";
  let failure: Error | undefined;
  let lastError: string | undefined;
  let startedAt: number | undefined;
  let spokeAt: number | undefined;
  let lastVoiceAt = 0;
  ws.on("session.started", () => { startedAt ??= Date.now(); });
  ws.on("session.output_audio.delta", (event) => {
    const chunk = Buffer.from(event.delta, "base64");
    chunks.push(chunk);
    if (rms(chunk) < VOICE_RMS) return;
    lastVoiceAt = Date.now();
    spokeAt ??= lastVoiceAt;
  });
  ws.on("session.output_transcript.delta", (event) => { transcript += event.delta; });
  ws.on("session.closed", (event) => { failure ??= new Error(`GPT-Live ended the session (${event.reason}).`); });
  // Kept for the socket's whole life: an error with no listener is an unhandled
  // rejection. One before the session starts ends the try; after, GPT-Live may
  // still say the opening, and the checks decide.
  ws.on("error", (error) => {
    const message = error.error?.error.message ?? error.message;
    if (startedAt === undefined) failure ??= new Error(message);
    else lastError ??= message;
  });
  ws.on("close", () => { failure ??= new Error("The connection to GPT-Live closed."); });
  const openedAt = Date.now();
  ws.send({ type: "session.start", session });
  let tick: ReturnType<typeof setInterval> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      tick = setInterval(() => {
        const now = Date.now();
        if (signal?.aborted) return reject(signal.reason);
        if (failure) return reject(failure);
        if (startedAt === undefined) {
          if (now - openedAt >= START_TIMEOUT_MS) reject(new Error("GPT-Live didn't start the session."));
          return;
        }
        ws.send({ type: "session.input_audio.append", audio: SILENCE });
        if (spokeAt === undefined) {
          if (now - startedAt >= SPEECH_TIMEOUT_MS) reject(new Error(lastError ? `GPT-Live didn't speak, after: ${lastError}` : "GPT-Live didn't speak."));
        } else if (now - lastVoiceAt >= (saidOpening(transcript, greeting) ? DONE_QUIET_MS : QUIET_MS)) {
          resolve();
        } else if (now - spokeAt >= MAX_SPEAKING_MS) {
          reject(new Error("GPT-Live kept speaking."));
        }
      }, CHUNK_MS);
    });
    return { pcm: Buffer.concat(chunks), transcript: transcript.trim() };
  } finally {
    clearInterval(tick);
    ws.send({ type: "session.close" });
    setTimeout(() => ws.close(), CLOSE_DELAY_MS);
  }
}

/**
 * Records the call's opening, `greeting`, as GPT-Live says it at the start of
 * a phone call in `voice`. The session has the business's instructions from
 * `snapshot`, with the opening as its greeting. Returns the recording, base64
 * 16-bit PCM at 24 kHz, and how many sessions it took. Throws when none of
 * the three said the opening.
 */
export async function recordGreeting(client: OpenAI, input: { greeting: string; voice: string; snapshot: BusinessContextSnapshot }, options: { signal?: AbortSignal } = {}): Promise<{ audio: string; tries: number }> {
  if (!input.greeting.trim()) throw new Error("The call opens with nothing to record.");
  // A WebSocket session isn't accepted like a call, and isn't kept.
  const { type: _type, store: _store, ...call } = buildPhoneSessionConfig({ ...input.snapshot, greeting: input.greeting, recordingNotice: false }, { voice: input.voice });
  const session: SessionConfig = { ...call, audio: { ...call.audio, format: { type: "audio/pcm", rate: RATE } } };
  const failures: string[] = [];
  for (let tries = 1; tries <= TRIES; tries += 1) {
    options.signal?.throwIfAborted();
    try {
      const said = await sayOpening(client, session, input.greeting, options.signal);
      const pcm = trimQuiet(said.pcm);
      const words = said.transcript.length > REPORTED_CHARACTERS ? `${said.transcript.slice(0, REPORTED_CHARACTERS)}…` : said.transcript;
      if (!saidOpening(said.transcript, input.greeting)) failures.push(words ? `${tries}: GPT-Live said "${words}".` : `${tries}: GPT-Live's speech had no transcript.`);
      else if (!pcm.length) failures.push(`${tries}: the recording came back silent.`);
      else if (pcm.length / 2 / SAMPLES_PER_MS > MAX_RECORDING_MS) failures.push(`${tries}: the recording is longer than the 30 seconds OpenAI plays.`);
      else return { audio: pcm.toString("base64"), tries };
    } catch (error) {
      if (options.signal?.aborted) throw error;
      failures.push(`${tries}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`GPT-Live didn't record the opening in ${TRIES} tries. ${failures.join(" ")}`);
}
