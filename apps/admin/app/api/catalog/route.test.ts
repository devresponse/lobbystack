import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ create: vi.fn(async () => "service_1"), list: vi.fn(async () => ({ services: [] })) }));
vi.mock("@/lib/api-helpers", async (original) => ({
  ...await original<typeof import("@/lib/api-helpers")>(),
  requireApiSession: async () => ({ user: { id: "user_1" } }),
  requireOperatorBusiness: async () => ({ session: { user: { id: "user_1" } }, businessId: "business_1" }),
}));
vi.mock("@/lib/domain-context", () => ({ createDomainContext: () => ({ db: "app" }) }));
vi.mock("@lobbystack/domain", () => ({ createService: fixture.create, listCatalog: fixture.list }));

import { GET, POST } from "./route";

const post = (body: unknown) => POST(new Request("http://localhost:3000/api/catalog?businessId=business_1", { method: "POST", body: JSON.stringify(body) }));
const get = (query: string) => GET(new Request(`http://localhost:3000/api/catalog?businessId=business_1${query}`));
const service = { name: "Haircut", durationMinutes: 30 };

beforeEach(() => { vi.clearAllMocks(); });

describe("service catalog API", () => {
  it("creates a service and builds the web address part from its name", async () => {
    const response = await post({ ...service, name: " Deep Clean ", description: "Two rooms." });

    expect(response.status).toBe(201);
    expect(fixture.create).toHaveBeenCalledWith({ db: "app" }, { userId: "user_1", businessId: "business_1", name: "Deep Clean", slug: "deep-clean", durationMinutes: 30, description: "Two rooms." });
  });

  // AUDIT-007: these answered 500 "Request failed." with an error report before.
  it("answers a wrong field with 400 and says which one it is", async () => {
    for (const [body, field, message] of [
      [{ ...service, durationMinutes: 0 }, "durationMinutes", "The length must be at least a minute."],
      [{ ...service, durationMinutes: 1.5 }, "durationMinutes", "The length must be a whole number of minutes."],
      [{ ...service, name: "   " }, "name", "Give the service a name."],
      [{ ...service, active: "yes" }, "active", "active is true or false."],
      [{ ...service, description: "x".repeat(2_001) }, "description", "A description can be 2,000 characters at most."],
    ] as const) {
      const response = await post(body);
      expect(response.status, field).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: `${field}: ${message}`, code: "invalid_request", details: [{ path: field, message }] });
    }
    expect(fixture.create).not.toHaveBeenCalled();
  });

  it("reads a length sent as text, as the dashboard's number input gives it", async () => {
    await expect(post({ ...service, durationMinutes: "45" })).resolves.toHaveProperty("status", 201);
    expect(fixture.create).toHaveBeenCalledWith({ db: "app" }, expect.objectContaining({ durationMinutes: 45 }));
  });

  it("refuses a name with nothing to build a web address from", async () => {
    const response = await post({ ...service, name: "***" });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining("web address part") });
  });

  it("checks the search parameters, and treats an empty one as absent", async () => {
    await expect(get("&limit=abc")).resolves.toHaveProperty("status", 400);
    await expect(get("&offset=-1")).resolves.toHaveProperty("status", 400);
    expect(fixture.list).not.toHaveBeenCalled();

    await expect(get("&search=&limit=&offset=")).resolves.toHaveProperty("status", 200);
    expect(fixture.list).toHaveBeenCalledWith({ db: "app" }, { userId: "user_1", businessId: "business_1" });

    await expect(get("&search=hair&limit=5")).resolves.toHaveProperty("status", 200);
    expect(fixture.list).toHaveBeenLastCalledWith({ db: "app" }, { userId: "user_1", businessId: "business_1", search: "hair", limit: 5 });
  });
});
