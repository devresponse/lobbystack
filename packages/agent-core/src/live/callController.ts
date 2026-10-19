import { CONTACT_PASSCODE_MAX_LENGTH, CONTACT_PASSCODE_MIN_LENGTH } from "@lobbystack/shared";
import type { LanguageModelUsage } from "ai";
import type OpenAI from "openai";
import type { DelegationCreatedEvent } from "openai/resources/live/live";
import { SidebandWS } from "openai/resources/live/sideband/ws";

import { logEvent, reportError, setSpanAttributes, withSpan, type Span } from "@lobbystack/telemetry/node";

import type { AiTraceStep } from "@lobbystack/domain";

import { toAiTraceSteps, type ReceptionistAgent } from "../agent";
import type { KeypadPasscodeCheck, KeypadPasscodeOutcome } from "../tools";
import { CALL_ENDING, DIRECT_ANSWER_TOOLS, directToolAnswer, fitToAppend, type DirectAnswerStep } from "./directAnswer";
import { greetingCommand } from "./greeting";
import { recordingMs } from "./greetingRecording";
import { LiveLatencyTracker, type LiveCallLatency } from "./latency";

type Turn = { role: "caller" | "receptionist"; text: string; endMs: number };

export type DelegationTiming = {
  delegationId: string;
  offsetMs: number;
  transcriptWaitMs: number;
  /** Time spent waiting for an earlier request on the call to finish first. */
  queueMs: number;
  agentMs: number;
  totalMs: number;
  tools: string[];
  /** Model calls the agent made. A direct tool answer saves the last one. */
  modelSteps: number;
  /** The answer came straight from a tool result, with no model step to phrase it. */
  directAnswer: boolean;
  /** How long each step took, a model call plus the tools it called, in order. */
  stepMs: number[];
  /** Time spent running tools across all steps. The rest of agentMs is the model. */
  toolMs: number;
  answer: string;
  failed: boolean;
  /** The caller made a newer request before this one finished, so its result wasn't spoken. */
  superseded: boolean;
  /** The agent ended the call, so the result went to GPT-Live as silent background. */
  endedCall: boolean;
  /** Tokens across the agent's model steps, when the generation finished. */
  usage?: LanguageModelUsage;
};

/**
 * What one delegated request was given and did, for its AI debug trace (ADR
 * 0009). It holds the conversation, so it only goes to onDelegationTrace,
 * never to logs or telemetry.
 */
export type DelegationTrace = {
  delegationId: string;
  prompt: string;
  steps: AiTraceStep[];
  /** What GPT-Live was handed: the answer, or a note that the result was background only. */
  sent: string;
  directAnswer: boolean;
  failed: boolean;
  superseded: boolean;
  endedCall: boolean;
  agentMs: number;
  usage?: LanguageModelUsage;
};

export type LiveCallSummary = {
  sessionId: string;
  durationMs: number;
  /**
   * Session length OpenAI bills for: the final usage from session.closed, or
   * the latest session.usage.updated when the session never confirmed it.
   */
  billedSeconds?: number;
  /** False when the connection ended before OpenAI sent session.closed. */
  usageConfirmed: boolean;
  delegations: DelegationTiming[];
  closeReason?: string;
  /** What the caller heard: when the receptionist first spoke and the gap before each answer. */
  latency?: LiveCallLatency;
  /**
   * The undocumented output audio events the sideband reflected: how many,
   * where the first one started, and the timeline they covered. GPT-Live is
   * full duplex, so these can cover silence; this shows how much.
   */
  outputAudio: { deltas: number; firstStartMs?: number; coveredMs: number; payloadBytes: number };
  /**
   * The caller's audio as OpenAI received it and reflected it to the
   * sideband: how many chunks, how long they last, and how much of that was
   * loud enough to be speech. Coverage well short of the call's length means
   * audio stopped reaching GPT-Live, for example while the caller was silent.
   */
  inputAudio: { chunks: number; coveredMs: number; loudMs: number; payloadBytes: number };
  /**
   * The worker attached after the sideband's 3-second replay window, so it
   * missed session.started and the start of the conversation.
   */
  lateAttach: boolean;
  /** Where the first event with a timeline position started, in session milliseconds. */
  firstEventMs?: number;
};

/** A finished stretch of speech by one side, numbered in call order. */
export type LiveCallTurn = { sequence: number; speaker: "caller" | "assistant"; text: string };

export type LiveCallTimeout = "silence_timeout" | "duration_limit";
/** Why the worker ends a call that's still going: a timeout, or the worker restarting. */
export type LiveCallWrapUp = LiveCallTimeout | "service_restart";
/**
 * A transfer's progress: the REFER went out, OpenAI accepted it, the
 * destination answered, or the transfer failed and the call stays with the
 * receptionist.
 */
export type LiveCallTransferState = "referring" | "referred" | "completed" | "failed";

export type GreetingEvent = {
  /**
   * "spoken": the receptionist's voice was heard; attempt 0 means the greeting
   * in the session's starting history did it, and attempt N that it followed
   * the Nth greeting command. "sent", "acknowledged" and "failed" track each
   * command, and the recording of the greeting.
   */
  step: "sent" | "acknowledged" | "spoken" | "failed";
  attempt: number;
  /**
   * What the step is about: the recording of the greeting, the first
   * fallback command, or a retry after an acknowledged command went unspoken.
   */
  trigger?: "recording" | "fallback" | "retry";
  /** Milliseconds since the worker attached to the call. */
  sinceAttachMs: number;
  /**
   * Milliseconds of caller audio the sideband has reflected so far. Close to
   * sinceAttachMs (less the time before the session started) means audio
   * reaches GPT-Live while the caller is silent.
   */
  inputAudioMs: number;
  error?: string;
};

/** What the controller needs from the business. The worker may still be loading it when the call connects. */
export type LiveCallSetup = {
  agent: ReceptionistAgent;
  /**
   * The business greeting. GPT-Live speaks it from the session's starting
   * history; the controller only sends it again as a fallback.
   */
  greeting?: string;
  /**
   * Set when a recording of the greeting opens the call, and the session's
   * starting history has the greeting as already said. The controller plays
   * `audio` (base64 16-bit PCM at 24 kHz) as soon as the session starts.
   * Without `audio`, or when OpenAI doesn't play it, the greeting command
   * goes out at once, since GPT-Live won't say the greeting on its own.
   */
  greetingRecording?: { audio?: string };
  /**
   * Whether a caller who spoke after the agent ended the call is only saying
   * goodbye (live/callerDone.ts), so the call still ends. Without it, any
   * words keep the call going.
   */
  callerDone?: (conversation: string, abortSignal: AbortSignal) => Promise<boolean>;
  /**
   * The business takes PINs on the keypad, so key presses reach the transcript
   * as "[pressed a key]", without the key: a PIN typed before the receptionist
   * asks for it stays out of the transcript too. A phone call's presses are
   * masked until the setup arrives, since the business may take PINs.
   */
  maskKeypad?: boolean;
};

export type LiveCallControllerOptions = {
  client: OpenAI;
  sessionId: string;
  /** A phone call ends through OpenAI's SIP hangup; a browser call by closing the session. */
  phone: boolean;
  setup: LiveCallSetup | Promise<LiveCallSetup>;
  /** Hang up after this long without either side speaking. */
  silenceTimeoutMs?: number;
  /** The call ends by this long: the goodbye starts a little before it. */
  maxDurationMs?: number;
  /**
   * Asks for more minutes about a minute before the duration limit's goodbye,
   * and resolves to the milliseconds granted, which extend the limit. 0 ends
   * the asking, so the call ends at its limit.
   */
  topUp?: () => Promise<number>;
  /** Audio is flowing: the session started. */
  onStarted?: () => void;
  /** Each step of the greeting, for logs: sent, acknowledged, spoken or failed. */
  onGreeting?: (event: GreetingEvent) => void;
  onTurn?: (turn: LiveCallTurn) => void;
  onTimeout?: (reason: LiveCallTimeout) => void;
  /** Each step of a transfer started with transferAfterAnnouncement(). */
  onTransfer?: (state: LiveCallTransferState) => void;
  onDelegation?: (timing: DelegationTiming) => void;
  /** Each delegated request's prompt, steps and result, for its AI debug trace. */
  onDelegationTrace?: (trace: DelegationTrace) => void;
  onClose?: (summary: LiveCallSummary) => void;
  /**
   * The session sent its first event other than an error, so it's alive. A
   * live session sends one right after the sideband connects: the replay of
   * the last 3 seconds, and output audio that flows even through silence.
   */
  onFirstEvent?: () => void;
  /**
   * When re-attaching to a call whose worker died: with no event by this long
   * after the connection opens, the session is taken as gone and the call ends
   * with the close reason "no_session_events". Until the session has sent an
   * event, the controller never hangs up on its own: the worker decides
   * whether the session is gone or the re-attach should be tried again.
   */
  firstEventTimeoutMs?: number;
  /**
   * Opens the socket the controller listens and answers on, a sideband
   * attached to the session by default. scripts/voice/live-call-eval.ts passes
   * the WebSocket session it opened, since a sideband can't attach to one.
   */
  connect?: () => SidebandWS;
};

