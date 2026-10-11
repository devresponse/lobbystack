import { readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { apiOperations } from "@lobbystack/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const domain = vi.hoisted(() => ({
  resolveApiKey: vi.fn(),
  touchApiKeyLastUsed: vi.fn(async () => undefined),
  getAvailabilityForApi: vi.fn(),
  getCallForApi: vi.fn(),
  getContactForApi: vi.fn(),
  updateContactForApi: vi.fn(),
  cancelAppointmentForApi: vi.fn(),
  getWebhookEndpoint: vi.fn(),
  createWebhookEndpoint: vi.fn(),
  updateWebhookEndpoint: vi.fn(),
  listCallsForApi: vi.fn(async () => ({ data: [], next_cursor: null, has_more: false })),
  listContactsForApi: vi.fn(async () => ({ data: [], next_cursor: null, has_more: false })),
  listStaffForApi: vi.fn(),
  getMeForApi: vi.fn(),
  getPlatformMeForApi: vi.fn(),
  createBusinessForApi: vi.fn(),
  listBusinessesForApi: vi.fn(),
  updateBusinessForApi: vi.fn(),
  createKnowledgeSourceForApi: vi.fn(),
  expandKnowledgeSourceForApi: vi.fn(),
  retryKnowledgeSourceForApi: vi.fn(),
  cancelKnowledgeSourceForApi: vi.fn(),
  listAppointmentsForApi: vi.fn(),
  resolvePlatformKeyOwner: vi.fn(async () => "0b7c1d2e-3f40-4a51-8b62-7c83d94ea5b6"),
  requirePlatformBusinessAccess: vi.fn(async () => undefined),
}));

vi.mock("../domain-context", () => ({ createWorkerDomainContext: () => ({ db: {} }) }));
vi.mock("../error-reporting", () => ({ reportServerError: vi.fn() }));
vi.mock("@lobbystack/domain", async () => ({
  ...(await import("../../../../../packages/domain/src/server/publicApi/errors")),
  ...(await import("../../../../../packages/domain/src/server/publicApi/idempotency")),
  ...(await import("../../../../../packages/domain/src/server/publicApi/platformKeys")),
  bearerToken: (await import("../../../../../packages/domain/src/server/publicApi/apiKeys")).bearerToken,
  ...domain,
}));

import { generatePlatformKey } from "@lobbystack/domain";

import { v1 } from "./routes";

const apiRoot = fileURLToPath(new URL("../../../app/api/v1/", import.meta.url));
const everyScope = [...new Set(Object.values(apiOperations).flatMap((operation) => (operation.scope ? [operation.scope] : [])))];

function routeFiles(directory = apiRoot, prefix = ""): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const full = `${directory}${entry}`;
    if (statSync(full).isDirectory()) return routeFiles(`${full}/`, `${prefix}/${entry}`);
    return entry === "route.ts" && !prefix.includes("[...path]") ? [prefix] : [];
  });
}

function call(path: string, init: RequestInit = {}) {
  return new Request(`https://app.example.com/api/v1${path}`, { ...init, headers: { authorization: "Bearer lsk_12345678_abcdefghijklmnopqrstuvwxyzABCDEF", ...(init.headers ?? {}) } });
}

beforeEach(() => {
  vi.clearAllMocks();
  domain.resolveApiKey.mockResolvedValue({ businessId: "5d0bd9a4-7e1c-4a51-9a50-8e1b2c3d4e5f", apiKeyId: "0b7c1d2e-3f40-4a51-8b62-7c83d94ea5b6", scopes: everyScope });
});

