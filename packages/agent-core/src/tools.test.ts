import { demoSnapshot, type BookingMode, type BusinessContextSnapshot, type KnowledgeSnippet } from "@lobbystack/shared";
import { DateTime } from "luxon";
import { describe, expect, it, vi } from "vitest";

vi.mock("@lobbystack/domain", async () => ({
  countKnowledgeTokens: (await import("../../domain/src/knowledgeRanking")).countKnowledgeTokens,
  KNOWLEDGE_SEARCH_TOKEN_BUDGET: 3000,
  knowledgeQueryTerms: (await import("../../domain/src/knowledgeRanking")).knowledgeQueryTerms,
  searchKnowledgeEvidence: vi.fn(),
  recordUnansweredQuestion: vi.fn(async () => null),
  checkOpening: vi.fn(async () => ({ ok: true, available: true })),
  findCallerBooking: vi.fn(async () => undefined),
  findCallBooking: vi.fn(async () => undefined),
  bookForCaller: vi.fn(async () => ({ ok: true })),
  requestCancellationForCaller: vi.fn(async () => ({ ok: true, inboxItemId: "inbox_1" })),
}));

import { bookForCaller, checkOpening, findCallBooking, findCallerBooking, recordUnansweredQuestion, requestCancellationForCaller, searchKnowledgeEvidence } from "@lobbystack/domain";
import { createReceptionistTools, type AgentChannel, type AgentToolContext } from "./tools";

function toolNames(overrides: Omit<Partial<AgentToolContext>, "snapshot"> & { bookingMode?: BookingMode; snapshot?: Partial<BusinessContextSnapshot> } = {}): string[] {
  const { bookingMode, snapshot, ...context } = overrides;
  return Object.keys(createReceptionistTools({
    domain: { db: {} as never },
    channel: "web_chat",
    ...context,
    snapshot: { ...demoSnapshot, ...snapshot, ...(bookingMode ? { bookingMode } : {}) },
  })).sort();
}

const callControl = { transfer: vi.fn(async () => true), hangup: vi.fn(async () => undefined) };

// The booking fixtures use early October 2026: keep those times in the future.
vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));

describe("createReceptionistTools", () => {
  it("books directly by default", () => {
    expect(toolNames()).toEqual(["bookAppointment", "findAvailability", "getBusinessHours", "getBusinessServices", "noteUnansweredQuestion", "requestAppointmentCancellation", "searchKnowledge", "takeMessage"]);
  });

  it("takes requests instead of booking in request mode", () => {
    const names = toolNames({ bookingMode: "request" });
    expect(names).toContain("requestAppointment");
    expect(names).not.toContain("bookAppointment");
    expect(names).not.toContain("findAvailability");
  });

  it("offers no booking actions when booking is off", () => {
    const names = toolNames({ bookingMode: "off", channel: "voice", callerPhone: "+14165550100" });
    expect(names).toEqual(["getBusinessHours", "getBusinessServices", "searchKnowledge", "takeMessage"]);
  });

  it("offers appointment changes only when the call carries the caller's number", () => {
    expect(toolNames({ channel: "web_voice" })).not.toContain("cancelAppointment");
    expect(toolNames({ channel: "voice", callerPhone: "+14165550100" })).toEqual(expect.arrayContaining(["lookupAppointmentForChange", "verifyAppointmentForChange", "cancelAppointment", "rescheduleAppointment"]));
  });

  it("offers transfer and hang-up only on calls it can control", () => {
    expect(toolNames({ channel: "web_voice" })).not.toContain("transferCall");
    expect(toolNames({ channel: "voice", callControl })).toEqual(expect.arrayContaining(["transferCall", "endCall"]));
  });

  it("limits prospect demos to answering questions and taking messages", () => {
    expect(toolNames({ channel: "web_voice", intakeOnly: true, callControl })).toEqual(["endCall", "getBusinessHours", "getBusinessServices", "searchKnowledge", "takeMessage"]);
  });

  it("offers hang-up but not transfer on browser calls", () => {
    const names = toolNames({ channel: "web_voice", callControl: { hangup: vi.fn() } });
    expect(names).toContain("endCall");
    expect(names).not.toContain("transferCall");
  });

  // GPT-Live said goodbye before it handed the call over, so a reply would be a second one.
  it("tells the agent a caller who is done gets no reply", () => {
    const endCall = createReceptionistTools({ domain: { db: {} as never }, channel: "voice", snapshot: demoSnapshot, callControl: { hangup: vi.fn() } }).endCall!;
    expect(endCall.description).toBe("End the call. Use the reason caller_finished when the caller is done or is saying goodbye: the voice model says goodbye when it hears the call is ending, so don't write a reply. Use spam or abuse for a spam or abusive call.");
  });

  it("refuses a transfer the rules don't allow", async () => {
    const tools = createReceptionistTools({
      domain: { db: {} as never },
      channel: "voice",
      callControl,
      snapshot: { ...demoSnapshot, transferPolicy: { mode: "on_request", transferNumber: "+14165550199" } },
    });
    const execute = tools.transferCall!.execute! as (input: object, options: object) => Promise<unknown>;
    await expect(execute({ callerRequested: false, urgent: false }, { toolCallId: "1", messages: [] })).resolves.toMatchObject({ ok: false });
    expect(callControl.transfer).not.toHaveBeenCalled();
    await expect(execute({ callerRequested: true, urgent: false }, { toolCallId: "2", messages: [] })).resolves.toMatchObject({ ok: true });
    expect(callControl.transfer).toHaveBeenCalledWith("+14165550199");
  });
});