// The caller's last words can arrive just after the delegation event.
const TRANSCRIPT_WAIT_MS = 300;
// GPT-Live speaks the greeting from the session's starting history about 2
// seconds in. With no voice by this long after the worker sees the session
// start, it sends the greeting command once more.
const GREETING_FALLBACK_MS = 4_000;
// GPT-Live can acknowledge a greeting command and still wait for the caller:
// on calls from October 3 to 8, 8 of 16 acknowledged commands went unspoken
// until the caller spoke, or for good. A command it did follow was spoken
// within 4 seconds of the acknowledgment, so after 4.5 seconds of silence the
// worker sends it again, up to this many commands in all.
const GREETING_RETRY_MS = 4_500;
const GREETING_COMMANDS = 3;
// OpenAI confirms a recording it plays with session.output_audio.fixture.playing
// once it has checked the audio. Without that by this long, the greeting
// command goes out instead.
const RECORDING_START_MS = 3_000;
const GREETING_RECORDING = "greeting_recording";
// Reflected audio is 16-bit PCM at 24 kHz. A chunk this loud is voice;
// silence on staging calls stayed far below it.
const VOICE_RMS = 400;
const SAMPLES_PER_MS = 24;
// Most answers take one or two seconds; past this the caller hears an update.
const STILL_WORKING_MS = 4_000;
// Requests run one at a time, so a stuck one would hold up every later one.
// Past this it's abandoned and the caller hears that it couldn't be completed.
const DELEGATION_TIMEOUT_MS = 30_000;
// Past the sideband's 3-second replay window, session.started can't arrive.
const LATE_ATTACH_MS = 3_500;
// An attach can fail at OpenAI's edge, for example with a 504, while the
// session itself is fine. The SDK retries it after about 250 ms, 500 ms and
// 1 second, but only until the session sends its first event: a new
// connection replays the last 3 seconds, so a retry mid-call could answer the
// same request twice.
const ATTACH_RETRY = { maxRetries: 3, initialDelay: 250, maxDelay: 1_000 };
// After session.close or a hangup, how long to wait for session.closed.
const FINALIZE_TIMEOUT_MS = 15_000;
// Ending the call waits for the goodbye: for it to start, then for its audio to finish.
const GOODBYE_START_MS = 4_000;
const GOODBYE_MAX_MS = 15_000;
const GOODBYE_QUIET_MS = 1_000;
const GOODBYE_POLL_MS = 200;
// A caller who is done is hung up on once the receptionist's goodbye has
// played and both sides have been quiet this long, so they can still say
// "oh, wait". Speech still coming holds it, up to the second bound.
const CALLER_DONE_QUIET_MS = 2_000;
const CALLER_DONE_MAX_MS = 20_000;
// A caller who spoke after the call was ended is checked once they've paused this long.
const CALLER_CHECK_QUIET_MS = 800;
// A wrap-up's goodbye counts from OpenAI's acknowledgment of the command, or
// from the request when no acknowledgment arrives by this long.
const WRAP_UP_ACK_WAIT_MS = 2_000;
/** The longest a wrap-up takes: waiting for the goodbye, then for session.closed. */
export const WRAP_UP_MAX_MS = GOODBYE_MAX_MS + FINALIZE_TIMEOUT_MS;
// The duration limit's goodbye starts this long before the limit, so it fits
// inside the minutes the call reserved. A call that reserved under a minute
// gets half its length to talk instead.
const DURATION_WRAP_UP_LEAD_MS = 30_000;
// A call that can top up its minutes asks this long before the limit's
// goodbye, and asks again this often after a failure until the goodbye starts.
const TOP_UP_LEAD_MS = 60_000;
const TOP_UP_RETRY_MS = 10_000;
// An accepted REFER ends OpenAI's leg, so session.closed follows. Twilio
// closes it only 32 seconds after the destination answers, because OpenAI
// doesn't hang up on Twilio's NOTIFY, and the destination may ring first.
// A caller still on the session this long after it means the transfer didn't happen.
const TRANSFER_OUTCOME_MS = 70_000;
// Actions the next request sees, newest last.
const MAX_REMEMBERED_ACTIONS = 10;
// A PIN typed on the keypad ends at the pound key, at the longest PIN length,
// or this long after the last key once it's as long as the shortest PIN.
const PASSCODE_KEY_GAP_MS = 6_000;
// With no key for this long, the keypad stops taking a PIN.
const PASSCODE_IDLE_MS = 60_000;

// The facts GPT-Live receives when a request fails. Its instructions say what to do then.
const FAILED_ANSWER = "The backend couldn't complete this request.";
const CALLER_SPOKE_AGAIN = "The caller spoke again before the call ended, so reply to what they said.";
const STILL_WORKING = "Still checking. This is taking a few more seconds.";
// Commands for GPT-Live when the call has to end, or a transfer didn't go through.
const WRAP_UP: Record<LiveCallWrapUp, string> = {
  silence_timeout: "Nobody has spoken for a while, so the call is ending now. In the language of the conversation, say a short goodbye.",
  duration_limit: "The call has reached its time limit and is ending now. In the language of the conversation, tell the caller briefly, apologize, invite them to call back if they need more help, and say goodbye.",
  service_restart: "The phone service is restarting, so the call has to end now. In the language of the conversation, apologize briefly, ask the caller to call back in a minute, and say goodbye.",
};
const TRANSFER_FAILED = "The transfer to a person didn't go through. In the language of the conversation, tell the caller briefly and offer to take a message so the team can call them back.";

// What GPT-Live hears once the caller has typed a PIN, since it never hears key presses.
function passcodeCommand(outcome: KeypadPasscodeOutcome): string {
  if (outcome.status === "accepted") return "The caller typed their PIN on the keypad and it was accepted. In the language of the conversation, tell them briefly, then ask whether to go ahead with the change they asked for.";
  if (outcome.status === "retry") {
    const left = outcome.attemptsLeft;
    return `The PIN the caller typed on the keypad didn't match${left ? `, and they have ${left} more ${left === 1 ? "try" : "tries"}` : ""}. In the language of the conversation, tell them briefly and ask them to type it again, then press the pound key.`;
  }
  return ["The PIN the caller typed on the keypad wasn't accepted.", outcome.reason ?? "", "In the language of the conversation, tell them briefly and offer to pass their request to the team."].filter(Boolean).join(" ");
}

// What GPT-Live hears, and the next request sees, when the keypad stops taking
// a PIN the caller didn't finish. GPT-Live was told to wait quietly, so without
// it the call would sit silent. The conversation may have moved on meanwhile.
// Another try needs the backend to start the keypad again.
const PASSCODE_STOPPED = "The keypad stopped taking the PIN after a minute without a key press. If you're still waiting for the caller to type it, tell them briefly in the language of the conversation and ask whether they want to try again; if they do, delegate to the backend to start the keypad again before you ask for the PIN. If the conversation has moved on, don't bring it up.";
// What GPT-Live hears when the caller presses the pound key before typing as
// many digits as the shortest PIN has. It isn't checked, so it uses no try.
const PASSCODE_TOO_SHORT = `The caller pressed the pound key after fewer than ${CONTACT_PASSCODE_MIN_LENGTH} digits, and every PIN is at least that long, so it wasn't checked and used none of their tries. In the language of the conversation, ask them briefly to type their whole PIN again, then press the pound key.`;
const PASSCODE_STOPPED_RESULT = { ok: false, reason: "The keypad stopped taking the PIN after a minute without a key press. If the caller wants to try again, verify the appointment again, then start the check again with requestKeypadPasscode." };

// Tools that change something. The next request on the call sees their results,
// so a changed request reschedules instead of booking twice. endCall isn't one:
// a call that goes on after it was cancelled, and the next request may end it again.
const ACTION_TOOLS = new Set(["bookAppointment", "requestAppointment", "requestAppointmentCancellation", "cancelAppointment", "rescheduleAppointment", "takeMessage", "transferCall"]);
// The caller's answer about texts. The next request sees only the latest one,
// in one slot, and saving it doesn't count as booking or changing anything.
const ANSWER_TOOLS = new Set(["recordTextPreference"]);
// Lookups the next request can reuse instead of repeating.
const REUSABLE_LOOKUPS = new Set(["findAvailability"]);
const PROGRESS: Record<string, string> = {
  findAvailability: "looked up open times",
  bookAppointment: "tried to book the appointment",
  requestAppointment: "tried to save the appointment request",
  requestAppointmentCancellation: "tried to save the cancellation request",
  lookupAppointmentForChange: "looked up the caller's appointment",
  verifyAppointmentForChange: "checked the caller's identity",
  sendAppointmentChangeOtp: "sent a verification code",
  verifyAppointmentChangeOtp: "checked the verification code",
  requestKeypadPasscode: "started the keypad PIN check",
  cancelAppointment: "tried to cancel the appointment",
  rescheduleAppointment: "tried to reschedule the appointment",
  recordTextPreference: "tried to save the caller's answer about texts",
  takeMessage: "tried to save the message",
  transferCall: "tried to transfer the call",
  searchKnowledge: "searched the business's documents",
};

type PendingAppend = { kind: "greeting" | "recording" | "answer" | "update" | "wrap_up"; delegationId?: string };
// OpenAI's sideband reference documents this command; the SDK's types don't have it yet.
type AudioFixturePlay = { type: "session.output_audio.fixture.play"; audio: string; event_id: string };
// A hangup waiting for the caller to be done. afterMs is where the request
// that ended the call was made on the session timeline: the caller speaking
// after it holds the hangup until a check says whether they're only saying
// goodbye, or cancels it when there's no check.
type PendingHangup = { afterMs: number; requestedAt: number; onCancelled?: () => void; callerSpoke?: boolean; checking?: boolean };
// The close reason when another worker took the call over.
const DETACHED = "detached";
type StepLike = DirectAnswerStep & { toolResults: Array<{ toolName: string; output: unknown }> };

