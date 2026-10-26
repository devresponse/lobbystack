import { NextResponse } from "next/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withOperatorTransaction: vi.fn(),
  requireBusinessMembership: vi.fn(),
  loadCallTranscriptSettingsInTransaction: vi.fn(),
  saveCallTranscriptSettingsInTransaction: vi.fn(),
}));

vi.mock("@/lib/api-helpers", () => ({
  withOperatorTransaction: mocks.withOperatorTransaction,
  asApiResponse: (error: unknown) => (error instanceof NextResponse ? error : NextResponse.json({ error: String(error) }, { status: 500 })),
  jsonError: (message: string, status: number, code: string) => NextResponse.json({ error: message, code }, { status }),
  readJson: async (request: Request) => await request.json(),
}));
vi.mock("@lobbystack/domain", async (importOriginal) => ({
  hasMinimumRole: (await importOriginal<typeof import("@lobbystack/domain")>()).hasMinimumRole,
  requireBusinessMembership: mocks.requireBusinessMembership,
  loadCallTranscriptSettingsInTransaction: mocks.loadCallTranscriptSettingsInTransaction,
  saveCallTranscriptSettingsInTransaction: mocks.saveCallTranscriptSettingsInTransaction,
}));

import { GET, PUT } from "./route";

const tx = { name: "tx" };
const url = "https://app.example.com/api/call-transcript-settings?businessId=business";

beforeEach(() => {
  mocks.withOperatorTransaction.mockImplementation(async (_request, callback) => callback({ session: { user: { id: "operator" } }, businessId: "business", tx }));
  mocks.loadCallTranscriptSettingsInTransaction.mockResolvedValue({ recipients: "owners_and_admins", content: "summary" });
  mocks.saveCallTranscriptSettingsInTransaction.mockImplementation(async (_tx, input) => ({ recipients: "owners_and_admins", content: "summary", ...input.change }));
});

afterEach(() => {
  vi.resetAllMocks();
});

const put = (body: unknown) => new Request(url, { method: "PUT", body: JSON.stringify(body) });

it("gives every member the business's choice, and says who can change it", async () => {
  mocks.requireBusinessMembership.mockResolvedValue({ role: "business_owner" });
  expect(await (await GET(new Request(url))).json()).toEqual({ recipients: "owners_and_admins", content: "summary", canEdit: true });
  expect(mocks.loadCallTranscriptSettingsInTransaction).toHaveBeenCalledWith(tx, { businessId: "business" });

  mocks.requireBusinessMembership.mockResolvedValue({ role: "viewer" });
  expect(await (await GET(new Request(url))).json()).toMatchObject({ canEdit: false });
});

it("saves a change as an owner or admin, and records who made it", async () => {
  const response = await PUT(put({ content: "transcript" }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ recipients: "owners_and_admins", content: "transcript", canEdit: true });
  expect(mocks.withOperatorTransaction).toHaveBeenCalledWith(expect.any(Request), expect.any(Function), { minimumRole: "business_admin" });
  expect(mocks.saveCallTranscriptSettingsInTransaction).toHaveBeenCalledWith(tx, { businessId: "business", change: { content: "transcript" }, audit: { actorUserId: "operator" } });
});

it("refuses a choice it doesn't know, or nothing to change", async () => {
  for (const body of [{ recipients: "everyone" }, { content: "audio" }, {}, { recipients: "team", extra: true }, "team"]) {
    const response = await PUT(put(body));
    expect(response.status, JSON.stringify(body)).toBe(400);
    expect(await response.json()).toMatchObject({ code: "call_transcript_settings_invalid" });
  }
  expect(mocks.saveCallTranscriptSettingsInTransaction).not.toHaveBeenCalled();
});