describe("requestAppointmentCancellation", () => {
  const operatorOnly = { appointmentChangePolicy: { enabled: true, allowCancel: true, allowReschedule: true, verificationMode: "operator_only" as const } };

  it("passes cancellations to the team wherever the business takes bookings", () => {
    expect(toolNames({ channel: "web_voice" })).toContain("requestAppointmentCancellation");
    expect(toolNames({ channel: "web_chat", bookingMode: "request" })).toContain("requestAppointmentCancellation");
    expect(toolNames({ channel: "voice", callerPhone: "+14165550100", snapshot: operatorOnly })).toContain("requestAppointmentCancellation");
    // Next to self-service, for an appointment the caller's number doesn't find or verify.
    expect(toolNames({ channel: "voice", callerPhone: "+14165550100" })).toEqual(expect.arrayContaining(["cancelAppointment", "lookupAppointmentForChange", "requestAppointmentCancellation"]));
  });

  it("isn't offered where the business takes no bookings, or in a demo", () => {
    expect(toolNames({ channel: "web_voice", bookingMode: "off" })).not.toContain("requestAppointmentCancellation");
    expect(toolNames({ channel: "voice", callerPhone: "+14165550100", bookingMode: "off" })).not.toContain("requestAppointmentCancellation");
    expect(toolNames({ channel: "web_voice", intakeOnly: true })).not.toContain("requestAppointmentCancellation");
  });

  it("saves the caller's details as a request and says the appointment isn't cancelled", async () => {
    const tools = createReceptionistTools({ domain: { db: {} as never }, channel: "web_voice", callId: "call_1", conversationId: "conversation_1", snapshot: { ...demoSnapshot, timezone: "America/Toronto" } });
    const execute = tools.requestAppointmentCancellation!.execute! as (input: object, options: object) => Promise<unknown>;
    await expect(execute({ callerName: "Milan", appointmentStartsAt: "2026-10-14T15:00", serviceName: "General Checkup", callbackPhone: "+14165550100" }, { toolCallId: "1", messages: [] }))
      .resolves.toMatchObject({ ok: true, inboxItemId: "inbox_1", cancelled: false, status: expect.stringContaining("still booked") });
    expect(vi.mocked(requestCancellationForCaller).mock.lastCall?.[1]).toEqual({
      businessId: demoSnapshot.businessId, channel: "web_voice", timezone: "America/Toronto", callerName: "Milan",
      appointmentStartsAt: "2026-10-14T15:00", serviceName: "General Checkup", callbackPhone: "+14165550100", callId: "call_1", conversationId: "conversation_1",
    });
  });

  it("uses the trusted caller number and asks for a name before saving", async () => {
    vi.mocked(requestCancellationForCaller).mockClear();
    const tools = createReceptionistTools({ domain: { db: {} as never }, channel: "voice", callerPhone: "+14165550100", snapshot: { ...demoSnapshot, ...operatorOnly } });
    const execute = tools.requestAppointmentCancellation!.execute! as (input: object, options: object) => Promise<unknown>;
    await expect(execute({ callerName: " " }, { toolCallId: "1", messages: [] })).resolves.toMatchObject({ ok: false });
    expect(requestCancellationForCaller).not.toHaveBeenCalled();
    await execute({ callerName: "Milan", callbackPhone: "" }, { toolCallId: "2", messages: [] });
    expect(vi.mocked(requestCancellationForCaller).mock.lastCall?.[1]).toMatchObject({ callerName: "Milan", callbackPhone: "+14165550100", channel: "voice" });
  });
});