/** How many samples a base64 chunk of 16-bit PCM holds, and whether it's loud enough to be speech. */
function measurePcm(base64: string): { samples: number; voice: boolean } {
  const bytes = Buffer.from(base64, "base64");
  const samples = Math.floor(bytes.length / 2);
  if (!samples) return { samples, voice: false };
  let sum = 0;
  for (let index = 0; index < samples; index += 1) {
    const sample = bytes.readInt16LE(index * 2);
    sum += sample * sample;
  }
  return { samples, voice: Math.sqrt(sum / samples) >= VOICE_RMS };
}

/** Whether a base64 chunk of 16-bit PCM is loud enough to be speech. */
export function isVoice(base64: string): boolean {
  return measurePcm(base64).voice;
}

function succeeded(output: unknown): boolean {
  return typeof output === "object" && output !== null && (output as { ok?: unknown }).ok !== false;
}

function endsCall(steps: StepLike[]): boolean {
  return steps.some((step) => step.toolResults.some((result) => result.toolName === "endCall" && succeeded(result.output)));
}

/**
 * Holds the sideband connection for one GPT-Live session for the whole call and
 * answers every delegation with the receptionist agent.
 */
export class LiveCallController {
  private readonly startedAt = Date.now();
  private readonly attachedAt = performance.now();
  private readonly turns: Turn[] = [];
  private readonly delegations: DelegationTiming[] = [];
  private readonly abort = new AbortController();
  private readonly latency = new LiveLatencyTracker();
  private readonly ready: Promise<LiveCallSetup>;
  private socket: SidebandWS | undefined;
  private transcriptWaiters: Array<{ offsetMs: number; resolve: () => void }> = [];
  private emittedTurns = 0;
  private silenceTimer: ReturnType<typeof setTimeout> | undefined;
  private durationTimer: ReturnType<typeof setTimeout> | undefined;
  private greetingTimer: ReturnType<typeof setTimeout> | undefined;
  private finalizeTimer: ReturnType<typeof setTimeout> | undefined;
  private firstEventTimer: ReturnType<typeof setTimeout> | undefined;
  private transferTimer: ReturnType<typeof setTimeout> | undefined;
  private topUpTimer: ReturnType<typeof setTimeout> | undefined;
  // Milliseconds top-ups added to the duration limit, and when, in Date.now()
  // time, the limit's goodbye starts.
  private grantedMs = 0;
  private durationWrapUpAt = 0;
  // When OpenAI acknowledged the wrap-up command, in performance.now() time.
  private wrapUpAckedAt: number | undefined;
  private started = false;
  // When the worker saw session.started, in performance.now() time.
  private startedSeenAt: number | undefined;
  // The session has sent this sideband an event, so a dropped connection is no
  // longer retried.
  private sessionEventSeen = false;
  private sessionAlive = false;
  private greetingAttempts = 0;
  private greetingFallbackStarted = false;
  private greetingSpoken = false;
  // The recording of the greeting OpenAI was asked to play: its words, for
  // the transcript, how long it plays, and whether OpenAI started it.
  private recording: { text: string; ms: number; playing?: boolean } | undefined;
  private readonly pendingAppends = new Map<string, PendingAppend>();
  // Delegations run one at a time in arrival order. A newer request supersedes
  // an unfinished older one: its result goes to GPT-Live as background facts
  // and to the next request, rather than being spoken over the newer answer.
  private delegationQueue: Promise<void> = Promise.resolve();
  private latestRevision = 0;
  private runningDelegations = 0;
  private unheardResults: string[] = [];
  private readonly completedActions: string[] = [];
  private latestLookup: string | undefined;
  // A PIN the caller is typing on the keypad, and the latest check's result,
  // or the keypad stopping, which the next request sees.
  private passcode: { check: KeypadPasscodeCheck; digits: string; checking: boolean; timer?: ReturnType<typeof setTimeout> } | undefined;
  private passcodeNotices = 0;
  private latestPasscode: string | undefined;
  private maskKeypad: boolean;
  // The session timeline, to tell when the receptionist's audio has played out.
  private timelineOrigin: number | undefined;
  // The receptionist's speech, from output transcript text: where it ends on
  // the session timeline, and when its latest words arrived.
  private lastSpeechEndMs = 0;
  private lastSpeechAt = Number.NEGATIVE_INFINITY;
  private readonly outputAudio: LiveCallSummary["outputAudio"] = { deltas: 0, coveredMs: 0, payloadBytes: 0 };
  private readonly inputAudio = { chunks: 0, samples: 0, loudSamples: 0, payloadBytes: 0 };
  private lastAnswerSentAt: number | undefined;
  // When the caller last spoke, in performance.now() time, and where their
  // latest words started on the session timeline.
  private lastCallerAt = Number.NEGATIVE_INFINITY;
  private lastCallerStartMs = Number.NEGATIVE_INFINITY;
  // The request the agent is answering now. Requests run one at a time.
  private answering: { offsetMs: number; revision: number } | undefined;
  private pendingHangup: PendingHangup | undefined;
  // The caller kept the call going after the last request that ended it.
  private hangupCancelled = false;
  private callerDone: LiveCallSetup["callerDone"];
  private ending = false;
  // A transfer in progress: waiting for the announcement to play, waiting for
  // OpenAI to accept the REFER, or referred and waiting for the outcome.
  private transfer: "announcing" | "referring" | "referred" | undefined;
  private lateAttach = false;
  private firstEventMs: number | undefined;
  private latestUsageSeconds: number | undefined;
  private finished = false;
  private resolveFinished!: () => void;
  private readonly whenFinished = new Promise<void>((resolve) => { this.resolveFinished = resolve; });

  constructor(private readonly options: LiveCallControllerOptions) {
    this.ready = Promise.resolve(options.setup);
    // Keys a caller presses while the business is still loading may be a PIN,
    // so a phone call leaves them out of the transcript until it knows.
    this.maskKeypad = options.phone;
    // A failed setup ends the call; the worker reports it.
    this.ready.then((setup) => {
      this.callerDone = setup.callerDone;
      this.maskKeypad = setup.maskKeypad === true;
    }, () => this.endSession());
  }