describe("v1 method handling", () => {
  it("answers unsupported methods on every v1 route with a 405 v1 error and an Allow header", async () => {
    const routes = routeFiles();
    expect(routes.length).toBeGreaterThan(15);
    for (const route of routes) {
      const routeModule = await import(/* @vite-ignore */ `${apiRoot}${route.slice(1)}/route.ts`) as Record<string, unknown>;
      const supported = Object.values(apiOperations).filter((operation) => operation.path.replace(/\{([a-z_]+)\}/g, "[$1]") === route).map((operation) => operation.method as string);
      if (route === "/openapi.json") supported.push("GET");
      for (const method of ["GET", "POST", "PATCH", "PUT", "DELETE"]) {
        expect(typeof routeModule[method], `${method} ${route}`).toBe("function");
        if (supported.includes(method)) continue;
        const response = await (routeModule[method] as () => Response)();
        expect(response.status, `${method} ${route}`).toBe(405);
        expect(response.headers.get("allow")?.split(", ")).toEqual(expect.arrayContaining([...supported, "OPTIONS"]));
        expect(await response.json()).toEqual({ error: { code: "method_not_allowed", message: expect.any(String) } });
      }
    }
  });

  it("keeps PUT /contacts in the v1 error shape", async () => {
    const { PUT } = await import("../../../app/api/v1/contacts/route");
    const response = await PUT();
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, POST, HEAD, OPTIONS");
  });
});

describe("v1 UUID validation", () => {
  const badIds = ["------------------------------------", "not-a-uuid", "5d0bd9a4-7e1c-4a51-9a50-8e1b2c3d4e5", "5d0bd9a4-7e1c-4a51-9a50-8e1b2c3d4e5fz", "'; drop table calls; --"];

  it.each(badIds)("rejects service_id %j with 400 before any query", async (serviceId) => {
    const response = await v1.getAvailability(call(`/availability?service_id=${encodeURIComponent(serviceId)}&start_date=2026-09-29`));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "invalid_request", message: "service_id must be a UUID.", details: [{ path: "service_id", message: "Must be a UUID." }] } });
    expect(domain.getAvailabilityForApi).not.toHaveBeenCalled();
  });

  it("requires service_id", async () => {
    const response = await v1.getAvailability(call("/availability?start_date=2026-09-29"));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_request", details: [{ path: "service_id", message: "Required." }] } });
  });

  it.each([
    ["call_id", () => v1.getCall(call("/calls/x"), { params: Promise.resolve({ call_id: "------------------------------------" }) }), domain.getCallForApi],
    ["contact_id", () => v1.getContact(call("/contacts/x"), { params: Promise.resolve({ contact_id: "123" }) }), domain.getContactForApi],
    ["contact_id", () => v1.updateContact(call("/contacts/x", { method: "PATCH", body: "{\"name\":\"A\"}" }), { params: Promise.resolve({ contact_id: "123" }) }), domain.updateContactForApi],
    ["appointment_id", () => v1.cancelAppointment(call("/appointments/x/cancel", { method: "POST" }), { params: Promise.resolve({ appointment_id: "abc" }) }), domain.cancelAppointmentForApi],
    ["webhook_id", () => v1.getWebhook(call("/webhooks/x"), { params: Promise.resolve({ webhook_id: "abc" }) }), domain.getWebhookEndpoint],
  ] as const)("rejects a malformed %s path id with 400", async (name, run, handler) => {
    const response = await run();
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_request", message: `${name} must be a UUID.` } });
    expect(handler).not.toHaveBeenCalled();
  });

  it("passes a valid UUID through", async () => {
    domain.getCallForApi.mockResolvedValue({ id: "5d0bd9a4-7e1c-4a51-9a50-8e1b2c3d4e5f" });
    const response = await v1.getCall(call("/calls/x"), { params: Promise.resolve({ call_id: "5D0BD9A4-7E1C-4A51-9A50-8E1B2C3D4E5F" }) });
    expect(response.status).toBe(200);
  });
});