describe("bookAppointment", () => {
  const book = (startsAt: string) => {
    const tools = createReceptionistTools({ domain: { db: {} as never }, channel: "voice", callerPhone: "+14165550100", snapshot: { ...demoSnapshot, timezone: "America/Toronto" } });
    const execute = tools.bookAppointment!.execute! as (input: object, options: object) => Promise<unknown>;
    return execute({ serviceName: "General Checkup", startsAt, contactName: "Milan" }, { toolCallId: "1", messages: [] });
  };

  it("books a time the caller accepted from the conversation, in the business's timezone", async () => {
    await expect(book("2026-10-06T10:00")).resolves.toMatchObject({ ok: true });
    expect(vi.mocked(checkOpening).mock.lastCall?.[1]).toMatchObject({ startsAt: "2026-10-06T10:00:00.000-04:00" });
    expect(vi.mocked(bookForCaller).mock.lastCall?.[1]).toMatchObject({ startsAt: "2026-10-06T10:00:00.000-04:00" });
  });

  it("returns the caller's existing booking for a repeated request instead of calling the slot taken", async () => {
    vi.mocked(findCallerBooking).mockResolvedValueOnce({ ok: true, appointmentId: "appt_1", serviceName: "General Checkup", startsAt: "2026-10-06T10:00:00.000-04:00", alreadyBooked: true });
    vi.mocked(checkOpening).mockClear();
    vi.mocked(bookForCaller).mockClear();
    await expect(book("2026-10-06T10:00")).resolves.toMatchObject({ ok: true, appointmentId: "appt_1", alreadyBooked: true });
    expect(vi.mocked(findCallerBooking).mock.lastCall?.[1]).toMatchObject({ serviceName: "General Checkup", startsAt: "2026-10-06T10:00:00.000-04:00", contactPhone: "+14165550100" });
    expect(checkOpening).not.toHaveBeenCalled();
    expect(bookForCaller).not.toHaveBeenCalled();
  });

  it("never says whose booking a typed or spoken number holds", async () => {
    const run = (channel: AgentChannel, callerPhone?: string) => {
      const tools = createReceptionistTools({ domain: { db: {} as never }, channel, ...(callerPhone ? { callerPhone } : {}), snapshot: demoSnapshot });
      return (tools.bookAppointment!.execute! as (input: object, options: object) => Promise<unknown>)({ serviceName: "General Checkup", startsAt: "2026-10-06T10:00", contactName: "Milan", contactPhone: "+14165550199", smsConsent: "not_asked" }, { toolCallId: "1", messages: [] });
    };
    vi.mocked(findCallerBooking).mockClear();
    vi.mocked(checkOpening).mockClear();
    await run("web_chat");
    await run("voice", "+14165550100");
    expect(findCallerBooking).not.toHaveBeenCalled();
    expect(checkOpening).toHaveBeenCalledTimes(2);
  });

  it("reports a browser call's own booking for a repeated request", async () => {
    vi.mocked(findCallBooking).mockResolvedValueOnce({ ok: true, serviceName: "General Checkup", startsAt: "2026-10-06T10:00:00.000-04:00", alreadyBooked: true });
    vi.mocked(findCallerBooking).mockClear();
    vi.mocked(bookForCaller).mockClear();
    const tools = createReceptionistTools({ domain: { db: {} as never }, channel: "web_voice", callId: "call_1", snapshot: { ...demoSnapshot, timezone: "America/Toronto" } });
    const execute = tools.bookAppointment!.execute! as (input: object, options: object) => Promise<unknown>;
    await expect(execute({ serviceName: "General Checkup", startsAt: "2026-10-06T10:00", contactName: "Milan", contactPhone: "+14165550199", smsConsent: "not_asked" }, { toolCallId: "1", messages: [] })).resolves.toMatchObject({ ok: true, alreadyBooked: true });
    expect(vi.mocked(findCallBooking).mock.lastCall?.[1]).toEqual({ businessId: demoSnapshot.businessId, callId: "call_1", serviceName: "General Checkup", startsAt: "2026-10-06T10:00:00.000-04:00" });
    expect(findCallerBooking).not.toHaveBeenCalled();
    expect(bookForCaller).not.toHaveBeenCalled();
  });

  it("keeps the instant of a findAvailability startsAt", async () => {
    await book("2026-10-06T14:00:00.000Z");
    expect(vi.mocked(bookForCaller).mock.lastCall?.[1]).toMatchObject({ startsAt: "2026-10-06T10:00:00.000-04:00" });
  });

  it("uses the caller's number when the model sends an empty phone", async () => {
    const tools = createReceptionistTools({ domain: { db: {} as never }, channel: "voice", callerPhone: "+14165550100", snapshot: demoSnapshot });
    const execute = tools.bookAppointment!.execute! as (input: object, options: object) => Promise<unknown>;
    await expect(execute({ serviceName: "General Checkup", startsAt: "2026-10-06T10:00", contactName: "Milan", contactPhone: "" }, { toolCallId: "1", messages: [] })).resolves.toMatchObject({ ok: true });
    expect(vi.mocked(bookForCaller).mock.lastCall?.[1]).toMatchObject({ contactPhone: "+14165550100" });
  });

  it("asks for the caller's name before booking", async () => {
    vi.mocked(bookForCaller).mockClear();
    const tools = createReceptionistTools({ domain: { db: {} as never }, channel: "voice", callerPhone: "+14165550100", snapshot: demoSnapshot });
    const execute = tools.bookAppointment!.execute! as (input: object, options: object) => Promise<unknown>;
    await expect(execute({ serviceName: "General Checkup", startsAt: "2026-10-06T10:00", contactName: " " }, { toolCallId: "1", messages: [] })).resolves.toEqual({ ok: false, reason: "Ask for the caller's name before booking." });
    expect(bookForCaller).not.toHaveBeenCalled();
  });

  it("asks for a usable time instead of booking an unreadable one", async () => {
    vi.mocked(bookForCaller).mockClear();
    await expect(book("tomorrow at ten")).resolves.toMatchObject({ ok: false });
    expect(bookForCaller).not.toHaveBeenCalled();
  });
});