  start(): void {
    const socket = this.options.connect?.() ?? new SidebandWS(this.options.client, { session_id: this.options.sessionId, graceful_close: true }, { reconnect: { ...ATTACH_RETRY, onReconnecting: (event) => this.retryAttach(event) } });
    this.socket = socket;
    // Events OpenAI sends to sidebands that the SDK's sideband types leave out.
    const untyped = socket as unknown as { on<T>(type: string, listener: (event: T) => void): void };
    socket.on("event", (event) => {
      this.sessionEventSeen = true;
      // An ended session can still answer with an error, so only other events show it's alive.
      if (event.type !== "error" && !this.sessionAlive) {
        this.sessionAlive = true;
        clearTimeout(this.firstEventTimer);
        this.options.onFirstEvent?.();
      }
      this.observeAttach(event as { start_ms?: unknown; offset_ms?: unknown });
    });
    socket.on("session.input_transcript.delta", (event) => {
      this.observeTimeline(event.end_ms);
      this.measure(() => this.latency.callerTranscript(event.start_ms, event.end_ms));
      this.appendTranscript("caller", event.delta, event.end_ms, event.start_ms);
    });
    // OpenAI's guide: transcript events arrive for intervals that contain
    // text, so words in session.output_transcript.delta are the evidence that
    // the receptionist is speaking.
    socket.on("session.output_transcript.delta", (event) => {
      if (event.delta.trim()) this.heardSpeech(event.end_ms);
      this.measure(() => this.latency.receptionistTranscript(event.start_ms, event.end_ms));
      this.appendTranscript("receptionist", event.delta, event.end_ms);
    });
    // OpenAI reflects output audio to the sideband with timeline offsets, but
    // the SDK's sideband event types leave it out. GPT-Live is full duplex, so
    // the events run through silence too: only a loud chunk counts as speech.
    untyped.on<{ delta?: unknown; start_ms?: number; end_ms?: number }>("session.output_audio.delta", (event) => {
      this.outputAudio.deltas += 1;
      if (typeof event.start_ms === "number") {
        this.outputAudio.firstStartMs ??= event.start_ms;
        if (typeof event.end_ms === "number") this.outputAudio.coveredMs += Math.max(0, event.end_ms - event.start_ms);
      }
      if (typeof event.delta === "string") this.outputAudio.payloadBytes += event.delta.length;
      // The events cover silence too, so only a loud chunk counts as speech.
      if (typeof event.delta === "string" && isVoice(event.delta)) this.heardSpeech(event.end_ms);
    });
    // OpenAI's server-controls guide: the sideband also receives the caller's
    // audio as OpenAI received it, with no timeline position. The worker only
    // measures it, to show whether audio reaches GPT-Live while the caller is
    // silent.
    untyped.on<{ audio?: unknown }>("session.input_audio.append", (event) => {
      if (typeof event.audio !== "string") return;
      const chunk = measurePcm(event.audio);
      this.inputAudio.chunks += 1;
      this.inputAudio.samples += chunk.samples;
      this.inputAudio.payloadBytes += event.audio.length;
      if (chunk.voice) this.inputAudio.loudSamples += chunk.samples;
    });
    // A keypad press reaches only the sideband, with no timeline position. It
    // counts as caller input, so the next request's agent sees it, unless it's
    // part of a PIN: then only its check sees it.
    untyped.on<{ event?: unknown }>("transport.dtmf.received", (event) => {
      if (typeof event.event !== "string" || !event.event) return;
      if (this.passcode) {
        this.passcodeKey(this.passcode, event.event);
        return;
      }
      const now = this.timelineNow();
      this.appendTranscript("caller", this.maskKeypad ? " [pressed a key]" : ` [pressed ${event.event}]`, now, now);
    });
    // OpenAI documents these for outbound SIP legs. A REFER makes the carrier
    // dial one, so after a REFER they report whether the destination answered.
    untyped.on("transport.answered", () => this.transferAnswered());
    untyped.on<{ error?: { code?: string; message?: string } }>("transport.failed", (event) => this.transferFailed(event.error?.message || event.error?.code || "transport.failed"));
    socket.on("session.delegation.created", (event) => void this.handleDelegation(event));
    socket.on("session.usage.updated", (event) => { this.latestUsageSeconds = event.usage.seconds; });
    socket.on("session.closed", (event) => this.finish(event.reason ?? undefined, event.usage?.seconds, true));
    socket.on("session.instructions.appended", (event) => this.acknowledge(event.client_event_id));
    socket.on("session.commentary.appended", (event) => this.acknowledge(event.client_event_id));
    socket.on("session.thinking.appended", (event) => this.acknowledge(event.client_event_id));
    // OpenAI's sideband reference: fixture.playing confirms it took the
    // recording, and fixture.played that it finished and GPT-Live listens again.
    untyped.on<{ client_event_id?: string }>("session.output_audio.fixture.playing", (event) => this.recordingPlaying(event.client_event_id));
    untyped.on<{ client_event_id?: string }>("session.output_audio.fixture.played", (event) => this.recordingPlayed(event.client_event_id));
    socket.on("error", (error) => this.handleError(error));
    // The connection ended before session.closed: final usage is unconfirmed.
    socket.on("close", () => this.finish("sideband_closed"));
    // GPT-Live greets from the greeting command in the session's starting
    // history (see session.ts). It ignored that command on about 4 calls in
    // 10 from October 3 to 8, and an appended one about half the time, so the
    // worker sends the command when no voice follows, and again after each
    // one that goes unspoken. The
    // sideband replays the last 3 seconds of events, so an attach within 3
    // seconds still sees session.started; the fallback timer also starts when
    // the connection opens, for a later attach.
    socket.on("session.started", () => {
      if (this.started) return;
      this.started = true;
      this.startedSeenAt = performance.now();
      clearTimeout(this.greetingTimer);
      this.greetingTimer = setTimeout(() => this.sendGreetingFallback(), GREETING_FALLBACK_MS);
      void this.ready.then((setup) => { if (setup.greetingRecording) this.playGreetingRecording(setup.greeting, setup.greetingRecording.audio); }, () => undefined);
      this.options.onStarted?.();
    });
    // A phone call's session starts before the worker attaches, so an attach
    // past the replay window never sees session.started. A browser call's
    // session starts after the attach, so it always does.
    const lateAttach = () => {
      // A retried attach can see session.started before it reports the reconnect.
      if (!this.options.phone || this.started) return;
      clearTimeout(this.greetingTimer);
      this.greetingTimer = setTimeout(() => {
        if (this.started) return;
        this.lateAttach = true;
        this.sendGreetingFallback();
      }, LATE_ATTACH_MS);
    };
    // A re-attach's wait for the first event runs from when the connection
    // opens, so a slow connection isn't taken for a silent session.
    const awaitFirstEvent = () => {
      if (!this.options.firstEventTimeoutMs || this.sessionAlive) return;
      clearTimeout(this.firstEventTimer);
      this.firstEventTimer = setTimeout(() => { if (!this.sessionAlive) this.finish("no_session_events"); }, this.options.firstEventTimeoutMs);
    };
    const opened = () => {
      lateAttach();
      awaitFirstEvent();
    };
    (socket.socket as unknown as { on(type: "open", listener: () => void): void }).on("open", opened);
    // A retried attach opens on a new connection.
    socket.on("reconnected", opened);
    this.resetSilenceTimer();
    this.scheduleDurationLimit();
  }

  // The duration limit's goodbye starts a little before the limit, and a call
  // that can top up asks for more minutes a minute before that.
  private scheduleDurationLimit(): void {
    if (!this.options.maxDurationMs) return;
    const limitMs = this.options.maxDurationMs + this.grantedMs;
    this.durationWrapUpAt = this.startedAt + limitMs - Math.min(DURATION_WRAP_UP_LEAD_MS, limitMs / 2);
    clearTimeout(this.durationTimer);
    clearTimeout(this.topUpTimer);
    this.durationTimer = setTimeout(() => this.options.onTimeout?.("duration_limit"), this.durationWrapUpAt - Date.now());
    if (this.options.topUp) this.topUpTimer = setTimeout(() => void this.askForTopUp(), Math.max(0, this.durationWrapUpAt - TOP_UP_LEAD_MS - Date.now()));
  }

  // A grant moves the goodbye and the next ask. None leaves the goodbye where
  // it is. A failed ask is tried again until the goodbye starts.
  private async askForTopUp(): Promise<void> {
    if (this.ending || this.finished) return;
    let grantedMs: number;
    try {
      grantedMs = await this.options.topUp!();
    } catch (error) {
      const retry = !this.ending && !this.finished && Date.now() + TOP_UP_RETRY_MS < this.durationWrapUpAt;
      logEvent(retry ? "warn" : "error", "live.top_up_failed", { sessionId: this.options.sessionId, retry, error });
      if (retry) this.topUpTimer = setTimeout(() => void this.askForTopUp(), TOP_UP_RETRY_MS);
      // The last try failed, so the call ends at its limit whatever minutes are left.
      else if (!this.ending && !this.finished) void reportError(error, { operation: "live.top_up", sessionId: this.options.sessionId });
      return;
    }
    if (!(grantedMs > 0) || this.ending || this.finished) return;
    this.grantedMs += grantedMs;
    this.scheduleDurationLimit();
  }

  // The sideband replays only the last 3 seconds. Without session.started, a
  // first event this far into the session means the attach missed the start
  // of the conversation.
  private observeAttach(event: { start_ms?: unknown; offset_ms?: unknown }): void {
    if (this.firstEventMs !== undefined) return;
    const position = typeof event.start_ms === "number" ? event.start_ms : event.offset_ms;
    if (typeof position !== "number") return;
    this.firstEventMs = position;
    if (!this.started && position > LATE_ATTACH_MS) this.lateAttach = true;
  }

  // Retries an attach that failed before the session sent anything. After
  // that, a dropped sideband ends the call.
  private retryAttach(event: { attempt: number; maxAttempts: number; closeCode: number }): { abort: true } | undefined {
    if (this.sessionEventSeen) return { abort: true };
    logEvent("warn", "live.attach_retry", { sessionId: this.options.sessionId, closeCode: event.closeCode, attempt: event.attempt, maxAttempts: event.maxAttempts });
    return undefined;
  }

  private send(event: Parameters<SidebandWS["send"]>[0], pending?: PendingAppend): void {
    if (!this.socket || this.finished) return;
    const eventId = (event as { event_id?: string }).event_id;
    if (pending && eventId) this.pendingAppends.set(eventId, pending);
    this.socket.send(event);
  }

  private acknowledge(clientEventId: string | undefined): void {
    if (!clientEventId) return;
    const pending = this.pendingAppends.get(clientEventId);
    this.pendingAppends.delete(clientEventId);
    if (pending?.kind === "greeting") {
      this.reportGreeting("acknowledged");
      this.retryGreetingIfSilent();
    }
    if (pending?.kind === "wrap_up") this.wrapUpAckedAt = performance.now();
  }

  // The caller said something, so a greeting would talk over them.
  private callerSpoke(): boolean {
    return this.turns.some((turn) => turn.role === "caller" && turn.text.trim() !== "");
  }

  // OpenAI's guide: read error events alongside acknowledgments, and use
  // error.client_event_id to find the command that failed.
  private handleError(error: Error): void {
    const failed = (error as { error?: { client_event_id?: string; error?: { client_event_id?: string } } }).error;
    const clientEventId = failed?.client_event_id ?? failed?.error?.client_event_id;
    const pending = clientEventId ? this.pendingAppends.get(clientEventId) : undefined;
    if (clientEventId) this.pendingAppends.delete(clientEventId);
    logEvent("error", "live.sideband_error", { sessionId: this.options.sessionId, clientEventId, error });
    if (!pending) return;
    if (pending.kind === "greeting") {
      this.reportGreeting("failed", undefined, error.message);
      return;
    }
    // GPT-Live won't say the greeting on its own, so the command goes out at once.
    if (pending.kind === "recording") {
      this.reportGreeting("failed", "recording", error.message);
      this.recording = undefined;
      this.sendGreetingFallback();
      return;
    }
    // A rejected answer leaves the caller in silence: send a short failure
    // instead, once. A rejected fallback isn't retried again.
    if (pending.kind === "answer" && pending.delegationId && !clientEventId!.endsWith("_fallback")) {
      this.send({ type: "session.commentary.append", delegation_id: pending.delegationId, content: FAILED_ANSWER, event_id: `${clientEventId}_fallback` }, { kind: "answer", delegationId: pending.delegationId });
    }
  }

  // The receptionist is audibly speaking: in its transcript, or in loud reflected audio.
  private heardSpeech(endMs: number | undefined): void {
    this.greetingDone();
    this.lastSpeechAt = performance.now();
    this.resetSilenceTimer();
    if (typeof endMs === "number") this.lastSpeechEndMs = Math.max(this.lastSpeechEndMs, endMs);
  }

