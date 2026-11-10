import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ insert: vi.fn(), values: vi.fn(), select: vi.fn(), update: vi.fn(), setReceptionist: vi.fn() }));

vi.mock("@/lib/api-helpers", () => ({
  readJson: (request: Request) => request.json(),
  withOperatorTransaction: (_request: Request, callback: (input: unknown) => Promise<unknown>) => callback({ session: { user: { id: "owner" } }, businessId: "business", tx: { insert: mocks.insert, select: mocks.select, update: mocks.update } }),
  jsonError: (message: string, status = 400, code?: string) => new Response(JSON.stringify({ error: message, ...(code ? { code } : {}) }), { status }),
  asApiResponse: (error: unknown) => {
    if (error instanceof Response) return error;
    const status = typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : 500;
    return new Response(JSON.stringify({ error: status < 500 ? (error as Error).message : "Request failed.", code: (error as { code?: string }).code }), { status });
  },
}));

vi.mock("@lobbystack/db", () => ({ widgetKeys: { id: "id", businessId: "business_id", createdAt: "created_at" } }));
// The route writes keys through the domain's widget key functions; load only
// those, and the check of a receptionist id. Pointing a key at a receptionist
// is covered by receptionistEntryPoints.integration.test.ts.
vi.mock("@lobbystack/domain", async () => ({
  ...await import("../../../../../packages/domain/src/server/widgetKeys"),
  readEntryPointReceptionist: (await import("../../../../../packages/domain/src/server/receptionistEntryPoints")).readEntryPointReceptionist,
  setWidgetKeyReceptionistInTransaction: mocks.setReceptionist,
}));

import { GET, PATCH, POST } from "./route";

const FRONT_DESK = "00000000-0000-4000-8000-0000000000a1";
const KITSILANO = "00000000-0000-4000-8000-0000000000a2";
const KEY_ID = "00000000-0000-4000-8000-000000000001";
const keyRow = (values: Record<string, unknown> = {}) => ({ id: KEY_ID, status: "active", label: null, allowedOrigins: [], config: {}, lastUsedAt: null, createdAt: new Date("2026-01-01T00:00:00.000Z"), keyValue: "wk_live_one", receptionistId: FRONT_DESK, ...values });