describe("getBusinessHours", () => {
  // The rule the tool used before it moved onto the shared helper, kept to show its answers didn't change.
  function earlierOpenNow(snapshot: BusinessContextSnapshot, at: Date): boolean {
    const now = DateTime.fromJSDate(at).setZone(snapshot.timezone);
    const minutesNow = now.hour * 60 + now.minute;
    const today = now.weekday % 7;
    return snapshot.hours.some((window) => window.dayOfWeek === today && minutesNow >= window.openMinutes && minutesNow < window.closeMinutes)
      && !snapshot.closures.some((closure) => now >= DateTime.fromISO(closure.startsAt) && now < DateTime.fromISO(closure.endsAt));
  }

  async function hoursAt(snapshot: BusinessContextSnapshot, at: Date) {
    vi.setSystemTime(at);
    try {
      const execute = createReceptionistTools({ domain: { db: {} as never }, channel: "voice", snapshot }).getBusinessHours!.execute! as (input: object, options: object) => Promise<Record<string, unknown>>;
      return await execute({}, { toolCallId: "1", messages: [] });
    } finally {
      vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
    }
  }

  const snapshot: BusinessContextSnapshot = {
    ...demoSnapshot,
    hours: [...demoSnapshot.hours, { dayOfWeek: 6, openMinutes: 600, closeMinutes: 720 }, { dayOfWeek: 6, openMinutes: 780, closeMinutes: 900 }],
    closures: [{ startsAt: "2026-10-12T04:00:00.000Z", endsAt: "2026-10-13T04:00:00.000Z", reason: "Thanksgiving" }],
  };

  it("answers as it did before, open or closed, every quarter hour of a week with a closure", async () => {
    for (let at = Date.parse("2026-10-10T00:00:00Z"); at < Date.parse("2026-10-17T00:00:00Z"); at += 15 * 60_000) {
      expect((await hoursAt(snapshot, new Date(at))).openNow, new Date(at).toISOString()).toBe(earlierOpenNow(snapshot, new Date(at)));
    }
  });

  it("keeps the rest of its answer", async () => {
    await expect(hoursAt(snapshot, new Date("2026-10-13T14:30:00Z"))).resolves.toEqual({
      timezone: "America/Toronto",
      now: "Tuesday 10:30 AM",
      openNow: true,
      configured: true,
      weekly: ["Sunday: closed", "Monday: 9:00 AM to 5:00 PM", "Tuesday: 9:00 AM to 5:00 PM", "Wednesday: 9:00 AM to 5:00 PM", "Thursday: 9:00 AM to 5:00 PM", "Friday: 9:00 AM to 4:00 PM", "Saturday: 10:00 AM to 12:00 PM, 1:00 PM to 3:00 PM"],
      upcomingClosures: [],
    });
    expect((await hoursAt(snapshot, new Date("2026-10-12T14:30:00Z"))).openNow).toBe(false);
  });
});