  // The first greeting command, when the greeting from the starting history wasn't heard.
  private sendGreetingFallback(): void {
    if (this.greetingFallbackStarted) return;
    this.greetingFallbackStarted = true;
    this.sendGreeting("fallback");
  }

  // GPT-Live acknowledged a greeting command. If no voice follows, the
  // command is sent again. A rejected or unacknowledged command isn't: the
  // session isn't taking commands, and OpenAI's guide says an acknowledgment
  // stays pending while the session timeline is stopped.
  private retryGreetingIfSilent(): void {
    if (this.greetingSpoken || this.greetingAttempts >= GREETING_COMMANDS) return;
    clearTimeout(this.greetingTimer);
    this.greetingTimer = setTimeout(() => this.sendGreeting("retry"), GREETING_RETRY_MS);
  }

  // Stops once either side has spoken or the call is ending, so a greeting
  // never talks over the caller or a goodbye.
  private sendGreeting(trigger: NonNullable<GreetingEvent["trigger"]>): void {
    const stopped = () => this.greetingSpoken || this.callerSpoke() || this.finished || this.ending || this.greetingAttempts >= GREETING_COMMANDS;
    if (stopped()) return;
    void this.ready.then((setup) => {
      const greeting = setup.greeting?.trim();
      if (!greeting || stopped()) return;
      this.greetingAttempts += 1;
      this.send({ type: "session.instructions.append", delegation_id: null, content: greetingCommand(greeting), event_id: `greeting_${this.greetingAttempts}` }, { kind: "greeting" });
      this.reportGreeting("sent", trigger);
    }, () => undefined);
  }

  // Plays the recording of the greeting; the session's starting history has
  // the greeting as already said. Without a recording, or when OpenAI rejects
  // it or doesn't start it in time, the greeting command goes out instead.
  private playGreetingRecording(greeting: string | undefined, audio: string | undefined): void {
    if (this.greetingSpoken || this.greetingFallbackStarted || this.callerSpoke() || this.finished || this.ending) return;
    clearTimeout(this.greetingTimer);
    const text = greeting?.trim();
    if (!audio || !text) {
      this.sendGreetingFallback();
      return;
    }
    this.recording = { text, ms: recordingMs(audio) };
    const play: AudioFixturePlay = { type: "session.output_audio.fixture.play", audio, event_id: GREETING_RECORDING };
    this.send(play as unknown as Parameters<SidebandWS["send"]>[0], { kind: "recording" });
    this.reportGreeting("sent", "recording");
    this.greetingTimer = setTimeout(() => {
      if (this.pendingAppends.delete(GREETING_RECORDING)) this.sendGreetingFallback();
    }, RECORDING_START_MS);
  }

  // OpenAI took the recording, so the caller hears the greeting now. A
  // recording that starts after the command went out still stops its retries.
  private recordingPlaying(clientEventId: string | undefined): void {
    const recording = this.recording;
    if (clientEventId !== GREETING_RECORDING || !recording || recording.playing) return;
    recording.playing = true;
    this.pendingAppends.delete(GREETING_RECORDING);
    this.reportGreeting("acknowledged", "recording");
    this.greetingDone("recording");
    // GPT-Live writes no transcript for a recording, so its words go into the
    // call's here. Its place on the session timeline is estimated from when
    // the worker saw the session start.
    const startMs = Math.round(performance.now() - (this.startedSeenAt ?? this.attachedAt));
    const endMs = startMs + recording.ms;
    this.measure(() => this.latency.receptionistTranscript(startMs, endMs));
    this.appendTranscript("receptionist", recording.text, endMs);
    this.heardSpeech(endMs);
  }

  // The recording finished, so the silence timer and a goodbye count from here.
  private recordingPlayed(clientEventId: string | undefined): void {
    if (clientEventId !== GREETING_RECORDING || !this.recording?.playing) return;
    this.heardSpeech(undefined);
  }

  /** The receptionist started speaking, so the greeting worked or isn't needed. */
  private greetingDone(trigger?: GreetingEvent["trigger"]): void {
    if (this.greetingSpoken) return;
    this.greetingSpoken = true;
    clearTimeout(this.greetingTimer);
    this.reportGreeting("spoken", trigger);
  }

  private reportGreeting(step: GreetingEvent["step"], trigger?: GreetingEvent["trigger"], error?: string): void {
    try {
      this.options.onGreeting?.({ step, attempt: this.greetingAttempts, ...(trigger ? { trigger } : {}), sinceAttachMs: Math.round(performance.now() - this.attachedAt), inputAudioMs: Math.round(this.inputAudio.samples / SAMPLES_PER_MS), ...(error ? { error } : {}) });
    } catch {
      // Logging must never affect the call.
    }
  }

  // Latency is telemetry: a failure here must never affect the call.
  private measure(record: () => void): void {
    try {
      record();
    } catch {
      // Ignore.
    }
  }

  // The caller's words reach us no earlier than their end on the session
  // timeline, so the smallest gap between arrival and end_ms places the
  // timeline's start. Output audio can be generated ahead of playback, so it
  // doesn't count.
  private observeTimeline(endMs: number | undefined): void {
    if (typeof endMs !== "number") return;
    const origin = performance.now() - endMs;
    this.timelineOrigin = this.timelineOrigin === undefined ? origin : Math.min(this.timelineOrigin, origin);
  }

  /** When the receptionist's speech so far will have finished playing, in performance.now() time. */
  private playbackEndsAt(): number {
    return this.timelineOrigin === undefined ? this.lastSpeechAt : this.timelineOrigin + this.lastSpeechEndMs;
  }

  /** The current position on the session timeline, as well as the worker can tell. */
  private timelineNow(): number {
    return this.timelineOrigin === undefined ? (this.turns.at(-1)?.endMs ?? 0) : Math.round(performance.now() - this.timelineOrigin);
  }

  /**
   * Runs `then` once the receptionist has said what it was just given: no
   * request is running and its speech since then, or since the answer that
   * followed, has played out. It stops waiting when the receptionist stays
   * silent, or after GOODBYE_MAX_MS. OpenAI's guide: close only when playback
   * has finished and no pending work needs the session.
   *
   * With `acknowledgedAt`, speech counts from OpenAI's acknowledgment of the
   * command that asked for it, so words already under way when it was sent
   * aren't taken for the reply. Without an acknowledgment by
   * WRAP_UP_ACK_WAIT_MS, it counts from the request.
   */
  private afterSpeech(then: () => void, acknowledgedAt?: () => number | undefined): void {
    const requestedAt = performance.now();
    const check = () => {
      if (this.finished) return;
      const now = performance.now();
      const acked = acknowledgedAt?.();
      if (acknowledgedAt && acked === undefined && now - requestedAt < WRAP_UP_ACK_WAIT_MS) {
        setTimeout(check, GOODBYE_POLL_MS);
        return;
      }
      const from = acked ?? requestedAt;
      const answered = this.runningDelegations === 0;
      const sentAt = Math.max(from, this.lastAnswerSentAt ?? from);
      const spoke = this.lastSpeechAt >= sentAt;
      const silentTooLong = answered && !spoke && now - sentAt > GOODBYE_START_MS;
      const playedOut = spoke && now - this.lastSpeechAt > GOODBYE_QUIET_MS && now > this.playbackEndsAt();
      if (now - requestedAt > GOODBYE_MAX_MS || silentTooLong || (answered && playedOut)) then();
      else setTimeout(check, GOODBYE_POLL_MS);
    };
    setTimeout(check, GOODBYE_POLL_MS);
  }

  /** Ends the call once the receptionist has said goodbye. Nothing the caller says stops it. */
  endAfterGoodbye(): void {
    if (this.ending || this.finished) return;
    this.ending = true;
    this.afterSpeech(() => this.endSession());
  }

  /**
   * Ends the call once the caller is done: GPT-Live handed the call to the
   * agent, which ended it. The hangup waits until the request is answered,
   * GPT-Live's goodbye after that answer has played (or it stayed silent for
   * GOODBYE_START_MS), and both sides have been quiet for
   * CALLER_DONE_QUIET_MS, or CALLER_DONE_MAX_MS at most. When the caller
   * speaks after that request, even before the agent ended the call, the
   * caller check decides; without one, or when they want more, or on another
   * request, it's cancelled and the call goes on. `onCancelled` runs then, or
   * at once when the call can't end this way.
   */
  endWhenCallerDone(onCancelled?: () => void): void {
    if (this.ending || this.finished || this.pendingHangup) return;
    const answering = this.answering;
    const afterMs = answering?.offsetMs ?? this.timelineNow();
    // GPT-Live can hand the call over mid-sentence, so the caller may already
    // have said more. Those words get the same check as words after the
    // hangup was requested; without a check, the call goes on.
    const callerSpoke = this.lastCallerStartMs > afterMs;
    // A newer request or a transfer means the call isn't over.
    this.hangupCancelled = (answering !== undefined && answering.revision !== this.latestRevision) || this.transfer !== undefined || (callerSpoke && !this.callerDone);
    if (this.hangupCancelled) {
      onCancelled?.();
      return;
    }
    const hangup: PendingHangup = { afterMs, requestedAt: performance.now(), ...(callerSpoke ? { callerSpoke } : {}), ...(onCancelled ? { onCancelled } : {}) };
    this.pendingHangup = hangup;
    setTimeout(() => this.hangUpWhenQuiet(hangup), GOODBYE_POLL_MS);
  }

