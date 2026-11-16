import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  create: vi.fn(async () => ({ id: "key_1", key: "lsk_live_secret", name: "Reporting", scopes: ["calls:read"] })),
  list: vi.fn(async () => [{ id: "key_1", name: "Reporting", scopes: ["calls:read"] }]),
}));
vi.mock("@/lib/api-helpers", async (original) => ({
  ...await original<typeof import("@/lib/api-helpers")>(),
  requireOperatorBusiness: async () => ({ session: { user: { id: "user_1" } }, businessId: "business_1" }),
}));
vi.mock("@/lib/domain-context", () => ({ createDomainContext: () => ({ db: "app" }) }));
vi.mock("@lobbystack/domain", () => ({ createApiKey: fixture.create, listApiKeys: fixture.list }));

import { GET, POST } from "./route";

const address = "http://localhost:3000/api/api-keys?businessId=business_1";
const post = (body: unknown) => POST(new Request(address, { method: "POST", body: JSON.stringify(body) }));

beforeEach(() => { vi.clearAllMocks(); });

describe("API keys", () => {
  it("lists the business's keys for the signed-in operator", async () => {
    const response = await GET(new Request(address));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ keys: [{ id: "key_1", name: "Reporting", scopes: ["calls:read"] }] });
    expect(fixture.list).toHaveBeenCalledWith({ db: "app" }, { userId: "user_1", businessId: "business_1" });
  });

  // The plaintext key is in the answer once and nowhere else, so the screen can show it.
  it("creates a key and answers 201 with the key itself", async () => {
    const response = await post({ name: "Reporting", scopes: ["calls:read"] });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ id: "key_1", key: "lsk_live_secret" });
    expect(fixture.create).toHaveBeenCalledWith({ db: "app" }, { userId: "user_1", businessId: "business_1", name: "Reporting", scopes: ["calls:read"] });
  });

  it("passes what the domain refuses back with its status, not a 500", async () => {
    fixture.create.mockRejectedValueOnce(Object.assign(new Error("Only an owner or admin can create an API key."), { status: 403 }));

    const response = await post({ name: "Reporting", scopes: ["calls:read"] });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "Only an owner or admin can create an API key." });
  });

  it("answers a body that isn't JSON with 400", async () => {
    const response = await POST(new Request(address, { method: "POST", body: "{" }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "invalid_json" });
    expect(fixture.create).not.toHaveBeenCalled();
  });
});