describe("getBusinessServices", () => {
  it("returns what the knowledge base says the business offers when it lists no services", async () => {
    vi.mocked(searchKnowledgeEvidence).mockResolvedValueOnce({ outcome: "found", matches: [{ title: "About", content: "An AI receptionist for small businesses." }] } as never);
    const tools = createReceptionistTools({ domain: { db: {} as never }, channel: "voice", snapshot: { ...demoSnapshot, services: [] } });
    const execute = tools.getBusinessServices!.execute! as (input: object, options: object) => Promise<unknown>;
    await expect(execute({}, { toolCallId: "1", messages: [] })).resolves.toMatchObject({ services: [], knowledge: { outcome: "found", matches: [{ title: "About", text: "An AI receptionist for small businesses." }] } });
  });

  it("doesn't search when the business lists services", async () => {
    vi.mocked(searchKnowledgeEvidence).mockClear();
    const tools = createReceptionistTools({ domain: { db: {} as never }, channel: "voice", snapshot: demoSnapshot });
    const execute = tools.getBusinessServices!.execute! as (input: object, options: object) => Promise<unknown>;
    const result = await execute({}, { toolCallId: "1", messages: [] }) as { services: unknown[]; knowledge?: unknown };
    expect(result.services.length).toBeGreaterThan(0);
    expect(result.knowledge).toBeUndefined();
    expect(searchKnowledgeEvidence).not.toHaveBeenCalled();
  });
});