  private hangUpWhenQuiet(hangup: PendingHangup): void {
    if (this.pendingHangup !== hangup) return;
    // A wrap-up or a non-cancellable end took the call over.
    if (this.ending || this.finished) {
      this.pendingHangup = undefined;
      return;
    }
    if (this.transfer) {
      this.cancelHangup();
      return;
    }
    const now = performance.now();
    if (hangup.callerSpoke) {
      if (!hangup.checking && now - this.lastCallerAt >= CALLER_CHECK_QUIET_MS) this.checkCallerDone(hangup);
      setTimeout(() => this.hangUpWhenQuiet(hangup), GOODBYE_POLL_MS);
      return;
    }
    const quietSince = Math.max(this.playbackEndsAt(), this.lastSpeechAt, this.lastCallerAt);
    // The goodbye follows the result that ended the call, unless GPT-Live stays silent.
    const answeredAt = Math.max(this.lastAnswerSentAt ?? 0, hangup.requestedAt);
    const saidGoodbye = this.lastSpeechAt >= answeredAt || now - answeredAt > GOODBYE_START_MS;
    const done = this.runningDelegations === 0 && saidGoodbye && now - quietSince >= CALLER_DONE_QUIET_MS;
    if (!done && now - Math.max(hangup.requestedAt, this.lastCallerAt) < CALLER_DONE_MAX_MS) {
      setTimeout(() => this.hangUpWhenQuiet(hangup), GOODBYE_POLL_MS);
      return;
    }
    this.pendingHangup = undefined;
    this.ending = true;
    this.endSession();
  }

  // The caller kept the call going, so the pending hangup is off.
  private cancelHangup(): void {
    const hangup = this.pendingHangup;
    if (!hangup) return;
    this.pendingHangup = undefined;
    this.hangupCancelled = true;
    hangup.onCancelled?.();
  }

  // The caller said something. Words after the request that ended the call
  // hold the hangup for a check, or cancel it when there's no check.
  private heardCaller(startMs: number): void {
    this.lastCallerAt = performance.now();
    this.lastCallerStartMs = Math.max(this.lastCallerStartMs, startMs);
    const hangup = this.pendingHangup;
    if (!hangup || startMs <= hangup.afterMs) return;
    if (this.callerDone) hangup.callerSpoke = true;
    else this.cancelHangup();
  }

  // Asks whether the caller's words after the request that ended the call
  // only say goodbye. If so, the hangup goes ahead; otherwise, or when the
  // check fails, the call goes on.
  private checkCallerDone(hangup: PendingHangup): void {
    hangup.checking = true;
    const heard = this.lastCallerStartMs;
    void this.callerDone!(this.conversationText(), this.abort.signal).catch(() => false).then((done) => {
      if (this.pendingHangup !== hangup) return;
      hangup.checking = false;
      // The caller said more while the check ran, so it runs again on their newest words.
      if (this.lastCallerStartMs > heard) return;
      if (!done) {
        this.cancelHangup();
        return;
      }
      hangup.callerSpoke = false;
      hangup.afterMs = heard;
    });
  }

  /**
   * Ends a call that's still going: tells GPT-Live why and asks for a short
   * goodbye, then ends the call once it has played. Resolves once OpenAI has
   * finalized the call or the finalization timeout passed.
   */
  wrapUp(reason: LiveCallWrapUp): Promise<void> {
    if (!this.ending && !this.finished) {
      this.ending = true;
      this.send({ type: "session.instructions.append", delegation_id: null, content: WRAP_UP[reason], event_id: `wrap_up_${reason}` }, { kind: "wrap_up" });
      this.afterSpeech(() => this.endSession(), () => this.wrapUpAckedAt);
    }
    return this.whenFinished;
  }

  /**
   * Takes the next PIN the caller types on the keypad for `check`. The digits
   * stay out of the transcript and the next request, and GPT-Live, which never
   * hears key presses, is told the outcome. Once a PIN is as long as the
   * shortest one, it ends at the pound key or PASSCODE_KEY_GAP_MS after the
   * last key; it also ends at the longest PIN length, and star starts it over.
   * A PIN that didn't match can be typed again. After PASSCODE_IDLE_MS without
   * a key, the keypad stops taking it, and GPT-Live and the next request are
   * told. Returns false once the call is ending.
   */
  collectPasscode(check: KeypadPasscodeCheck): boolean {
    if (this.ending || this.finished) return false;
    clearTimeout(this.passcode?.timer);
    this.passcode = { check, digits: "", checking: false };
    // An earlier check's outcome no longer applies to the next request.
    this.latestPasscode = undefined;
    this.schedulePasscodeEnd(this.passcode);
    return true;
  }

  private passcodeKey(passcode: NonNullable<LiveCallController["passcode"]>, key: string): void {
    this.resetSilenceTimer();
    // Keys pressed while the PIN is being checked don't count.
    if (passcode.checking) return;
    if (key === "*") passcode.digits = "";
    if (key === "#") {
      if (passcode.digits.length >= CONTACT_PASSCODE_MIN_LENGTH) return void this.checkPasscode(passcode);
      // Checking a PIN shorter than the shortest one would only use up one of
      // the caller's tries, so its digits are dropped and the caller is asked
      // to type the whole PIN again.
      if (passcode.digits) {
        passcode.digits = "";
        this.tellPasscodeOutcome(PASSCODE_TOO_SHORT);
      }
    }
    if (/^[0-9]$/.test(key)) {
      passcode.digits += key;
      if (passcode.digits.length >= CONTACT_PASSCODE_MAX_LENGTH) return void this.checkPasscode(passcode);
    }
    this.schedulePasscodeEnd(passcode);
  }

  // A PIN as long as the shortest one is checked after a pause; anything
  // shorter, or nothing at all, stops the keypad taking a PIN after a long one.
  private schedulePasscodeEnd(passcode: NonNullable<LiveCallController["passcode"]>): void {
    clearTimeout(passcode.timer);
    const complete = passcode.digits.length >= CONTACT_PASSCODE_MIN_LENGTH;
    passcode.timer = setTimeout(() => {
      if (this.passcode !== passcode || passcode.checking) return;
      if (complete) void this.checkPasscode(passcode);
      else this.stopPasscode();
    }, complete ? PASSCODE_KEY_GAP_MS : PASSCODE_IDLE_MS);
  }

  // GPT-Live may be waiting quietly for the PIN, so it hears that the keypad
  // stopped taking it, unless the call is ending, being transferred, or
  // waiting to hang up once the caller is done.
  private stopPasscode(): void {
    this.passcode = undefined;
    if (this.ending || this.finished) return;
    this.latestPasscode = fitToAppend(JSON.stringify(PASSCODE_STOPPED_RESULT));
    if (this.transfer || this.pendingHangup) return;
    this.tellPasscodeOutcome(PASSCODE_STOPPED);
  }

  // GPT-Live never hears key presses, so it's told what came of them.
  private tellPasscodeOutcome(content: string): void {
    this.send({ type: "session.instructions.append", delegation_id: null, content, event_id: `passcode_${++this.passcodeNotices}` });
  }

  private async checkPasscode(passcode: NonNullable<LiveCallController["passcode"]>): Promise<void> {
    clearTimeout(passcode.timer);
    passcode.checking = true;
    const digits = passcode.digits;
    passcode.digits = "";
    const now = this.timelineNow();
    this.appendTranscript("caller", " [typed a PIN]", now, now);
    let outcome: KeypadPasscodeOutcome;
    try {
      outcome = await passcode.check(digits);
    } catch (error) {
      logEvent("error", "live.passcode_check_failed", { sessionId: this.options.sessionId, error });
      void reportError(error, { operation: "live.passcode_check", sessionId: this.options.sessionId });
      outcome = { status: "failed", reason: "The PIN couldn't be checked.", result: { ok: false, reason: "The PIN couldn't be checked." } };
    }
    passcode.checking = false;
    // The agent started a new check meanwhile, or the call is ending.
    if (this.passcode !== passcode || this.ending || this.finished) return;
    this.latestPasscode = fitToAppend(JSON.stringify(outcome.result));
    if (outcome.status === "retry") this.schedulePasscodeEnd(passcode);
    else this.passcode = undefined;
    this.tellPasscodeOutcome(passcodeCommand(outcome));
  }

  /** False while a transfer is under way or the call is ending, so the worker reserves no transfer attempt. */
  canTransfer(): boolean {
    return !this.transfer && !this.ending && !this.finished;
  }

  /**
   * Transfers a phone call with a SIP REFER once the receptionist has told the
   * caller, the way endAfterGoodbye waits for the goodbye. Returns false when
   * no transfer starts: one is already under way or the call is ending.
   * onTransfer reports "referring" when the REFER goes out, "referred" when
   * OpenAI accepts it, then "completed" or "failed".
   */
  transferAfterAnnouncement(targetUri: string): boolean {
    if (!this.canTransfer()) return false;
    this.transfer = "announcing";
    this.afterSpeech(() => {
      // The call started ending during the announcement, so it's not transferred.
      if (this.ending || this.finished) {
        this.transfer = undefined;
        return;
      }
      this.transfer = "referring";
      this.options.onTransfer?.("referring");
      this.options.client.live.sessions.refer(this.options.sessionId, { target_uri: targetUri }).then(() => {
        // transport.answered can beat the REFER's own response.
        if (this.transfer !== "referring") return;
        this.transfer = "referred";
        this.options.onTransfer?.("referred");
        this.transferTimer = setTimeout(() => this.transferFailed(`no session.closed or transport outcome ${TRANSFER_OUTCOME_MS / 1000} seconds after the REFER`), TRANSFER_OUTCOME_MS);
      }, (error: unknown) => this.transferFailed(error instanceof Error ? error.message : String(error)));
    });
    return true;
  }

