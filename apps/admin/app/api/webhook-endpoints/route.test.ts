import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  create: vi.fn(async () => ({ id: "endpoint_1", url: "https://example.com/hook", secret: "whsec_once", events: ["call.completed"] })),
  list: vi.fn(async () => [{ id: "endpoint_1", url: "https://example.com/hook", events: ["call.completed"] }]),
}));
vi.mock("@/lib/api-helpers", async (original) => ({
  ...await original<typeof import("@/lib/api-helpers")>(),
  requireOperatorBusiness: async () => ({ session: { user: { id: "user_1" } }, businessId: "business_1" }),
}));
vi.mock("@/lib/domain-context", () => ({ createDomainContext: () => ({ db: "app" }) }));
vi.mock("@lobbystack/domain", () => ({ createWebhookEndpoint: fixture.create, listWebhookEndpoints: fixture.list }));

import { GET, POST } from "./route";

const address = "http://localhost:3000/api/webhook-endpoints?businessId=business_1";
const post = (body: unknown) => POST(new Request(address, { method: "POST", body: JSON.stringify(body) }));
const manager = { kind: "operator", userId: "user_1" };

beforeEach(() => { vi.clearAllMocks(); });

describe("webhook endpoints", () => {
  it("lists the business's endpoints, asking as the operator", async () => {
    const response = await GET(new Request(address));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ endpoints: [{ id: "endpoint_1", url: "https://example.com/hook", events: ["call.completed"] }] });
    expect(fixture.list).toHaveBeenCalledWith({ db: "app" }, { businessId: "business_1", manager });
  });

  // The signing secret is in the answer once, so the screen can show it.
  it("creates an endpoint and answers 201 with the signing secret", async () => {
    const response = await post({ url: "https://example.com/hook", events: ["call.completed"], description: "Reporting" });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ id: "endpoint_1", secret: "whsec_once" });
    expect(fixture.create).toHaveBeenCalledWith({ db: "app" }, { businessId: "business_1", manager, url: "https://example.com/hook", events: ["call.completed"], description: "Reporting" });
  });

  it("keeps only the event names that are text", async () => {
    await post({ url: "https://example.com/hook", events: ["call.completed", 7, null, "message.received"] });

    expect(fixture.create).toHaveBeenCalledWith({ db: "app" }, expect.objectContaining({ events: ["call.completed", "message.received"] }));
  });

  it("passes what the domain refuses back with its status, not a 500", async () => {
    fixture.create.mockRejectedValueOnce(Object.assign(new Error("A webhook address must use https."), { status: 400 }));

    const response = await post({ url: "http://example.com/hook", events: [] });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "A webhook address must use https." });
  });

  it("answers a body that isn't JSON with 400", async () => {
    const response = await POST(new Request(address, { method: "POST", body: "{" }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "invalid_json" });
    expect(fixture.create).not.toHaveBeenCalled();
  });
});
