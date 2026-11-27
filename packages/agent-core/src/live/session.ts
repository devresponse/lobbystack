import { callOpening, liveModelSetting, type BusinessContextSnapshot, type LiveModel } from "@lobbystack/shared";
import { DateTime } from "luxon";
import type { MediaSessionConfig } from "openai/resources/live/live";
import type { SessionAcceptParams } from "openai/resources/live/sessions";

import { buildLiveInstructions } from "../instructions";
import { greetingCommand } from "./greeting";

/**
 * The GPT-Live model calls run on: `LIVE_MODEL`, `gpt-live-1.1` unless it
 * names `gpt-live-1`. Read as the service starts, which refuses any other name.
 */
export const LIVE_MODEL: LiveModel = liveModelSetting(process.env);
/** The voice GPT-Live speaks with, and the greeting recording is rendered in. */
export const LIVE_VOICE = "marin";

// Events the browser may see. It can watch the conversation and end it, but it
// can't inject instructions or answer delegations: only our sideband does that.
const BROWSER_SERVER_EVENTS = [
  "session.started",
  "session.closed",
  "session.input_transcript.delta",
  "session.output_transcript.delta",
  "session.delegation.created",
  "session.commentary.appended",
  "error",
].map((type) => ({ type }));

// OpenAI's guide: put context the model needs from the start in input. The
// greeting command goes there, so GPT-Live opens the call on its own. When a
// recording of the greeting opens the call instead (greetingRecording.ts),
// the greeting is there as already said, so GPT-Live listens for the caller.
// The greeting is the call's opening: the business greeting, then the notice
// that the call is with an AI and recorded, unless the business turned it off.
function openingHistory(snapshot: BusinessContextSnapshot, greetingRecorded: boolean): Pick<MediaSessionConfig, "input"> {
  const greeting = callOpening(snapshot);
  if (!greeting) return {};
  if (greetingRecorded) return { input: [{ role: "assistant", content: [{ type: "output_text", text: greeting }] }] };
  return { input: [{ role: "developer", content: [{ type: "input_text", text: greetingCommand(greeting) }] }] };
}

// Browser calls: the website widget, dashboard test calls and demos. They
// can't be transferred, so GPT-Live hears it's on a browser call.
// `greetingRecorded`: the worker plays a recording of the greeting, in this
// voice, as the call connects. `model`: another model than LIVE_MODEL, as for
// the fallback when OpenAI refuses it, or the voice eval's `--model`.
export function buildBrowserSessionConfig(snapshot: BusinessContextSnapshot, options: { greetingRecorded?: boolean; model?: LiveModel } = {}): MediaSessionConfig {
  return {
    model: options.model ?? LIVE_MODEL,
    instructions: buildLiveInstructions(snapshot, DateTime.now(), "web_voice"),
    ...openingHistory(snapshot, options.greetingRecorded === true),
    audio: { output: { voice: LIVE_VOICE } },
    delegation: { type: "client" },
    client: { data_channel: { allowed_client_events: ["session.close"], allowed_server_events: BROWSER_SERVER_EVENTS } },
    // Keep OpenAI's recording so the worker can copy it into our storage.
    store: true,
  };
}

// Phone calls. `greetingRecorded`: the worker plays a recording of the
// greeting, in this voice, as soon as its sideband opens. `model`: as for
// browser calls.
export function buildPhoneSessionConfig(snapshot: BusinessContextSnapshot, options: { greetingRecorded?: boolean; voice?: string; model?: LiveModel } = {}): SessionAcceptParams.Session {
  return {
    type: "live",
    model: options.model ?? LIVE_MODEL,
    instructions: buildLiveInstructions(snapshot, DateTime.now(), "voice"),
    ...openingHistory(snapshot, options.greetingRecorded === true),
    audio: { output: { voice: options.voice ?? LIVE_VOICE } },
    delegation: { type: "client" },
    // Keep OpenAI's recording so the worker can copy it into our storage.
    store: true,
  };
}