  private transferAnswered(): void {
    if (this.transfer !== "referring" && this.transfer !== "referred") return;
    this.transfer = undefined;
    clearTimeout(this.transferTimer);
    this.options.onTransfer?.("completed");
  }

  // The caller is still with the receptionist, which offers to take a message.
  // Clearing the transfer lets a later one be tried.
  private transferFailed(message: string): void {
    if (this.transfer !== "referring" && this.transfer !== "referred") return;
    this.transfer = undefined;
    clearTimeout(this.transferTimer);
    logEvent("error", "live.transfer_failed", { sessionId: this.options.sessionId, error: message });
    this.send({ type: "session.instructions.append", delegation_id: null, content: TRANSFER_FAILED, event_id: `transfer_failed_${Date.now()}` });
    this.options.onTransfer?.("failed");
  }

  /**
   * Lets go of a call another worker took over: closes the sideband without
   * hanging up. onClose reports the close reason "detached", and the new
   * owner finishes the call and keeps its transcript.
   */
  detach(): void {
    this.finish(DETACHED);
  }

  /**
   * Ends the session: a SIP hangup for phone calls, session.close for browser
   * calls. The sideband stays open until session.closed brings the final usage,
   * or the finalization timeout passes.
   */
  endSession(): void {
    if (this.finished || this.finalizeTimer) return;
    this.finalizeTimer = setTimeout(() => this.finish("finalize_timeout"), FINALIZE_TIMEOUT_MS);
    if (this.options.phone) {
      void this.options.client.live.sessions.hangup(this.options.sessionId).catch(() => this.send({ type: "session.close" }));
    } else {
      this.send({ type: "session.close" });
    }
  }

  private resetSilenceTimer(): void {
    clearTimeout(this.silenceTimer);
    // OpenAI's guide: transcript gaps alone don't establish silence, so a
    // request still being answered counts as activity too. Reflected output
    // audio doesn't: it can cover silence.
    if (!this.options.silenceTimeoutMs || this.finished || this.runningDelegations > 0) return;
    this.silenceTimer = setTimeout(() => this.options.onTimeout?.("silence_timeout"), this.options.silenceTimeoutMs);
  }

  // Report every turn except the one still in progress.
  private emitFinishedTurns(includeLast: boolean): void {
    const ready = includeLast ? this.turns.length : this.turns.length - 1;
    for (; this.emittedTurns < ready; this.emittedTurns += 1) {
      const turn = this.turns[this.emittedTurns]!;
      this.options.onTurn?.({ sequence: this.emittedTurns + 1, speaker: turn.role === "caller" ? "caller" : "assistant", text: turn.text });
    }
  }

  private appendTranscript(role: Turn["role"], delta: string, endMs: number, startMs?: number): void {
    this.resetSilenceTimer();
    const last = this.turns.at(-1);
    if (last?.role === role) {
      last.text += delta;
      last.endMs = endMs;
    } else {
      this.turns.push({ role, text: delta, endMs });
      this.emitFinishedTurns(false);
    }
    if (role !== "caller") return;
    if (delta.trim()) this.heardCaller(startMs ?? endMs);
    this.transcriptWaiters = this.transcriptWaiters.filter((waiter) => {
      if (endMs < waiter.offsetMs) return true;
      waiter.resolve();
      return false;
    });
  }

  private async waitForCallerTranscript(offsetMs: number): Promise<void> {
    const lastCaller = [...this.turns].reverse().find((turn) => turn.role === "caller");
    if (lastCaller && lastCaller.endMs >= offsetMs) return;
    await new Promise<void>((resolve) => {
      const waiter = { offsetMs, resolve };
      this.transcriptWaiters.push(waiter);
      setTimeout(() => {
        this.transcriptWaiters = this.transcriptWaiters.filter((item) => item !== waiter);
        resolve();
      }, TRANSCRIPT_WAIT_MS);
    });
  }

  private conversationText(): string {
    return this.turns.map((turn) => `${turn.role === "caller" ? "Caller" : "Receptionist"}: ${turn.text.trim()}`).join("\n");
  }

  private delegationPrompt(): string {
    // The spoken transcript can lag or omit earlier answers, so list them
    // explicitly; otherwise the agent re-answers requests it already handled.
    const earlier = this.delegations.filter((item) => !item.failed && !item.superseded && !item.endedCall).map((item) => `- ${item.answer}`);
    return [
      `Conversation so far:\n${this.conversationText()}`,
      // The delegation event carries no request text, so a late attach leaves
      // the agent without the caller's first words.
      this.lateAttach ? "The conversation above is missing its start, because the backend joined the call late. If the request needs details that aren't shown, say which ones to ask the caller for instead of guessing them." : "",
      earlier.length ? `Answers already given in this call:\n${earlier.join("\n")}` : "",
      this.completedActions.length ? `Actions already taken in this call, with their results. Don't repeat them; change them if the caller changed their request:\n${this.completedActions.join("\n")}` : "",
      this.latestLookup ? `Latest lookup in this call. Reuse it while it still answers the request:\n${this.latestLookup}` : "",
      this.latestPasscode ? `Keypad PIN check in this call. The caller types the PIN on the keypad, so it isn't in the conversation:\n${this.latestPasscode}` : "",
      this.unheardResults.length ? `Results of earlier requests the caller hasn't heard, because they asked something else first. Include them if they still matter:\n${this.unheardResults.map((result) => `- ${result}`).join("\n")}` : "",
      "The voice model handed you the caller's most recent request. Handle that request; earlier requests are already answered. Return the relevant facts, the request's current status, and the next step.",
    ].filter(Boolean).join("\n\n");
  }

  // Keeps what the next request needs from this one's tool calls.
  private rememberResults(steps: StepLike[]): void {
    for (const step of steps) {
      for (const result of step.toolResults) {
        const output = fitToAppend(JSON.stringify(result.output ?? null));
        if (ANSWER_TOOLS.has(result.toolName)) {
          const previous = this.completedActions.findIndex((line) => line.startsWith(`- ${result.toolName}:`));
          if (previous >= 0) this.completedActions.splice(previous, 1);
        }
        if (ACTION_TOOLS.has(result.toolName) || ANSWER_TOOLS.has(result.toolName)) this.completedActions.push(`- ${result.toolName}: ${output}`);
        if (REUSABLE_LOOKUPS.has(result.toolName)) this.latestLookup = `${result.toolName}: ${output}`;
      }
    }
    this.completedActions.splice(0, Math.max(0, this.completedActions.length - MAX_REMEMBERED_ACTIONS));
  }

  // Quiet progress while the request isn't done. OpenAI's guide: say what
  // finished and whether anything was booked yet, with session.thinking.append.
  private reportProgress(delegationId: string, revision: number, steps: StepLike[], step: StepLike): void {
    if (revision !== this.latestRevision || !step.toolCalls.length) return;
    // A step that only called direct-answer tools is the last one; its result follows at once.
    if (step.toolCalls.every((call) => DIRECT_ANSWER_TOOLS.includes(call.toolName))) return;
    const done = step.toolResults.map((result) => `${PROGRESS[result.toolName] ?? `ran ${result.toolName}`}${succeeded(result.output) ? "" : " (it didn't go through)"}`);
    const changed = steps.some((item) => item.toolResults.some((result) => ACTION_TOOLS.has(result.toolName) && succeeded(result.output)));
    const content = `Progress on the caller's request: ${done.join("; ") || "working on it"}. ${changed ? "" : "Nothing has been booked, changed or saved yet."}`.trim();
    this.send({ type: "session.thinking.append", delegation_id: delegationId, content: fitToAppend(content), event_id: `progress_${delegationId}_${steps.length}` }, { kind: "update", delegationId });
  }

  // The agent's model requests and tool calls nest under the request's span.
  private async handleDelegation(event: DelegationCreatedEvent): Promise<void> {
    await withSpan("live.delegation", { attributes: { "lobbystack.delegation_id": event.delegation.id } }, async (span) => await this.answerDelegation(event, span));
  }

