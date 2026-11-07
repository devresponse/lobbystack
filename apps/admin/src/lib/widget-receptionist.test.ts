import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BusinessContextSnapshot } from "@lobbystack/shared";

const state = vi.hoisted(() => ({
  /** Receptionists that aren't archived, as the token check reads them. */
  live: [] as Array<{ id: string }>,
  reads: 0,
  snapshot: null as unknown,
  log: vi.fn(),
}));

vi.mock("./api-helpers", () => ({ getWorkerDatabase: () => ({ db: {} }) }));
vi.mock("@lobbystack/telemetry/node", async (importOriginal) => ({ ...(await importOriginal<typeof import("@lobbystack/telemetry/node")>()), logEvent: state.log }));
vi.mock("@lobbystack/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@lobbystack/db")>();
  const query = { from: () => query, where: () => query, limit: async () => { state.reads += 1; return state.live; } };
  return { ...actual, withBusinessTransaction: async (_db: unknown, _context: unknown, run: (tx: unknown) => unknown) => await run({ select: () => query }) };
});
vi.mock("@lobbystack/domain", async () => ({
  getCachedBusinessSnapshot: async () => state.snapshot,
  snapshotForReceptionist: (await import("../../../../packages/domain/src/snapshot")).snapshotForReceptionist,
}));

import { loadWidgetReceptionist, receptionistFromPageToken } from "./widget-receptionist";
import { createReceptionistPageToken } from "./widget-keys";

const BUSINESS = "00000000-0000-4000-8000-000000000011";
const KEY = "00000000-0000-4000-8000-000000000010";
const FRONT_DESK = "00000000-0000-4000-8000-0000000000a1";
const KITSILANO = "00000000-0000-4000-8000-0000000000a2";
const session = { businessId: BUSINESS, widgetKeyId: KEY };

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("WIDGET_SESSION_SECRET", "session-secret");
  state.live = [{ id: KITSILANO }];
  state.reads = 0;
  state.snapshot = null;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("the receptionist a page's token names", () => {
  it("is taken when the page signed it for this business and widget", async () => {
    const token = createReceptionistPageToken({ businessId: BUSINESS, widgetKeyId: KEY, receptionistId: KITSILANO });
    expect(await receptionistFromPageToken(token, session)).toBe(KITSILANO);
    expect(state.log).not.toHaveBeenCalled();
  });

  it("is left out when the token was signed for another widget or business, without reading the database", async () => {
    for (const other of [{ businessId: BUSINESS, widgetKeyId: "00000000-0000-4000-8000-000000000019" }, { businessId: "00000000-0000-4000-8000-000000000099", widgetKeyId: KEY }]) {
      const token = createReceptionistPageToken({ ...other, receptionistId: KITSILANO });
      expect(await receptionistFromPageToken(token, session)).toBeUndefined();
    }
    expect(state.reads).toBe(0);
    expect(state.log).toHaveBeenCalledWith("warn", "widget.receptionist_token_rejected", { businessId: BUSINESS, widgetKeyId: KEY, reason: "other_widget" });
  });

  it("is left out when the token doesn't check out", async () => {
    expect(await receptionistFromPageToken("forged.token.value", session)).toBeUndefined();
    const expired = createReceptionistPageToken({ businessId: BUSINESS, widgetKeyId: KEY, receptionistId: KITSILANO, ttlSeconds: -1 });
    expect(await receptionistFromPageToken(expired, session)).toBeUndefined();
    expect(state.reads).toBe(0);
    expect(state.log).toHaveBeenCalledWith("warn", "widget.receptionist_token_rejected", { businessId: BUSINESS, widgetKeyId: KEY, reason: "invalid" });
  });

  it("is left out once the receptionist is archived, so the widget's key decides", async () => {
    state.live = [];
    const token = createReceptionistPageToken({ businessId: BUSINESS, widgetKeyId: KEY, receptionistId: KITSILANO });
    expect(await receptionistFromPageToken(token, session)).toBeUndefined();
    expect(state.log).toHaveBeenCalledWith("info", "widget.receptionist_token_archived", { businessId: BUSINESS, widgetKeyId: KEY });
  });
});

describe("the receptionist that answers a widget", () => {
  function receptionist(id: string, values: { isDefault?: boolean; status?: "active" | "paused"; name?: string } = {}) {
    return {
      id,
      name: values.name ?? "Front desk",
      description: "",
      isDefault: values.isDefault ?? false,
      status: values.status ?? "active",
      listed: true,
      knowledgeScope: values.isDefault ? "all" : "audience",
      locale: null,
      greeting: "Hello",
      voiceInstructions: "",
      smsInstructions: "",
      chatInstructions: "",
      bookingPolicy: "",
      bookingMode: "instant",
      transferPolicy: "",
      snippetIds: [],
    };
  }

  function snapshot(receptionists: unknown[] | undefined): BusinessContextSnapshot {
    return { businessId: BUSINESS, businessName: "Acme Dental", defaultLocale: "en", ...(receptionists ? { receptionists } : {}) } as unknown as BusinessContextSnapshot;
  }

  it("is the one the session names while it is active", async () => {
    state.snapshot = snapshot([receptionist(FRONT_DESK, { isDefault: true }), receptionist(KITSILANO, { name: "Kitsilano clinic" })]);
    expect(await loadWidgetReceptionist({} as never, { businessId: BUSINESS, receptionistId: KITSILANO })).toMatchObject({ receptionistId: KITSILANO });
  });

  it("is the default one when the session names none, or one that is paused or gone", async () => {
    state.snapshot = snapshot([receptionist(FRONT_DESK, { isDefault: true }), receptionist(KITSILANO, { status: "paused" })]);
    for (const receptionistId of [null, KITSILANO, "00000000-0000-4000-8000-0000000000ff"]) {
      expect((await loadWidgetReceptionist({} as never, { businessId: BUSINESS, receptionistId })).receptionistId).toBe(FRONT_DESK);
    }
  });

  it("is nobody before the business's first snapshot, or with one from before receptionists", async () => {
    expect(await loadWidgetReceptionist({} as never, { businessId: BUSINESS, receptionistId: KITSILANO })).toEqual({ snapshot: null, receptionistId: undefined });
    state.snapshot = snapshot(undefined);
    expect((await loadWidgetReceptionist({} as never, { businessId: BUSINESS, receptionistId: KITSILANO })).receptionistId).toBeUndefined();
  });
});
