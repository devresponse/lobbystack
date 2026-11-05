import { beforeEach, describe, expect, it, vi } from "vitest";

import { jsonError } from "@/lib/api-helpers";

const mocks = vi.hoisted(() => ({
  options: vi.fn(),
  operator: vi.fn(async () => "business_1"),
  snapshot: vi.fn(async (_businessId: string): Promise<Record<string, unknown> | null> => null),
  status: vi.fn(async (_snapshot: unknown) => "ready"),
  request: vi.fn(async (_input: unknown) => true),
  requireLive: vi.fn(() => undefined),
}));

vi.mock("@/lib/api-helpers", async (original) => ({
  ...await original<typeof import("@/lib/api-helpers")>(),
  withOperatorTransaction: async (_request: Request, callback: (input: unknown) => unknown, options: unknown) => {
    mocks.options(options);
    const businessId = await mocks.operator();
    return await callback({ session: { user: { id: "owner" } }, businessId, tx: {} });
  },
}));
vi.mock("@/lib/business-snapshot", () => ({ loadValidBusinessSnapshot: mocks.snapshot }));
vi.mock("@/lib/live-greeting", () => ({ greetingRecordingStatus: mocks.status }));
vi.mock("@/lib/live-prototype", () => ({ requestGreetingRecording: mocks.request, requireLivePrototype: mocks.requireLive }));

import { POST } from "./route";

const frontDesk = "00000000-0000-4000-8000-0000000000a1";
const secondDesk = "00000000-0000-4000-8000-0000000000a2";
const receptionist = (id: string, greeting: string, overrides: Record<string, unknown> = {}) => ({
  id, name: id, description: "", isDefault: false, status: "active", listed: true, order: 1, knowledgeScope: "all", greeting,
  voiceInstructions: "", smsInstructions: "", chatInstructions: "", bookingPolicy: "", bookingMode: "instant", transferPolicy: { mode: "never" }, snippetIds: [],
  ...overrides,
});
const business = {
  businessId: "business_1", greeting: "Thanks for calling.", defaultLocale: "en", recordingNotice: true, contactChannels: {},
  receptionists: [receptionist(frontDesk, "Thanks for calling.", { isDefault: true, order: 0 }), receptionist(secondDesk, "Hi, this is the second desk.")],
};

const ask = (body: unknown = {}) => POST(new Request("http://localhost:3000/api/test-call/greeting?businessId=business_1", { method: "POST", body: JSON.stringify(body) }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.snapshot.mockResolvedValue(business);
  mocks.status.mockResolvedValue("ready");
  mocks.request.mockResolvedValue(true);
  mocks.requireLive.mockImplementation(() => undefined);
  mocks.operator.mockResolvedValue("business_1");
});

describe("POST /api/test-call/greeting", () => {
  it("says a recorded opening is ready, for owners and admins, who make test calls", async () => {
    const response = await ask();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ready" });
    expect(mocks.options).toHaveBeenCalledWith({ minimumRole: "business_admin" });
    expect(mocks.snapshot).toHaveBeenCalledWith("business_1");
    // The default receptionist's opening without a receptionist.
    expect(mocks.status).toHaveBeenCalledWith(expect.objectContaining({ greeting: "Thanks for calling.", receptionist: expect.objectContaining({ id: frontDesk }) }));
    expect(mocks.request).not.toHaveBeenCalled();
  });

  // A second receptionist just added has no recording until the worker makes one.
  it("asks the worker to record the chosen receptionist's missing opening, and says it's being recorded", async () => {
    mocks.status.mockResolvedValue("missing");
    const response = await ask({ receptionistId: secondDesk.toUpperCase() });
    await expect(response.json()).resolves.toEqual({ status: "recording" });
    expect(mocks.status).toHaveBeenCalledWith(expect.objectContaining({ greeting: "Hi, this is the second desk.", receptionist: expect.objectContaining({ id: secondDesk }) }));
    expect(mocks.request).toHaveBeenCalledWith({ businessId: "business_1", receptionistId: secondDesk });
  });

  it("passes on a recording under way or failed, without asking again", async () => {
    for (const status of ["recording", "failed", "off"]) {
      mocks.status.mockResolvedValueOnce(status);
      await expect((await ask({ receptionistId: secondDesk })).json()).resolves.toEqual({ status });
    }
    expect(mocks.request).not.toHaveBeenCalled();
  });

  // The test call then starts at once, as it would without a recording.
  it("is off when the worker records none, and missing when the worker can't be reached", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.status.mockResolvedValue("missing");
    mocks.request.mockResolvedValueOnce(false);
    await expect((await ask()).json()).resolves.toEqual({ status: "off" });
    mocks.request.mockRejectedValueOnce(new Error("Worker greeting failed with status 503."));
    await expect((await ask()).json()).resolves.toEqual({ status: "missing" });
  });

  it("is off for a business without a snapshot", async () => {
    mocks.snapshot.mockResolvedValueOnce(null);
    await expect((await ask()).json()).resolves.toEqual({ status: "off" });
    expect(mocks.status).not.toHaveBeenCalled();
  });

  it("refuses a receptionist that isn't an ID, and answers 404 while GPT-Live is off", async () => {
    for (const receptionistId of ["front desk", 7]) {
      const response = await ask({ receptionistId });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ code: "invalid_receptionist" });
    }
    mocks.requireLive.mockImplementation(() => { throw jsonError("The GPT-Live prototype is off.", 404, "live_prototype_disabled"); });
    expect((await ask()).status).toBe(404);
    expect(mocks.status).not.toHaveBeenCalled();
  });

  it("refuses someone who can't make test calls", async () => {
    mocks.operator.mockRejectedValueOnce(jsonError("Forbidden.", 403, "forbidden"));
    expect((await ask()).status).toBe(403);
    expect(mocks.snapshot).not.toHaveBeenCalled();
  });
});
