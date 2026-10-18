import type { BusinessContextSnapshot } from "@lobbystack/shared";
import { DateTime } from "luxon";
import type { MediaSessionConfig } from "openai/resources/live/live";
import type { SessionAcceptParams } from "openai/resources/live/sessions";

import { buildLiveInstructions } from "../instructions";
import { greetingCommand } from "./greeting";

export const LIVE_MODEL = "gpt-live-1";
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
function openingHistory(snapshot: BusinessContextSnapshot, greetingRecorded: boolean): Pick<MediaSessionConfig, "input"> {
  const greeting = snapshot.greeting?.trim();
  if (!greeting) return {};
  if (greetingRecorded) return { input: [{ role: "assistant", content: [{ type: "output_text", text: greeting }] }] };
  return { input: [{ role: "developer", content: [{ type: "input_text", text: greetingCommand(greeting) }] }] };
}

// Browser calls: the website widget, dashboard test calls and demos. They
// can't be transferred, so GPT-Live hears it's on a browser call.
// `greetingRecorded`: the worker plays a recording of the greeting, in this
// voice, as the call connects.
export function buildBrowserSessionConfig(snapshot: BusinessContextSnapshot, options: { greetingRecorded?: boolean } = {}): MediaSessionConfig {
  return {
    model: LIVE_MODEL,
    instructions: buildLiveInstructions(snapshot, DateTime.now(), "web_voice"),
    ...openingHistory(snapshot, options.greetingRecorded === true),
    audio: { output: { voice: LIVE_VOICE } },
    delegation: { type: "client" },
    client: { data_channel: { allowed_client_events: ["session.close"], allowed_server_events: BROWSER_SERVER_EVENTS } },
    // Keep OpenAI's recording so the worker can copy it into our storage.
    store: true,
  };
}

export function buildPhoneSessionConfig(snapshot: BusinessContextSnapshot, voice = LIVE_VOICE): SessionAcceptParams.Session {
  return {
    type: "live",
    model: LIVE_MODEL,
    instructions: buildLiveInstructions(snapshot, DateTime.now(), "voice"),
    ...openingHistory(snapshot, false),
    audio: { output: { voice } },
    delegation: { type: "client" },
    // Keep OpenAI's recording so the worker can copy it into our storage.
    store: true,
  };
}