describe("v1 list filters", () => {
  it("passes the call start-time range to the domain", async () => {
    const response = await v1.listCalls(call(`/calls?started_after=${encodeURIComponent("2026-09-26T00:00:00-04:00")}&started_before=2026-09-27T04:00:00Z&limit=10`));
    expect(response.status).toBe(200);
    expect(domain.listCallsForApi).toHaveBeenCalledWith(expect.anything(), expect.anything(), { limit: 10, startedAfter: new Date("2026-09-26T04:00:00.000Z"), startedBefore: new Date("2026-09-27T04:00:00.000Z") });
  });

  it("rejects a start time that is not a timestamp", async () => {
    const response = await v1.listCalls(call("/calls?started_after=yesterday"));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_request", message: "started_after must be an ISO 8601 timestamp." } });
    expect(domain.listCallsForApi).not.toHaveBeenCalled();
  });

  it("passes a trimmed name search to the domain and ignores an empty one", async () => {
    await v1.listContacts(call("/contacts?name=%20whit%20"));
    expect(domain.listContactsForApi).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ name: "whit" }));
    await v1.listContacts(call("/contacts?name=%20%20"));
    expect(domain.listContactsForApi).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ name: undefined }));
  });

  it("limits the name search to 200 characters", async () => {
    const response = await v1.listContacts(call(`/contacts?name=${"a".repeat(201)}`));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_request", details: [{ path: "name" }] } });
  });

  it("documents the new filters in the contract", () => {
    expect(apiOperations.listCalls.params.map((param) => param.name)).toEqual(expect.arrayContaining(["started_after", "started_before"]));
    expect(apiOperations.listContacts.params.map((param) => param.name)).toContain("name");
  });
});

describe("GET /staff", () => {
  it("requires business:read", async () => {
    domain.resolveApiKey.mockResolvedValue({ businessId: "5d0bd9a4-7e1c-4a51-9a50-8e1b2c3d4e5f", apiKeyId: "0b7c1d2e-3f40-4a51-8b62-7c83d94ea5b6", scopes: ["appointments:write"] });
    const response = await v1.listStaff(call("/staff"));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "insufficient_scope", message: expect.stringContaining("business:read") } });
    expect(domain.listStaffForApi).not.toHaveBeenCalled();
  });

  it("returns every staff member on one page, scoped to the key's business", async () => {
    const member = { id: "06d9c0dc-f18a-4cc6-a987-ac4963c87113", name: "Sam", active: true, timezone: "UTC", service_ids: [], created_at: "2026-09-27T12:00:00.000Z", updated_at: "2026-09-27T12:00:00.000Z" };
    domain.listStaffForApi.mockResolvedValue([member]);
    const response = await v1.listStaff(call("/staff"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: [member], next_cursor: null, has_more: false });
    expect(domain.listStaffForApi).toHaveBeenCalledWith(expect.anything(), { businessId: "5d0bd9a4-7e1c-4a51-9a50-8e1b2c3d4e5f", apiKeyId: "0b7c1d2e-3f40-4a51-8b62-7c83d94ea5b6" });
  });

  it("rejects a malformed staff_id on GET /availability with 400", async () => {
    const response = await v1.getAvailability(call("/availability?service_id=5d0bd9a4-7e1c-4a51-9a50-8e1b2c3d4e5f&start_date=2026-09-29&staff_id=nope"));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_request", message: "staff_id must be a UUID." } });
    expect(domain.getAvailabilityForApi).not.toHaveBeenCalled();
  });
});