const request = (body: Record<string, unknown> = {}) => new Request("https://admin.test/api/widget-keys", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("widget key issuance gate", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.insert.mockReturnValue({
      values: (values: unknown) => (mocks.values(values), {
        returning: async () => [{
          id: "00000000-0000-4000-8000-000000000001",
          status: "active",
          label: null,
          allowedOrigins: [],
          config: {},
          lastUsedAt: null,
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          receptionistId: FRONT_DESK,
        }],
      }),
    });
    mocks.setReceptionist.mockImplementation(async (_tx, input: { widgetKeyId: string; receptionistId: string }) => ({ id: input.widgetKeyId, receptionistId: input.receptionistId }));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("refuses new keys by default while website chat is restricted", async () => {
    vi.stubEnv("WIDGET_KEY_ISSUANCE_ENABLED", "");
    const response = await POST(request({ allowedOrigins: ["https://business.test"] }));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "widget_issuance_disabled" });
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("issues a key only after an explicit operator opt-in", async () => {
    vi.stubEnv("WIDGET_KEY_ISSUANCE_ENABLED", "true");
    const response = await POST(request({ allowedOrigins: ["https://business.test"] }));
    expect(response.status).toBe(200);
    const body = await response.json() as { ok: boolean; key: { key: string } };
    expect(body).toMatchObject({ ok: true });
    expect(mocks.insert).toHaveBeenCalledTimes(1);
    // The key is kept beside its hash so the dashboard can show the snippet again.
    expect(mocks.values).toHaveBeenCalledWith(expect.objectContaining({ keyValue: body.key.key }));
  });

  it("names the default receptionist on a new key unless the owner chooses another", async () => {
    vi.stubEnv("WIDGET_KEY_ISSUANCE_ENABLED", "true");
    const plain = await (await POST(request({ allowedOrigins: ["https://business.test"] }))).json() as { record: { receptionistId: string } };
    expect(plain.record.receptionistId).toBe(FRONT_DESK);
    expect(mocks.setReceptionist).not.toHaveBeenCalled();
    const chosen = await (await POST(request({ allowedOrigins: ["https://business.test"], receptionistId: KITSILANO }))).json() as { key: { id: string }; record: { receptionistId: string } };
    expect(chosen.record.receptionistId).toBe(KITSILANO);
    expect(mocks.setReceptionist).toHaveBeenCalledExactlyOnceWith(expect.anything(), { businessId: "business", actorUserId: "owner", widgetKeyId: chosen.key.id, receptionistId: KITSILANO });
  });

  it("refuses a receptionist id that isn't one before making a key", async () => {
    vi.stubEnv("WIDGET_KEY_ISSUANCE_ENABLED", "true");
    const response = await POST(request({ allowedOrigins: ["https://business.test"], receptionistId: "kitsilano" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_receptionist" });
    expect(mocks.insert).not.toHaveBeenCalled();
  });
});

describe("widget key listing", () => {
  it("returns each key so its snippet can be copied again, except revoked and older keys", async () => {
    const row = { status: "active", label: null, allowedOrigins: [], config: {}, lastUsedAt: null, createdAt: new Date("2026-01-01T00:00:00.000Z") };
    mocks.select.mockReturnValue({ from: () => ({ where: () => ({ orderBy: async () => [
      { ...row, id: "00000000-0000-4000-8000-000000000001", keyValue: "wk_live_one" },
      { ...row, id: "00000000-0000-4000-8000-000000000002", keyValue: "wk_live_two", status: "revoked" },
      { ...row, id: "00000000-0000-4000-8000-000000000003", keyValue: null },
    ] }) }) });
    const response = await GET(new Request("https://admin.test/api/widget-keys"));
    const { keys } = await response.json() as { keys: Array<{ key: string | null }> };
    expect(keys.map((key) => key.key)).toEqual(["wk_live_one", null, null]);
  });

  it("says who answers each key's chats", async () => {
    mocks.select.mockReturnValue({ from: () => ({ where: () => ({ orderBy: async () => [keyRow({ receptionistId: KITSILANO })] }) }) });
    const { keys } = await (await GET(new Request("https://admin.test/api/widget-keys"))).json() as { keys: Array<{ receptionistId: string }> };
    expect(keys.map((key) => key.receptionistId)).toEqual([KITSILANO]);
  });
});

describe("who answers a widget key's chats", () => {
  const patch = (body: Record<string, unknown>) => PATCH(new Request(`https://admin.test/api/widget-keys?id=${KEY_ID}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  let stored: ReturnType<typeof keyRow>;

  beforeEach(() => {
    vi.resetAllMocks();
    stored = keyRow();
    // The key's current status, then the row read back after the change.
    mocks.select.mockImplementation(() => ({ from: () => ({ where: () => ({ limit: async () => [stored] }) }) }));
    mocks.setReceptionist.mockImplementation(async (_tx, input: { widgetKeyId: string; receptionistId: string }) => {
      stored = { ...stored, receptionistId: input.receptionistId };
      return { id: input.widgetKeyId, receptionistId: input.receptionistId };
    });
    mocks.update.mockImplementation(() => ({ set: (values: Record<string, unknown>) => ({ where: () => ({ returning: async () => [(stored = { ...stored, ...values })] }) }) }));
  });

  it("changes on its own, and the key comes back naming the new receptionist", async () => {
    const response = await patch({ receptionistId: KITSILANO });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, record: { id: KEY_ID, receptionistId: KITSILANO } });
    expect(mocks.setReceptionist).toHaveBeenCalledExactlyOnceWith(expect.anything(), { businessId: "business", actorUserId: "owner", widgetKeyId: KEY_ID, receptionistId: KITSILANO });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("changes beside the key's other settings, before them, so the saved key names it", async () => {
    const response = await patch({ label: "Kitsilano website", receptionistId: KITSILANO });
    expect(await response.json()).toMatchObject({ record: { label: "Kitsilano website", receptionistId: KITSILANO } });
    expect(mocks.setReceptionist.mock.invocationCallOrder[0]).toBeLessThan(mocks.update.mock.invocationCallOrder[0]!);
  });

  it("refuses a receptionist id that isn't one, changing nothing", async () => {
    const response = await patch({ label: "Kitsilano website", receptionistId: 42 });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_receptionist" });
    expect(mocks.setReceptionist).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("passes on the domain's refusal of an archived receptionist", async () => {
    mocks.setReceptionist.mockRejectedValue(Object.assign(new Error("An archived receptionist can't answer. Restore it first."), { status: 409, code: "receptionist_archived" }));
    const response = await patch({ receptionistId: KITSILANO });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "An archived receptionist can't answer. Restore it first.", code: "receptionist_archived" });
  });
});