describe("searchKnowledge", () => {
  const snippet = (title: string, content: string, priority = 0): KnowledgeSnippet => ({ id: title, title, content, tags: [], priority });
  const passage = (title: string, content = `${title} details`) => ({ chunkId: title, documentId: title, title, content, sourceUrl: null, sourceRevision: 1, sequence: 0 });
  const evidence = (titles: string[], content?: string) => ({ matches: titles.map((title) => passage(title, content)), mode: "hybrid" as const, outcome: titles.length ? "found" as const : "empty" as const, durationMs: 1 });
  // Long pasted text full of common words, like production snippets.
  const chatter = (topic: string) => snippet(topic, `What are the things you should know about ${topic}? You can ask us, and we are happy to help with the details.`);

  async function search(query: string, snippets: KnowledgeSnippet[], found: ReturnType<typeof evidence> | Error) {
    if (found instanceof Error) vi.mocked(searchKnowledgeEvidence).mockRejectedValueOnce(found);
    else vi.mocked(searchKnowledgeEvidence).mockResolvedValueOnce(found);
    const tools = createReceptionistTools({ domain: { db: {} as never }, channel: "web_chat", snapshot: { ...demoSnapshot, knowledgeSnippets: snippets } });
    const execute = tools.searchKnowledge!.execute! as (input: object, options: object) => Promise<{ outcome: string; matches: Array<{ title: string; text: string }> }>;
    const result = await execute({ query }, { toolCallId: "1", messages: [] });
    return { outcome: result.outcome, titles: result.matches.map((match) => match.title) };
  }

  it("keeps every evidence match ahead of snippets that only share common words", async () => {
    const snippets = ["Welcome", "Team", "History", "Insurance", "Hours", "Directions", "Pets"].map(chatter);
    await expect(search("What are the parking rates?", snippets, evidence(["Parking", "Rates", "Garage"]))).resolves.toEqual({ outcome: "found", titles: ["Parking", "Rates", "Garage"] });
  });

  it("finds a text entry beyond the few the prompt lists", async () => {
    const snippets = [...Array.from({ length: 12 }, (_, index) => chatter(`Topic ${index}`)), snippet("Do you offer valet parking?", "Yes, valet parking is free on weekends.", -5)];
    await expect(search("valet parking", snippets, evidence([]))).resolves.toEqual({ outcome: "found", titles: ["Do you offer valet parking?"] });
  });

  it("returns no snippets for a query of only common words", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const snippets = ["Welcome", "Team", "History"].map(chatter);
    await expect(search("what are the", snippets, evidence([]))).resolves.toEqual({ outcome: "empty", titles: [] });
    await expect(search("what are the", snippets, new Error("search down"))).resolves.toEqual({ outcome: "unavailable", titles: [] });
    warn.mockRestore();
  });

  it("adds relevant snippets after the evidence, strongest first, within six matches", async () => {
    const snippets = [
      snippet("Clinic history", "The clinic opened in 1990.", 9),
      snippet("Parking fees", "Parking costs $5 a day. Fees are waived for seniors.", 1),
      snippet("Getting here", "Our downtown clinic has parking behind the building.", 0),
      snippet("Seniors", "Parking fees are waived for seniors.", 5),
      ...["Welcome", "Team"].map(chatter),
    ];
    await expect(search("Parking fees at the downtown clinic", snippets, evidence(["Garage", "Rates", "Map"]))).resolves.toEqual({ outcome: "found", titles: ["Garage", "Rates", "Map", "Getting here", "Seniors", "Parking fees"] });
    await expect(search("Parking fees at the downtown clinic", snippets, evidence(["Garage", "Rates", "Map", "Lot", "Street"]))).resolves.toEqual({ outcome: "found", titles: ["Garage", "Rates", "Map", "Lot", "Street", "Getting here"] });
  });

  it("falls back to relevant snippets when knowledge search fails, and logs the failure", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const snippets = [chatter("Welcome"), snippet("Parking", "Parking is available behind the building.")];
    await expect(search("Where can I park? Is parking free?", snippets, new Error("search down"))).resolves.toEqual({ outcome: "found", titles: ["Parking"] });
    await expect(search("Do you take insurance cards?", [snippet("Parking", "Parking is available behind the building.")], new Error("search down"))).resolves.toEqual({ outcome: "unavailable", titles: [] });
    const failed = { level: "warn", message: "knowledge.search_failed", businessId: demoSnapshot.businessId, error: "search down" };
    expect(warn.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([failed, failed]);
    warn.mockRestore();
  });

  it("counts plurals and longer endings, but not unrelated words that share a short prefix", async () => {
    const snippets = [snippet("Car care", "We offer care plans for pets."), snippet("Fees", "Late fees are $10."), snippet("Lot", "The parking lot opens at 7.")];
    await expect(search("car", snippets, evidence([]))).resolves.toEqual({ outcome: "found", titles: ["Car care"] });
    await expect(search("car", [snippets[0]!].map((item) => ({ ...item, title: "Pets" })), evidence([]))).resolves.toEqual({ outcome: "empty", titles: [] });
    await expect(search("late fee", snippets, evidence([]))).resolves.toEqual({ outcome: "found", titles: ["Fees"] });
    await expect(search("park", snippets, evidence([]))).resolves.toEqual({ outcome: "found", titles: ["Lot"] });
  });

  it("gives snippets only the token budget the evidence leaves", async () => {
    // About 1,000 tokens each, like the longest pasted snippets in production.
    const long = (title: string) => snippet(title, `Parking rules for ${title}. ${"Visitors park in marked bays only. ".repeat(110)}`);
    const snippets = ["North lot", "South lot", "East lot", "West lot"].map(long);
    // Small evidence leaves room for two long snippets, not four.
    await expect(search("parking rules", snippets, evidence(["Garage"]))).resolves.toEqual({ outcome: "found", titles: ["Garage", "North lot", "South lot"] });
    // Evidence that fills most of the budget stays whole, and no long snippet fits after it.
    const fullEvidence = evidence(["Garage", "Rates"], "Garage parking rates and hours. ".repeat(140));
    await expect(search("parking rules", snippets, fullEvidence)).resolves.toEqual({ outcome: "found", titles: ["Garage", "Rates"] });
    // The fallback path keeps the same budget.
    await expect(search("parking rules", snippets, new Error("search down"))).resolves.toEqual({ outcome: "found", titles: ["North lot", "South lot"] });
  });

  it("matches French, accented and Spanish queries to the right snippet", async () => {
    const snippets = [
      snippet("Stationnement", "Le stationnement est gratuit dans la cour arrière."),
      snippet("Stratégie", "Le cours MNGT 10407 porte sur la stratégie d'entreprise."),
      snippet("Horario", "El horario es de lunes a viernes. El precio de la consulta se paga al llegar."),
      snippet("Limpieza dental", "Una limpieza dental cuesta 90 dólares."),
    ];
    await expect(search("Quel est le numéro du cours de stratégie MNGT 10407 ?", snippets, evidence([]))).resolves.toEqual({ outcome: "found", titles: ["Stratégie"] });
    await expect(search("Où est le stationnement ?", snippets, evidence([]))).resolves.toEqual({ outcome: "found", titles: ["Stationnement"] });
    await expect(search("¿Cuál es el precio de la limpieza dental?", snippets, evidence([]))).resolves.toEqual({ outcome: "found", titles: ["Limpieza dental"] });
  });
});