describe("knowledge sources", () => {
  const sourceId = "06d9c0dc-f18a-4cc6-a987-ac4963c87113";
  const source = { id: sourceId, type: "website", title: "https://maple.example/", url: "https://maple.example/", status: "processing", error: null, active: true, page_limit: 10, created_at: "2026-10-11T12:00:00.000Z", updated_at: "2026-10-11T12:00:00.000Z" };

  it("starts reading a website and answers 202 with the source", async () => {
    domain.createKnowledgeSourceForApi.mockResolvedValue(source);
    const response = await v1.createKnowledgeSource(call("/knowledge/sources", { method: "POST", body: JSON.stringify({ type: "website", url: " maple.example " }) }));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ data: source });
    expect(domain.createKnowledgeSourceForApi).toHaveBeenCalledWith(expect.anything(), expect.anything(), { type: "website", url: "maple.example" });
  });

  it("takes only websites for now", async () => {
    const response = await v1.createKnowledgeSource(call("/knowledge/sources", { method: "POST", body: JSON.stringify({ type: "file", url: "https://maple.example" }) }));
    expect(response.status).toBe(400);
    expect(domain.createKnowledgeSourceForApi).not.toHaveBeenCalled();
  });

  it.each([
    ["expand", () => v1.expandKnowledgeSource, () => domain.expandKnowledgeSourceForApi, 202],
    ["retry", () => v1.retryKnowledgeSource, () => domain.retryKnowledgeSourceForApi, 202],
    ["cancel", () => v1.cancelKnowledgeSource, () => domain.cancelKnowledgeSourceForApi, 200],
  ] as const)("%s passes the source id to the domain", async (action, route, operation, status) => {
    operation().mockResolvedValue(source);
    const response = await route()(call(`/knowledge/sources/${sourceId}/${action}`, { method: "POST" }), { params: Promise.resolve({ source_id: sourceId }) });
    expect(response.status).toBe(status);
    expect(operation()).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ businessId: "5d0bd9a4-7e1c-4a51-9a50-8e1b2c3d4e5f" }), sourceId);
    const malformed = await route()(call("/knowledge/sources/x/expand", { method: "POST" }), { params: Promise.resolve({ source_id: "x" }) });
    expect(malformed.status).toBe(400);
  });

  it("needs knowledge:write", async () => {
    domain.resolveApiKey.mockResolvedValue({ businessId: "5d0bd9a4-7e1c-4a51-9a50-8e1b2c3d4e5f", apiKeyId: "0b7c1d2e-3f40-4a51-8b62-7c83d94ea5b6", scopes: ["business:read"] });
    const response = await v1.expandKnowledgeSource(call(`/knowledge/sources/${sourceId}/expand`, { method: "POST" }), { params: Promise.resolve({ source_id: sourceId }) });
    expect(response.status).toBe(403);
    expect(domain.expandKnowledgeSourceForApi).not.toHaveBeenCalled();
  });
});

describe("PATCH /business", () => {
  it("passes the business type through with the other fields", async () => {
    domain.updateBusinessForApi.mockResolvedValue({});
    const response = await v1.updateBusiness(call("/business", { method: "PATCH", body: JSON.stringify({ business_type: " dental_clinic ", locale: "fr" }) }));
    expect(response.status).toBe(200);
    expect(domain.updateBusinessForApi).toHaveBeenCalledWith(expect.anything(), expect.anything(), { business_type: "dental_clinic", locale: "fr" });
  });

  it("refuses an empty business type", async () => {
    const response = await v1.updateBusiness(call("/business", { method: "PATCH", body: JSON.stringify({ business_type: "  " }) }));
    expect(response.status).toBe(400);
    expect(domain.updateBusinessForApi).not.toHaveBeenCalled();
  });
});

describe("GET /me", () => {
  const me = { api_key: { id: "0b7c1d2e-3f40-4a51-8b62-7c83d94ea5b6", name: "Zapier", prefix: "lsk_1a2b3c4d", scopes: ["knowledge:write"], created_at: "2026-09-27T12:00:00.000Z" }, business: { id: "5d0bd9a4-7e1c-4a51-9a50-8e1b2c3d4e5f", name: "Maple Salon" } };

  it("works for a key with a single unrelated scope", async () => {
    domain.resolveApiKey.mockResolvedValue({ businessId: me.business.id, apiKeyId: me.api_key.id, scopes: ["knowledge:write"] });
    domain.getMeForApi.mockResolvedValue(me);
    const response = await v1.getMe(call("/me"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: me });
  });

  it("returns 401 for a revoked key", async () => {
    domain.resolveApiKey.mockResolvedValue(null);
    const response = await v1.getMe(call("/me"));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "unauthorized" } });
    expect(domain.getMeForApi).not.toHaveBeenCalled();
  });
});

