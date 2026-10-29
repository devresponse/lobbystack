import { EventEmitter } from "node:events";

import { callOpening, demoSnapshot } from "@lobbystack/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type FakeLive = EventEmitter & { sent: Array<Record<string, unknown>>; closed: boolean };
const sockets = vi.hoisted(() => [] as FakeLive[]);

vi.mock("openai/resources/live/ws", () => ({
  LiveWS: class extends EventEmitter {
    sent: unknown[] = [];
    closed = false;
    constructor() {
      super();
      sockets.push(this as never);
    }
    send(event: unknown) { this.sent.push(event); }
    close() { this.closed = true; }
  },
}));

import { greetingCommand } from "./greeting";
import { recordGreeting, saidOpening } from "./greetingRecorder";
import { recordingMs } from "./greetingRecording";

// The greeting, then the notice that the call is with an AI and recorded.
const opening = callOpening(demoSnapshot);
const input = { greeting: opening, voice: "marin", snapshot: demoSnapshot };

// GPT-Live's audio, 16-bit PCM at 24 kHz: speech, or the near-silence it streams between sentences and after them.
const pcm = (ms: number, amplitude: number) => Buffer.from(new Int16Array(ms * 24).map((_, index) => (index % 2 ? amplitude : -amplitude)).buffer).toString("base64");
const quiet = (ms: number) => pcm(ms, 20);

// GPT-Live saying `words` in `ms` of speech, after `pauseMs` of quiet.
function say(socket: FakeLive, words: string, ms = 2_000, pauseMs = 0) {
  if (pauseMs) socket.emit("session.output_audio.delta", { delta: quiet(pauseMs) });
  socket.emit("session.output_audio.delta", { delta: pcm(ms, 3_000) });
  socket.emit("session.output_transcript.delta", { delta: words, start_ms: 0, end_ms: ms });
}

// The try under way: its socket, once GPT-Live has started the session.
async function started(count: number) {
  await vi.advanceTimersByTimeAsync(0);
  expect(sockets).toHaveLength(count);
  const socket = sockets.at(-1)!;
  socket.emit("session.started", {});
  return socket;
}

beforeEach(() => {
  vi.useFakeTimers();
  sockets.length = 0;
});
afterEach(() => { vi.useRealTimers(); });