describe("unanswered questions", () => {
  type Note = (input: { question: string }, options: object) => Promise<unknown>;
  const note = async (conversation: Omit<AgentToolContext, "domain" | "snapshot">, question = "Do you validate parking?") => {
    vi.mocked(recordUnansweredQuestion).mockClear();
    const tools = createReceptionistTools({ domain: { db: {} as never }, snapshot: demoSnapshot, ...conversation });
    const result = await (tools.noteUnansweredQuestion!.execute! as Note)({ question }, { toolCallId: "1", messages: [] });
    // The save runs after the reply; let it start.
    await new Promise((resolve) => setTimeout(resolve, 0));
    return result;
  };

  it("saves a website chat question the receptionist couldn't answer, with the chat it came from", async () => {
    await expect(note({ channel: "web_chat", conversationId: "chat_1" })).resolves.toEqual({ noted: true });
    expect(recordUnansweredQuestion).toHaveBeenCalledWith(expect.anything(), { businessId: demoSnapshot.businessId, question: "Do you validate parking?", channel: "web_chat", conversationId: "chat_1" });
  });

  it("offers the tool only in website chats: calls get their questions from the call summary", () => {
    expect(toolNames({ channel: "web_chat", conversationId: "chat_1" })).toContain("noteUnansweredQuestion");
    expect(toolNames({ channel: "voice", callerPhone: "+14165550100", callControl })).not.toContain("noteUnansweredQuestion");
    expect(toolNames({ channel: "web_voice", callControl })).not.toContain("noteUnansweredQuestion");
    expect(toolNames({ channel: "web_chat", intakeOnly: true })).not.toContain("noteUnansweredQuestion");
  });

  it("saves nothing on its own when a search comes back empty", async () => {
    vi.mocked(recordUnansweredQuestion).mockClear();
    vi.mocked(searchKnowledgeEvidence).mockResolvedValueOnce({ matches: [], mode: "hybrid", outcome: "empty", durationMs: 1 });
    const tools = createReceptionistTools({ domain: { db: {} as never }, channel: "web_chat", conversationId: "chat_1", snapshot: { ...demoSnapshot, knowledgeSnippets: [] } });
    const execute = tools.searchKnowledge!.execute! as (input: object, options: object) => Promise<{ outcome: string }>;
    await expect(execute({ query: "Do you validate parking?" }, { toolCallId: "1", messages: [] })).resolves.toMatchObject({ outcome: "empty" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(recordUnansweredQuestion).not.toHaveBeenCalled();
  });

  it("answers without waiting for the save, and only logs when it fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let finishSave: (() => void) | undefined;
    vi.mocked(recordUnansweredQuestion).mockImplementationOnce(() => new Promise((_, reject) => { finishSave = () => reject(new Error("database down")); }));
    await expect(note({ channel: "web_chat", conversationId: "chat_1" })).resolves.toEqual({ noted: true });
    finishSave?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(warn.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([{ level: "warn", message: "knowledge.unanswered_question_failed", businessId: demoSnapshot.businessId, error: "database down" }]);
    warn.mockRestore();
  });
});