describe("GET /appointments?contact_id", () => {
  it("passes a valid contact_id to the query with the other filters", async () => {
    domain.listAppointmentsForApi.mockResolvedValue({ data: [], next_cursor: null, has_more: false });
    const response = await v1.listAppointments(call("/appointments?contact_id=0cabb07b-ea18-4e9f-8f7b-356405838770&status=confirmed&starts_after=2026-09-01T00:00:00Z&limit=10"));
    expect(response.status).toBe(200);
    expect(domain.listAppointmentsForApi).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ contactId: "0cabb07b-ea18-4e9f-8f7b-356405838770", status: "confirmed", limit: 10, startsAfter: new Date("2026-09-01T00:00:00Z") }));
  });

  it("rejects a malformed contact_id with 400", async () => {
    const response = await v1.listAppointments(call("/appointments?contact_id=abc"));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_request", message: "contact_id must be a UUID." } });
    expect(domain.listAppointmentsForApi).not.toHaveBeenCalled();
  });
});

describe("webhook event scopes", () => {
  const businessId = "5d0bd9a4-7e1c-4a51-9a50-8e1b2c3d4e5f";
  const apiKeyId = "0b7c1d2e-3f40-4a51-8b62-7c83d94ea5b6";
  const endpointId = "06d9c0dc-f18a-4cc6-a987-ac4963c87113";
  const endpoint = { id: endpointId, url: "https://hooks.example.com/a", description: null, events: ["call.completed"], status: "enabled", disabled_reason: null, created_at: "2026-09-27T12:00:00.000Z", updated_at: "2026-09-27T12:00:00.000Z" };
  const post = (events: string[]) => v1.createWebhook(call("/webhooks", { method: "POST", body: JSON.stringify({ url: "https://vendor.example.com/h", events }) }));
  const patch = (body: Record<string, unknown>) => v1.updateWebhook(call("/webhooks/x", { method: "PATCH", body: JSON.stringify(body) }), { params: Promise.resolve({ webhook_id: endpointId }) });

  it("rejects a webhooks:manage-only key subscribing to events it cannot read", async () => {
    domain.resolveApiKey.mockResolvedValue({ businessId, apiKeyId, scopes: ["webhooks:manage"] });
    const response = await post(["call.completed", "message.taken"]);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "insufficient_scope", message: expect.stringContaining("calls:read, messages:read") } });
    expect(domain.createWebhookEndpoint).not.toHaveBeenCalled();
  });

  it("creates the endpoint when the key has the read scope", async () => {
    domain.resolveApiKey.mockResolvedValue({ businessId, apiKeyId, scopes: ["webhooks:manage", "calls:read"] });
    domain.createWebhookEndpoint.mockResolvedValue({ endpoint, secret: "whsec_x" });
    const response = await post(["call.completed"]);
    expect(response.status).toBe(201);
  });

  it("rejects moving an endpoint's url when the key cannot read its events", async () => {
    domain.resolveApiKey.mockResolvedValue({ businessId, apiKeyId, scopes: ["webhooks:manage"] });
    domain.getWebhookEndpoint.mockResolvedValue(endpoint);
    const response = await patch({ url: "https://vendor.example.com/h" });
    expect(response.status).toBe(403);
    expect(domain.updateWebhookEndpoint).not.toHaveBeenCalled();
  });

  it("lets the key change only the description without the read scope", async () => {
    domain.resolveApiKey.mockResolvedValue({ businessId, apiKeyId, scopes: ["webhooks:manage"] });
    domain.updateWebhookEndpoint.mockResolvedValue(endpoint);
    const response = await patch({ description: "Renamed" });
    expect(response.status).toBe(200);
    expect(domain.getWebhookEndpoint).not.toHaveBeenCalled();
  });
});

