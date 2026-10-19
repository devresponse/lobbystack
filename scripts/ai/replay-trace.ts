// Replays one AI debug trace (ADR 0009) offline, to see whether a change to the
// model, the instructions or a tool's result changes what the receptionist says.
//
//   pnpm lobbystack calls trace <trace_id> --json > trace.json
//   OPENAI_API_KEY=... pnpm ai:replay trace.json [--instructions <file>] [--runs <n>]
//
// It gives the model the trace's recorded instructions and input, and answers
// each tool call with the result the trace recorded for that tool, in order, so
// no database is needed. A tool the original turn didn't call answers that it
// isn't available. Pass --instructions to try edited instructions.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { createAgentModel, createReceptionistTools, createTraceReplayAgent, liveDelegationEnvironment, toAiTraceSteps } from "@lobbystack/agent-core";
import type { ApiAiTraceDetail, BusinessContextSnapshot } from "@lobbystack/shared";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    instructions: { type: "string" },
    runs: { type: "string", default: "1" },
  },
});
const [file] = positionals;
if (!file) throw new Error("Usage: pnpm ai:replay <trace.json> [--instructions <file>] [--runs <n>]");
const parsed = JSON.parse(readFileSync(file, "utf8")) as { data?: ApiAiTraceDetail } & Partial<ApiAiTraceDetail>;
const trace = (parsed.data ?? parsed) as ApiAiTraceDetail;
if (trace.kind === "voice_session") throw new Error("A voice_session trace holds the call's opening instructions only. Replay a voice_delegation or chat_reply trace.");
if (!trace.input) throw new Error("The trace has no input to replay.");
if (!trace.snapshot) throw new Error("The trace has no snapshot: it may have expired.");
const instructions = values.instructions ? readFileSync(values.instructions, "utf8") : trace.instructions;
if (!instructions) throw new Error("The trace has no instructions. Pass --instructions <file>.");
const snapshot = JSON.parse(trace.snapshot) as BusinessContextSnapshot;
const channel = trace.channel === "voice" || trace.channel === "web_voice" ? trace.channel : "web_chat";
const model = createAgentModel(channel === "web_chat" ? process.env : liveDelegationEnvironment());
if (!model) throw new Error("No model: set OPENAI_API_KEY or the AI_CHAT_* variables.");

/** The receptionist's tools, each answering with what the trace recorded for it, in order. */
function recordedTools(): ReturnType<typeof createReceptionistTools> {
  const recorded = new Map<string, unknown[]>();
  for (const step of trace.steps) for (const result of step.tool_results) recorded.set(result.tool, [...(recorded.get(result.tool) ?? []), result.output]);
  const tools = createReceptionistTools({ domain: { db: {} as never }, snapshot, channel });
  return Object.fromEntries(Object.entries(tools).map(([name, definition]) => [name, {
    ...definition,
    execute: async () => recorded.get(name)?.shift() ?? { ok: false, reason: "This tool isn't available in the replay: the original turn didn't call it." },
  }])) as ReturnType<typeof createReceptionistTools>;
}

console.log(`Trace ${trace.id} (${trace.kind}, ${trace.channel}, ${trace.created_at})`);
console.log(`Recorded tools: ${trace.tools.join(", ") || "none"}`);
console.log(`Recorded output:\n${trace.output ?? "(none)"}\n`);
for (let run = 1; run <= Number(values.runs); run += 1) {
  const agent = createTraceReplayAgent({ model, instructions, tools: recordedTools() });
  const result = await agent.generate({ prompt: trace.input });
  const steps = toAiTraceSteps(result.steps);
  console.log(`Run ${run}: tools ${steps.flatMap((step) => step.toolCalls.map((call) => call.toolName)).join(", ") || "none"}`);
  console.log(`${result.text.trim() || "(no text: the run ended on a tool result)"}\n`);
}