  private async answerDelegation(event: DelegationCreatedEvent, span: Span): Promise<void> {
    const delegationId = event.delegation.id;
    const revision = ++this.latestRevision;
    const receivedAt = performance.now();
    // Another request means the caller isn't done after all.
    this.cancelHangup();
    this.runningDelegations += 1;
    this.resetSilenceTimer();
    const previous = this.delegationQueue;
    let release!: () => void;
    this.delegationQueue = new Promise<void>((resolve) => { release = resolve; });
    try {
      await this.waitForCallerTranscript(event.offset_ms);
      const transcriptReadyAt = performance.now();
      // One request at a time, so an action and a correction to it never race.
      await previous;
      const queueReadyAt = performance.now();
      if (this.finished) return;

      let answer = FAILED_ANSWER;
      let tools: string[] = [];
      let modelSteps = 0;
      let directAnswer = false;
      let failed = false;
      let ended = false;
      let usage: LanguageModelUsage | undefined;
      // Empty when the request fails before the prompt is built.
      let prompt = "";
      const stepMs: number[] = [];
      const steps: StepLike[] = [];
      let toolMs = 0;
      let stepStartedAt = queueReadyAt;
      // A slow answer gets a spoken update, so the caller knows it's still
      // coming. Once the call is ending, the goodbye was the last word.
      const stillWorking = setTimeout(() => {
        if (revision === this.latestRevision && !this.ending && !this.pendingHangup && !endsCall(steps)) this.send({ type: "session.commentary.append", delegation_id: delegationId, content: STILL_WORKING, event_id: `working_${delegationId}` }, { kind: "update", delegationId });
      }, STILL_WORKING_MS);
      const delegationAbort = new AbortController();
      const abortOnCallEnd = () => delegationAbort.abort();
      this.abort.signal.addEventListener("abort", abortOnCallEnd);
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<never>((_resolve, reject) => {
        timeoutTimer = setTimeout(() => {
          delegationAbort.abort();
          reject(new Error(`The request took over ${DELEGATION_TIMEOUT_MS / 1000} seconds.`));
        }, DELEGATION_TIMEOUT_MS);
      });
      try {
        const { agent } = await this.ready;
        // endWhenCallerDone() reads this when the agent ends the call.
        this.answering = { offsetMs: event.offset_ms, revision };
        prompt = this.delegationPrompt();
        const result = await Promise.race([timedOut, agent.generate({
          prompt,
          abortSignal: delegationAbort.signal,
          onStepEnd: (step) => {
            const now = performance.now();
            stepMs.push(Math.round(now - stepStartedAt));
            stepStartedAt = now;
            steps.push(step as unknown as StepLike);
            this.reportProgress(delegationId, revision, steps, step as unknown as StepLike);
          },
          onToolExecutionEnd: (execution) => { toolMs += execution.toolExecutionMs; },
        })]);
        tools = result.steps.flatMap((step) => step.toolCalls.map((call) => call.toolName));
        modelSteps = result.steps.length;
        usage = result.totalUsage;
        ended = endsCall(result.steps as unknown as StepLike[]);
        this.rememberResults(result.steps as unknown as StepLike[]);
        // When the loop stopped on a tool GPT-Live can speak from directly, the
        // last step has no text of its own.
        const direct = directToolAnswer(result.steps.at(-1));
        directAnswer = direct !== undefined;
        const text = direct ?? result.text.trim();
        if (text) answer = fitToAppend(text);
        else failed = true;
      } catch (error) {
        failed = true;
        ended = endsCall(steps);
        if (this.abort.signal.aborted) return;
        logEvent("error", "live.delegation_failed", { sessionId: this.options.sessionId, delegationId, error });
        void reportError(error, { operation: "live.delegation", sessionId: this.options.sessionId, delegationId });
      } finally {
        this.answering = undefined;
        clearTimeout(stillWorking);
        clearTimeout(timeoutTimer);
        this.abort.signal.removeEventListener("abort", abortOnCallEnd);
      }
      const answeredAt = performance.now();

      // OpenAI's guide: when the caller changes a request, ignore results from
      // the outdated one. GPT-Live keeps it as background facts, and the newer
      // request's backend sees it.
      const superseded = revision < this.latestRevision;
      let sent: string;
      if (superseded) {
        if (!failed && !ended) this.unheardResults.push(answer);
        sent = fitToAppend(`The caller made a newer request before this one finished, so this result is background only: ${answer}`);
        this.send({ type: "session.thinking.append", delegation_id: delegationId, content: sent, event_id: `answer_${delegationId}` }, { kind: "update", delegationId });
      } else if (ended && (this.hangupCancelled || this.pendingHangup?.callerSpoke) && !this.ending) {
        // The caller spoke again, so GPT-Live replies to them: a goodbye now could cut them off.
        sent = CALLER_SPOKE_AGAIN;
        this.send({ type: "session.thinking.append", delegation_id: delegationId, content: sent, event_id: `answer_${delegationId}` }, { kind: "update", delegationId });
      } else {
        this.unheardResults = [];
        this.lastAnswerSentAt = performance.now();
        // GPT-Live says its goodbye when it hears the call is ending, and the hangup waits for it.
        sent = ended && failed ? CALL_ENDING : answer;
        this.send({ type: "session.commentary.append", delegation_id: delegationId, content: sent, event_id: `answer_${delegationId}` }, { kind: "answer", delegationId });
      }

      const timing: DelegationTiming = {
        delegationId,
        offsetMs: event.offset_ms,
        transcriptWaitMs: Math.round(transcriptReadyAt - receivedAt),
        queueMs: Math.round(queueReadyAt - transcriptReadyAt),
        agentMs: Math.round(answeredAt - queueReadyAt),
        totalMs: Math.round(answeredAt - receivedAt),
        tools,
        modelSteps,
        directAnswer,
        stepMs,
        toolMs: Math.round(toolMs),
        answer,
        failed,
        superseded,
        endedCall: ended,
        ...(usage ? { usage } : {}),
      };
      this.delegations.push(timing);
      setSpanAttributes(span, {
        "lobbystack.delegation.tools": tools.join(","),
        "lobbystack.delegation.model_steps": modelSteps,
        "lobbystack.delegation.direct_answer": directAnswer,
        "lobbystack.delegation.failed": failed,
        "lobbystack.delegation.superseded": superseded,
        "lobbystack.delegation.ended_call": ended,
        "lobbystack.delegation.transcript_wait_ms": timing.transcriptWaitMs,
        "lobbystack.delegation.queue_ms": timing.queueMs,
        "lobbystack.delegation.agent_ms": timing.agentMs,
        "lobbystack.delegation.tool_ms": timing.toolMs,
        "gen_ai.usage.input_tokens": usage?.inputTokens,
        "gen_ai.usage.output_tokens": usage?.outputTokens,
      });
      this.options.onDelegation?.(timing);
      this.options.onDelegationTrace?.({ delegationId, prompt, steps: toAiTraceSteps(steps as unknown as Parameters<typeof toAiTraceSteps>[0]), sent, directAnswer, failed, superseded, endedCall: ended, agentMs: timing.agentMs, ...(usage ? { usage } : {}) });
    } finally {
      this.runningDelegations -= 1;
      this.resetSilenceTimer();
      release();
    }
  }

  private finish(closeReason?: string, billedSeconds?: number, sessionClosed = false): void {
    if (this.finished) return;
    this.finished = true;
    const detached = closeReason === DETACHED;
    // Without the sideband nobody answers delegations, so end the session
    // rather than leave the caller talking to it while OpenAI keeps billing.
    // A detached call belongs to another worker now, and a re-attach that
    // never heard from the session leaves the decision to its worker.
    const leaveSession = detached || (this.options.firstEventTimeoutMs !== undefined && !this.sessionAlive);
    if (!sessionClosed && !this.finalizeTimer && !leaveSession) this.endWithoutSideband();
    for (const timer of [this.silenceTimer, this.durationTimer, this.topUpTimer, this.greetingTimer, this.finalizeTimer, this.firstEventTimer, this.transferTimer, this.passcode?.timer]) clearTimeout(timer);
    this.passcode = undefined;
    this.abort.abort();
    this.socket?.close({ code: 1000, reason: "session finished" });
    // The new owner saves the transcript from here, under its own numbering.
    if (!detached) this.emitFinishedTurns(true);
    let latency: LiveCallLatency | undefined;
    this.measure(() => { latency = this.latency.summarize(); });
    // OpenAI's guide: without session.closed, keep the latest observed usage
    // and mark it unconfirmed.
    const seconds = sessionClosed ? billedSeconds : this.latestUsageSeconds;
    this.options.onClose?.({
      sessionId: this.options.sessionId,
      durationMs: Date.now() - this.startedAt,
      usageConfirmed: sessionClosed && billedSeconds !== undefined,
      delegations: this.delegations,
      ...(seconds !== undefined ? { billedSeconds: seconds } : {}),
      ...(closeReason ? { closeReason } : {}),
      ...(latency ? { latency } : {}),
      outputAudio: this.outputAudio,
      inputAudio: {
        chunks: this.inputAudio.chunks,
        coveredMs: Math.round(this.inputAudio.samples / SAMPLES_PER_MS),
        loudMs: Math.round(this.inputAudio.loudSamples / SAMPLES_PER_MS),
        payloadBytes: this.inputAudio.payloadBytes,
      },
      lateAttach: this.lateAttach,
      ...(this.firstEventMs !== undefined ? { firstEventMs: this.firstEventMs } : {}),
    });
    this.resolveFinished();
  }

  // The sideband is gone. A phone call still has OpenAI's SIP hangup; a
  // browser call is closed over a fresh sideband connection.
  private endWithoutSideband(): void {
    if (this.options.phone) {
      void this.options.client.live.sessions.hangup(this.options.sessionId).catch(() => undefined);
      return;
    }
    void closeLiveSession(this.options.client, this.options.sessionId);
  }
}

/**
 * Closes a session from the server with session.close over its own sideband
 * connection, then waits for session.closed. Used for browser sessions, which
 * OpenAI's SIP hangup doesn't cover.
 */
export async function closeLiveSession(client: OpenAI, sessionId: string, timeoutMs = 5_000): Promise<void> {
  await new Promise<void>((resolve) => {
    let socket: SidebandWS | undefined;
    const done = () => {
      clearTimeout(timer);
      try {
        socket?.close({ code: 1000, reason: "session closed" });
      } catch {
        // Already closed.
      }
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    try {
      socket = new SidebandWS(client, { session_id: sessionId, graceful_close: true });
      socket.on("session.closed", done);
      socket.on("close", done);
      socket.on("error", () => undefined);
      socket.send({ type: "session.close" });
    } catch {
      done();
    }
  });
}
