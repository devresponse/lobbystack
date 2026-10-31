import { stepCountIs, ToolLoopAgent, type LanguageModel, type StopCondition, type StreamTextOnErrorCallback, type ToolExecutionOptions, type ToolSet } from "ai";

import type { AiTraceStep } from "@lobbystack/domain";
import { reportError, withOpenSpan } from "@lobbystack/telemetry/node";

import { buildAgentInstructions } from "./instructions";
import { directToolAnswer } from "./live/directAnswer";
import { createReceptionistTools, offersLiveChat, type AgentToolContext } from "./tools";

export type ReceptionistAgent = ToolLoopAgent<never, ToolSet>;

/**
 * What a streamed reply takes. ToolLoopAgent passes the options it doesn't
 * use itself on to streamText, onError among them. A failed request to the
 * model only reaches onError: the text just stops. Without one, the SDK
 * prints the error as a block of lines that names no business or chat.
 */
export type ReceptionistStreamOptions = Parameters<ReceptionistAgent["stream"]>[0] & { onError: StreamTextOnErrorCallback };

/**
 * Website chat's cap on each model step's output, so no reply runs long even
 * when a visitor talks the model past its instructions. OpenAI counts
 * reasoning tokens toward it, so it leaves room for high reasoning; the
 * instructions keep the visible reply to about 100 words.
 */
export const WEB_CHAT_MAX_OUTPUT_TOKENS = 4_000;

/**
 * Runs each tool call in its own span, so the database work and provider
 * requests it makes nest under it, inside the call or chat request that asked
 * for it. A tool that throws is reported: the model only sees the failure.
 */
export function withToolSpans(tools: ToolSet): ToolSet {
  return Object.fromEntries(Object.entries(tools).map(([name, definition]) => {
    const execute = definition.execute as ((input: unknown, options: ToolExecutionOptions<unknown>) => unknown) | undefined;
    if (!execute) return [name, definition];
    const traced = async (input: unknown, options: ToolExecutionOptions<unknown>) => await withOpenSpan(`tool.${name}`, { attributes: { "gen_ai.tool.name": name } }, async (span) => {
      try {
        const output = await execute(input, options);
        const ok = (output as { ok?: unknown } | null | undefined)?.ok;
        if (typeof ok === "boolean") span.setAttribute("lobbystack.tool.ok", ok);
        return output;
      } catch (error) {
        // A call that ended aborts its tools, which is no failure.
        if (!options.abortSignal?.aborted) void reportError(error, { operation: `tool.${name}` });
        throw error;
      } finally {
        span.end();
      }
    });
    return [name, { ...definition, execute: traced }];
  })) as ToolSet;
}

/** The instructions createReceptionistAgent gives its model, so an AI debug trace can keep them. */
export function receptionistInstructions(input: { context: AgentToolContext; extraInstructions?: string | undefined }): string {
  return [buildAgentInstructions(input.context.snapshot, input.context.channel, { intakeOnly: input.context.intakeOnly ?? false, endsCalls: input.context.callControl !== undefined, keypad: input.context.callControl?.collectPasscode !== undefined, liveChat: offersLiveChat(input.context), ...(input.context.callerPhone ? { callerPhone: input.context.callerPhone } : {}) }), input.extraInstructions].filter(Boolean).join("\n\n");
}

type StepWithTools = { text?: string; toolCalls: ReadonlyArray<{ toolName: string; input?: unknown }>; toolResults: ReadonlyArray<{ toolName: string; output?: unknown }> };

/** The agent's steps as an AI debug trace keeps them (ADR 0009): text, tool calls and tool results. */
export function toAiTraceSteps(steps: ReadonlyArray<StepWithTools>): AiTraceStep[] {
  return steps.map((step) => ({
    ...(step.text?.trim() ? { text: step.text } : {}),
    toolCalls: step.toolCalls.map((call) => ({ toolName: call.toolName, input: call.input })),
    toolResults: step.toolResults.map((result) => ({ toolName: result.toolName, output: result.output })),
  }));
}

/**
 * An agent with given instructions and tools, for replaying an AI debug trace
 * offline (scripts/ai/replay-trace.ts) with the tool results the trace recorded.
 */
export function createTraceReplayAgent(input: { model: LanguageModel; instructions: string; tools: ToolSet }): ReceptionistAgent {
  return new ToolLoopAgent({ model: input.model, instructions: input.instructions, tools: input.tools, stopWhen: stepCountIs(4) });
}

export function createReceptionistAgent(input: {
  model: LanguageModel;
  context: AgentToolContext;
  extraInstructions?: string;
  /**
   * Live calls only: stop as soon as a step's tool results can be spoken as
   * they are (see live/directAnswer.ts). GPT-Live phrases them, so the agent
   * skips the model step that would only reword them.
   */
  directToolAnswers?: boolean;
}): ReceptionistAgent {
  // One lookup, maybe a second, then the answer. Voice callers are waiting. A
  // website chat gets one more step to save a question it couldn't answer.
  const stopWhen: Array<StopCondition<ToolSet>> = [stepCountIs(input.context.channel === "web_chat" ? 5 : 4)];
  if (input.directToolAnswers) stopWhen.push(({ steps }) => directToolAnswer(steps.at(-1)) !== undefined);
  return new ToolLoopAgent({
    model: input.model,
    instructions: receptionistInstructions(input),
    tools: withToolSpans(createReceptionistTools(input.context)),
    stopWhen,
    ...(input.context.channel === "web_chat" ? { maxOutputTokens: WEB_CHAT_MAX_OUTPUT_TOKENS } : {}),
  });
}