describe("platform keys on v1 routes", () => {
  const businessId = "9e8d7c6b-5a49-4382-a716-1f2e3d4c5b6a";
  const ownerId = "0b7c1d2e-3f40-4a51-8b62-7c83d94ea5b6";
  const { key, entry } = generatePlatformKey({ name: "AlloPlace CLI", partner: "alloplace", ownerEmail: "ops@alloplace.example", access: "all" });
  const platformCall = (path: string, init: RequestInit = {}) => new Request(`https://app.example.com/api/v1${path}`, { ...init, headers: { authorization: `Bearer ${key}`, ...(init.headers ?? {}) } });

  beforeEach(() => { vi.stubEnv("PLATFORM_API_KEYS", JSON.stringify([entry])); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("answers GET /me without a business, showing the key's partner and access", async () => {
    const me = { api_key: { id: entry.id, name: "AlloPlace CLI", prefix: entry.prefix, scopes: [], created_at: entry.created_at }, business: null, platform: { partner: "alloplace", access: "all" } };
    domain.getPlatformMeForApi.mockResolvedValue(me);
    const response = await v1.getMe(platformCall("/me"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: me });
    expect(domain.getPlatformMeForApi).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ kind: "platform_key", platformKeyId: entry.id, partnerId: "alloplace", access: "all" }), null);
    expect(domain.resolveApiKey).not.toHaveBeenCalled();
    expect(domain.requirePlatformBusinessAccess).not.toHaveBeenCalled();
  });

  it("passes the header's business to GET /me", async () => {
    domain.getPlatformMeForApi.mockResolvedValue({});
    const response = await v1.getMe(platformCall("/me", { headers: { "LobbyStack-Business": businessId } }));
    expect(response.status).toBe(200);
    expect(domain.requirePlatformBusinessAccess).toHaveBeenCalledWith(expect.anything(), { businessId, partnerId: "alloplace", access: "all" });
    expect(domain.getPlatformMeForApi).toHaveBeenCalledWith(expect.anything(), expect.anything(), { businessId, platformKeyId: entry.id, partnerId: "alloplace", actingUserId: ownerId, actor: "platform_key" });
  });

  it("acts on the header's business on every other route", async () => {
    const response = await v1.listStaff(platformCall("/staff", { headers: { "LobbyStack-Business": businessId } }));
    expect(response.status).toBe(200);
    expect(domain.listStaffForApi).toHaveBeenCalledWith(expect.anything(), { businessId, platformKeyId: entry.id, partnerId: "alloplace", actingUserId: ownerId, actor: "platform_key" });
    const missing = await v1.listStaff(platformCall("/staff"));
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ error: { code: "business_required" } });
  });

  it("manages webhooks as the platform key, not as an api_keys row", async () => {
    const endpoint = { id: "06d9c0dc-f18a-4cc6-a987-ac4963c87113", url: "https://hooks.example.com/a", description: null, events: ["call.completed"], status: "enabled", disabled_reason: null, created_at: "2026-09-27T12:00:00.000Z", updated_at: "2026-09-27T12:00:00.000Z" };
    domain.createWebhookEndpoint.mockResolvedValue({ endpoint, secret: "whsec_x" });
    const response = await v1.createWebhook(platformCall("/webhooks", { method: "POST", headers: { "LobbyStack-Business": businessId }, body: JSON.stringify({ url: "https://vendor.example.com/h", events: ["call.completed"] }) }));
    expect(response.status).toBe(201);
    expect(domain.createWebhookEndpoint).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ businessId, manager: { kind: "platform_key", platformKeyId: entry.id, partnerId: "alloplace", actingUserId: ownerId } }));
  });

  it("refuses a platform key that is not configured", async () => {
    vi.stubEnv("PLATFORM_API_KEYS", "");
    const response = await v1.getMe(platformCall("/me"));
    expect(response.status).toBe(401);
    expect(domain.getPlatformMeForApi).not.toHaveBeenCalled();
  });

  describe("POST /businesses", () => {
    const business = { id: "3f2a9c1e-5b7d-8e8a-9c21-7d4e5f6a8b90", name: "Acme Plumbing", timezone: "America/Toronto", locale: "en", website_url: null, business_type: "service_company", onboarding_stage: "website", booking_mode: "request", hours: [], created_at: "2026-10-11T21:00:00.000Z", updated_at: "2026-10-11T21:00:00.000Z" };
    const post = (body: unknown, headers: Record<string, string> = { "Idempotency-Key": "onboard-acme" }) => v1.createBusiness(platformCall("/businesses", { method: "POST", headers, body: JSON.stringify(body) }));

    it("creates the business as the key's owner, keyed by the Idempotency-Key", async () => {
      domain.createBusinessForApi.mockResolvedValue({ business, replayed: false });
      const response = await post({ name: " Acme Plumbing ", timezone: "America/Toronto" });
      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({ data: business });
      expect(response.headers.get("idempotent-replayed")).toBeNull();
      expect(domain.createBusinessForApi).toHaveBeenCalledWith(expect.anything(), {
        key: expect.objectContaining({ kind: "platform_key", platformKeyId: entry.id, partnerId: "alloplace" }),
        actingUserId: ownerId,
        idempotencyKey: "onboard-acme",
        requestHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        body: { name: "Acme Plumbing", timezone: "America/Toronto" },
      });
    });

    it("marks a replayed creation", async () => {
      domain.createBusinessForApi.mockResolvedValue({ business, replayed: true });
      const response = await post({ name: "Acme Plumbing", timezone: "America/Toronto" });
      expect(response.status).toBe(201);
      expect(response.headers.get("idempotent-replayed")).toBe("true");
    });

    it("hashes the same request the same way, whatever its key order or spacing", async () => {
      domain.createBusinessForApi.mockResolvedValue({ business, replayed: false });
      await post({ name: "Acme Plumbing", timezone: "America/Toronto", locale: "fr" });
      await post({ locale: "fr", timezone: "America/Toronto", name: "  Acme Plumbing" });
      const [first, second] = domain.createBusinessForApi.mock.calls.map(([, input]) => (input as { requestHash: string }).requestHash);
      expect(second).toBe(first);
    });

    it("validates the body before creating anything", async () => {
      const response = await post({ name: "Acme", timezone: "America/Toronto", owner: "someone" });
      expect(response.status).toBe(400);
      expect(domain.createBusinessForApi).not.toHaveBeenCalled();
    });

    it("refuses a request without an Idempotency-Key", async () => {
      const response = await post({ name: "Acme", timezone: "America/Toronto" }, {});
      expect(response.status).toBe(400);
      expect(domain.createBusinessForApi).not.toHaveBeenCalled();
    });

    it("refuses a per-business key", async () => {
      const response = await v1.createBusiness(call("/businesses", { method: "POST", headers: { "Idempotency-Key": "k" }, body: JSON.stringify({ name: "Acme", timezone: "UTC" }) }));
      expect(response.status).toBe(403);
      expect(domain.createBusinessForApi).not.toHaveBeenCalled();
    });
  });

  it("lists the businesses the key's partner onboarded, a page at a time", async () => {
    domain.listBusinessesForApi.mockResolvedValue({ data: [], next_cursor: null, has_more: false });
    const response = await v1.listBusinesses(platformCall("/businesses?limit=10&cursor=abc"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: [], next_cursor: null, has_more: false });
    expect(domain.listBusinessesForApi).toHaveBeenCalledWith(expect.anything(), { partnerId: "alloplace", limit: 10, cursor: "abc" });
  });
});
