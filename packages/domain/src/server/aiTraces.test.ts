import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ transaction: vi.fn(), plan: vi.fn(async () => "starter") }));
vi.mock("@lobbystack/db", async (original) => ({ ...(await original<typeof import("@lobbystack/db")>()), withBusinessTransaction: mocks.transaction }));
vi.mock("./contentRetentionPolicy", async (original) => ({ ...(await original<typeof import("./contentRetentionPolicy")>()), resolveBusinessBillingPlan: mocks.plan }));

import { aiTraceContexts, aiTraces } from "@lobbystack/db";
import type { BusinessContextSnapshot } from "@lobbystack/shared";

import { AI_TRACE_VALUE_LIMIT, boundAiTraceSteps, recordAiTrace } from "./aiTraces";

const now = new Date("2030-01-01T00:00:00Z");
type Values = Record<string, unknown>;
let enabled: boolean;
let inserts: Array<{ table: unknown; values: Values; conflict?: Values }>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.stubEnv("CONTENT_RETENTION_POLICY_JSON", "");
  enabled = true;
  inserts = [];
  const tx = {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ enabled }] }) }) }),
    insert: (table: unknown) => ({ values: (values: Values) => {
      const entry: { table: unknown; values: Values; conflict?: Values } = { table, values };
      inserts.push(entry);
      const chain = {
        onConflictDoUpdate: ({ set }: { set: Values }) => { entry.conflict = set; return chain; },
        returning: async () => [{ id: table === aiTraces ? "trace" : `context-${inserts.length}` }],
      };
      return chain;
    } }),
  };
  mocks.transaction.mockImplementation(async (_db, _scope, run) => run(tx));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const context = { db: {} as never };
const snapshot = { businessId: "business", version: "v3" } as BusinessContextSnapshot;

describe("AI debug traces", () => {
  it("saves nothing while the business has traces off", async () => {
    enabled = false;
    expect(await recordAiTrace(context, { businessId: "business", kind: "chat_reply", channel: "web_chat", input: "Visitor: hi" })).toBeNull();
    expect(inserts).toHaveLength(0);
  });

  it("saves the turn with its snapshot and instructions stored once, expiring with the ai_traces retention", async () => {
    const id = await recordAiTrace(context, {
      businessId: "business", kind: "voice_delegation", channel: "voice", callId: "call", delegationId: "del_1", model: "gpt-6-luna",
      snapshot, instructions: "Answer calls.", input: "Conversation so far", output: "Facts: open 9 to 5.",
      steps: [{ toolCalls: [{ toolName: "searchKnowledge", input: { query: "hours" } }], toolResults: [{ toolName: "searchKnowledge", output: { outcome: "found" } }] }],
      directAnswer: true, usage: { inputTokens: 10, outputTokens: 2 }, durationMs: 812.4,
    });
    expect(id).toBe("trace");
    const contexts = inserts.filter((entry) => entry.table === aiTraceContexts);
    expect(contexts.map((entry) => entry.values.kind)).toEqual(["snapshot", "instructions"]);
    expect(contexts[0]!.values).toMatchObject({ businessId: "business", content: JSON.stringify(snapshot), hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    // Reused text keeps the later of the two expiries.
    expect(contexts[0]!.conflict).toHaveProperty("expiresAt");
    const trace = inserts.find((entry) => entry.table === aiTraces)!.values;
    expect(trace).toMatchObject({
      kind: "voice_delegation", channel: "voice", callId: "call", delegationId: "del_1", snapshotVersion: "v3",
      snapshotContextId: "context-1", instructionsContextId: "context-2", input: "Conversation so far", output: "Facts: open 9 to 5.",
      directAnswer: true, failed: false, usage: { inputTokens: 10, outputTokens: 2 }, durationMs: 812,
      expiresAt: new Date("2030-01-31T00:00:00Z"),
    });
  });

  it("cuts long tool values instead of storing them whole", () => {
    const [step] = boundAiTraceSteps([{ toolCalls: [], toolResults: [{ toolName: "searchKnowledge", output: { text: "x".repeat(AI_TRACE_VALUE_LIMIT * 2) } }] }]);
    const output = step!.toolResults[0]!.output;
    expect(typeof output).toBe("string");
    expect((output as string).length).toBeLessThan(AI_TRACE_VALUE_LIMIT + 100);
    expect(output).toContain("[cut,");
  });
});
