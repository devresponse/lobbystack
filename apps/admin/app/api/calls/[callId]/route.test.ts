import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ detail: vi.fn(), complete: vi.fn(), archive: vi.fn() }));
vi.mock("@/lib/api-helpers", async (original) => ({
  ...await original<typeof import("@/lib/api-helpers")>(),
  requireOperatorBusiness: async () => ({ session: { user: { id: "user_1" } }, businessId: "business_1" }),
}));
vi.mock("@/lib/domain-context", () => ({ createDomainContext: () => ({ db: "app" }) }));
vi.mock("@/lib/storage", () => ({ getStorageProvider: () => ({}) }));
vi.mock("@lobbystack/domain", () => ({ getCallDetail: fixture.detail, completeVoiceFollowUpTasks: fixture.complete, setCallArchived: fixture.archive, createObjectDownload: vi.fn() }));

import { GET as getRecording } from "./recording/route";
import { GET, PATCH } from "./route";

beforeEach(() => { vi.clearAllMocks(); });

const params = { params: Promise.resolve({ callId: "abc" }) };

describe("call detail API with a malformed call id", () => {
  it("answers 404 without querying the database", async () => {
    const responses = [
      await GET(new Request("http://localhost:3000/api/calls/abc"), params),
      await getRecording(new Request("http://localhost:3000/api/calls/abc/recording"), params),
      await PATCH(new Request("http://localhost:3000/api/calls/abc", { method: "PATCH", body: JSON.stringify({ action: "complete_follow_up" }) }), params),
      await PATCH(new Request("http://localhost:3000/api/calls/abc", { method: "PATCH", body: JSON.stringify({ action: "archive" }) }), params),
    ];
    for (const response of responses) {
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "Call not found.", code: "not_found" });
    }
    expect(fixture.detail).not.toHaveBeenCalled();
    expect(fixture.complete).not.toHaveBeenCalled();
    expect(fixture.archive).not.toHaveBeenCalled();
  });
});

describe("archiving a call", () => {
  const callId = "5050b922-84a8-4b5e-9d55-1f2a3b4c5d6e";
  const patch = (body: unknown) => PATCH(new Request(`http://localhost:3000/api/calls/${callId}`, { method: "PATCH", body: JSON.stringify(body) }), { params: Promise.resolve({ callId }) });

  it("archives the call and answers with when", async () => {
    fixture.archive.mockResolvedValue({ archivedAt: new Date("2026-10-30T06:30:00Z") });
    const response = await patch({ action: "archive" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ archivedAt: "2026-10-30T06:30:00.000Z" });
    expect(fixture.archive).toHaveBeenCalledWith({ db: "app" }, { userId: "user_1", businessId: "business_1", callId, archived: true });
    expect(fixture.complete).not.toHaveBeenCalled();
  });

  it("restores an archived call", async () => {
    fixture.archive.mockResolvedValue({ archivedAt: null });
    const response = await patch({ action: "restore" });
    expect(await response.json()).toEqual({ archivedAt: null });
    expect(fixture.archive).toHaveBeenCalledWith({ db: "app" }, { userId: "user_1", businessId: "business_1", callId, archived: false });
  });

  it("answers 404 for a call the business doesn't have", async () => {
    fixture.archive.mockResolvedValue(null);
    const response = await patch({ action: "archive" });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Call not found.", code: "not_found" });
  });

  it("refuses an action it doesn't know", async () => {
    const response = await patch({ action: "delete" });
    expect(response.status).toBe(400);
    expect(fixture.archive).not.toHaveBeenCalled();
    expect(fixture.complete).not.toHaveBeenCalled();
  });
});