describe("recordGreeting", () => {
  it("has GPT-Live say the opening in a phone call's session, to silence, and keeps 100 ms of quiet before it and 250 ms after", async () => {
    const recording = recordGreeting({} as never, input);
    const socket = await started(1);
    const start = socket.sent[0] as { type: string; session: Record<string, unknown> };
    expect(start).toMatchObject({
      type: "session.start",
      session: {
        model: "gpt-live-1",
        audio: { output: { voice: "marin" }, format: { type: "audio/pcm", rate: 24_000 } },
        input: [{ role: "developer", content: [{ type: "input_text", text: greetingCommand(opening) }] }],
      },
    });
    expect(start.session.instructions).toContain(`Open the call with this greeting as soon as you're told to start: "${opening}"`);
    // A WebSocket session isn't accepted like a call, and OpenAI doesn't keep it.
    expect(start.session).not.toHaveProperty("type");
    expect(start.session).not.toHaveProperty("store");
    await vi.advanceTimersByTimeAsync(300);
    const silence = socket.sent.filter((event) => event.type === "session.input_audio.append");
    expect(silence).toHaveLength(3);
    expect(Buffer.from(String(silence[0]!.audio), "base64")).toEqual(Buffer.alloc(4_800));

    say(socket, opening, 2_000, 1_000);
    socket.emit("session.output_audio.delta", { delta: quiet(2_000) });
    await vi.advanceTimersByTimeAsync(1_500);
    const { audio, tries } = await recording;
    expect(tries).toBe(1);
    expect(recordingMs(audio)).toBe(2_350);
    expect(socket.sent.at(-1)).toEqual({ type: "session.close" });
    await vi.advanceTimersByTimeAsync(500);
    expect(socket.closed).toBe(true);
  });

  it("waits through a pause until the transcript has the whole opening", async () => {
    let done = false;
    const recording = recordGreeting({} as never, input).finally(() => { done = true; });
    const socket = await started(1);
    say(socket, `${demoSnapshot.greeting} `);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(done).toBe(false);
    say(socket, opening.slice(demoSnapshot.greeting!.length + 1), 4_000, 500);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(done).toBe(true);
    expect(recordingMs((await recording).audio)).toBe(6_500);
  });

  it("tries a new session when one fails, up to three, and says why each failed", async () => {
    const recording = recordGreeting({} as never, input).catch((error: unknown) => error);
    // The first never starts.
    await vi.advanceTimersByTimeAsync(10_000);
    // The second says something else, and goes quiet for 4 seconds.
    say(await started(2), "Hello! How can I help you today?");
    await vi.advanceTimersByTimeAsync(4_000);
    // The third is refused.
    await vi.advanceTimersByTimeAsync(0);
    sockets[2]!.emit("error", { message: "Live error", error: { error: { message: "Rate limit reached." } } });
    await vi.advanceTimersByTimeAsync(100);
    expect(((await recording) as Error).message).toBe('GPT-Live didn\'t record the opening in 3 tries. 1: GPT-Live didn\'t start the session. 2: GPT-Live said "Hello! How can I help you today?". 3: Rate limit reached.');
    expect(sockets.every((socket) => socket.sent.at(-1)?.type === "session.close")).toBe(true);
  });

  it("keeps the recording from a later try, even after an error once the session started", async () => {
    const recording = recordGreeting({} as never, input);
    await started(1);
    await vi.advanceTimersByTimeAsync(8_000);
    const second = await started(2);
    second.emit("error", { message: "Live error", error: { error: { message: "Unknown parameter." } } });
    await vi.advanceTimersByTimeAsync(1_000);
    say(second, opening);
    await vi.advanceTimersByTimeAsync(1_500);
    await expect(recording).resolves.toMatchObject({ tries: 2 });
  });

  it("says what went wrong when GPT-Live doesn't speak after an error", async () => {
    const recording = recordGreeting({} as never, input).catch((error: unknown) => error);
    for (const count of [1, 2, 3]) {
      (await started(count)).emit("error", { message: "Live error", error: { error: { message: "The server had an error." } } });
      await vi.advanceTimersByTimeAsync(8_000);
    }
    expect(((await recording) as Error).message).toBe("GPT-Live didn't record the opening in 3 tries. 1: GPT-Live didn't speak, after: The server had an error. 2: GPT-Live didn't speak, after: The server had an error. 3: GPT-Live didn't speak, after: The server had an error.");
  });

  it("refuses a recording longer than the 30 seconds OpenAI plays, and a session that keeps speaking", async () => {
    const recording = recordGreeting({} as never, input).catch((error: unknown) => error);
    say(await started(1), opening, 31_000);
    await vi.advanceTimersByTimeAsync(1_500);
    for (const count of [2, 3]) {
      const socket = await started(count);
      for (let second = 0; second <= 40; second += 1) {
        socket.emit("session.output_audio.delta", { delta: pcm(1_000, 3_000) });
        await vi.advanceTimersByTimeAsync(1_000);
      }
    }
    expect(((await recording) as Error).message).toBe("GPT-Live didn't record the opening in 3 tries. 1: the recording is longer than the 30 seconds OpenAI plays. 2: GPT-Live kept speaking. 3: GPT-Live kept speaking.");
  });

  it("opens no session for a call that opens with nothing to say", async () => {
    await expect(recordGreeting({} as never, { ...input, greeting: " " })).rejects.toThrow("nothing to record");
    expect(sockets).toHaveLength(0);
  });

  it("stops at once when its signal aborts", async () => {
    const abort = new AbortController();
    const recording = recordGreeting({} as never, input, { signal: abort.signal }).catch((error: unknown) => error);
    const socket = await started(1);
    await vi.advanceTimersByTimeAsync(1_000);
    abort.abort(new Error("Timed out."));
    await vi.advanceTimersByTimeAsync(100);
    expect(((await recording) as Error).message).toBe("Timed out.");
    expect(socket.sent.at(-1)).toEqual({ type: "session.close" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sockets).toHaveLength(1);
  });
});

describe("saidOpening", () => {
  it("ignores case, punctuation, spacing and the sounds GPT-Live marks", () => {
    expect(saidOpening("[clears throat] thank you for calling maple family clinic you're speaking with an AI assistant and this call is recorded and transcribed", opening)).toBe(true);
  });

  it("lets a few letters differ, but not a word of the notice", () => {
    expect(saidOpening(opening.replace("You're", "You are"), opening)).toBe(true);
    expect(saidOpening(opening.replace(" and transcribed", ""), opening)).toBe(false);
    expect(saidOpening(opening.replace("transcribed", ""), opening)).toBe(false);
    expect(saidOpening(`${opening} How can I help you today?`, opening)).toBe(false);
    expect(saidOpening("", "")).toBe(false);
  });

  it("wants the opening's first and last letters, so a recording cut short at either end fails", () => {
    expect(saidOpening(opening.replace("transcribed.", "transcribe"), opening)).toBe(false);
    expect(saidOpening(opening.replace("Thank you", "you"), opening)).toBe(false);
  });

  it("works in languages written without spaces", () => {
    const japanese = callOpening({ greeting: "お電話ありがとうございます。", defaultLocale: "ja" });
    expect(saidOpening(japanese.replace(/[。、 ]/g, ""), japanese)).toBe(true);
    expect(saidOpening(japanese.replace("文字起こしされます", ""), japanese)).toBe(false);
  });
});
