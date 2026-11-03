import { demoSnapshot, type BusinessContextSnapshot } from "@lobbystack/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lobbystack/domain", async () => ({
  countKnowledgeTokens: (await import("../../domain/src/knowledgeRanking")).countKnowledgeTokens,
  KNOWLEDGE_SEARCH_TOKEN_BUDGET: 3000,
  knowledgeQueryTerms: (await import("../../domain/src/knowledgeRanking")).knowledgeQueryTerms,
  searchKnowledgeEvidence: vi.fn(async () => ({ matches: [], mode: "hybrid", outcome: "empty", durationMs: 1 })),
  recordUnansweredQuestion: vi.fn(async () => null),
  takeMessageForStaff: vi.fn(async () => ({ ok: true, inboxItemId: "inbox_1" })),
  requestCancellationForCaller: vi.fn(async () => ({ ok: true, inboxItemId: "inbox_2" })),
}));

import { recordUnansweredQuestion, requestCancellationForCaller, searchKnowledgeEvidence, takeMessageForStaff } from "@lobbystack/domain";
import { createReceptionistTools, type AgentChannel } from "./tools";

type Execute = (input: object, options: object) => Promise<unknown>;

const kitsilanoId = "00000000-0000-4000-8000-0000000000a2";
// The view snapshotForReceptionist cuts for the Kitsilano store's receptionist.
const kitsilano: BusinessContextSnapshot = { ...demoSnapshot, receptionist: { id: kitsilanoId, name: "Kitsilano", description: "The Kitsilano store.", isDefault: false } };

function run(snapshot: BusinessContextSnapshot, name: string, input: object, channel: AgentChannel = "web_chat") {
  const tools = createReceptionistTools({ domain: { db: {} as never }, channel, conversationId: "chat_1", snapshot: { ...snapshot, bookingMode: "request" } });
  return (tools[name]!.execute! as Execute)(input, { toolCallId: "1", messages: [] });
}

// The save after noteUnansweredQuestion runs in the background; let it start.
const saved = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => { vi.clearAllMocks(); });

// Each record names the receptionist that answered, and a search reads only
// the articles it may use. The tools get the receptionist from the snapshot,
// which is cut to the view of the one answering.
describe("the receptionist answering", () => {
  it("searches the receptionist's own articles", async () => {
    await run(kitsilano, "searchKnowledge", { query: "Do you sell gift cards?" });
    expect(vi.mocked(searchKnowledgeEvidence).mock.lastCall?.[1]).toEqual({ businessId: demoSnapshot.businessId, query: "Do you sell gift cards?", limit: 6, receptionistId: kitsilanoId });
  });

  it("names the receptionist on a question it couldn't answer", async () => {
    await run(kitsilano, "noteUnansweredQuestion", { question: "Do you sell gift cards?" });
    await saved();
    expect(vi.mocked(recordUnansweredQuestion).mock.lastCall?.[1]).toEqual({ businessId: demoSnapshot.businessId, question: "Do you sell gift cards?", channel: "web_chat", conversationId: "chat_1", receptionistId: kitsilanoId });
  });

  it("names the receptionist on a message and an appointment request for the team", async () => {
    await run(kitsilano, "takeMessage", { message: "Call me about my order.", callerName: "Milan", callbackPhone: "+14165550100" });
    expect(vi.mocked(takeMessageForStaff).mock.lastCall?.[1]).toMatchObject({ message: "Call me about my order.", conversationId: "chat_1", receptionistId: kitsilanoId });
    await run(kitsilano, "requestAppointment", { serviceName: "General Checkup", preferredTime: "Tuesday morning", callerName: "Milan", callbackPhone: "+14165550100" });
    expect(vi.mocked(takeMessageForStaff).mock.lastCall?.[1]).toMatchObject({ message: expect.stringContaining("Appointment request: General Checkup"), receptionistId: kitsilanoId });
  });

  it("names the receptionist on a cancellation request", async () => {
    await run(kitsilano, "requestAppointmentCancellation", { callerName: "Milan", callbackPhone: "+14165550100" });
    expect(vi.mocked(requestCancellationForCaller).mock.lastCall?.[1]).toMatchObject({ callerName: "Milan", receptionistId: kitsilanoId });
  });

  // The database fills in the default receptionist.
  it("names none on a snapshot from before receptionists", async () => {
    await run(demoSnapshot, "searchKnowledge", { query: "Do you sell gift cards?" });
    await run(demoSnapshot, "noteUnansweredQuestion", { question: "Do you sell gift cards?" });
    await saved();
    await run(demoSnapshot, "takeMessage", { message: "Call me.", callerName: "Milan", callbackPhone: "+14165550100" });
    await run(demoSnapshot, "requestAppointment", { serviceName: "General Checkup", preferredTime: "Tuesday", callerName: "Milan", callbackPhone: "+14165550100" });
    await run(demoSnapshot, "requestAppointmentCancellation", { callerName: "Milan", callbackPhone: "+14165550100" });
    for (const call of [
      ...vi.mocked(searchKnowledgeEvidence).mock.calls,
      ...vi.mocked(recordUnansweredQuestion).mock.calls,
      ...vi.mocked(takeMessageForStaff).mock.calls,
      ...vi.mocked(requestCancellationForCaller).mock.calls,
    ]) expect(call[1]).not.toHaveProperty("receptionistId");
    expect(vi.mocked(takeMessageForStaff)).toHaveBeenCalledTimes(2);
  });
});
