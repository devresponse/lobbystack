import { readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { apiOperations } from "@lobbystack/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const storageProvider = vi.hoisted(() => ({ name: "storage" }));
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
  createKnowledgeUploadForApi: vi.fn(),
  completeKnowledgeUploadForApi: vi.fn(),
  listKnowledgeSourcesForApi: vi.fn(),
  getKnowledgeSourceForApi: vi.fn(),
  updateKnowledgeSourceForApi: vi.fn(),
  deleteKnowledgeSourceForApi: vi.fn(async () => undefined),
  listServicesForApi: vi.fn(async () => []),
  createServiceForApi: vi.fn(),
  updateServiceForApi: vi.fn(),
  deleteServiceForApi: vi.fn(async () => undefined),
  getBillingForApi: vi.fn(),
  updateBillingForApi: vi.fn(),
  createCheckoutForApi: vi.fn(),
  getCheckoutForApi: vi.fn(),
  setManagedPlanForApi: vi.fn(),
  endManagedPlanForApi: vi.fn(),
  listRulesForApi: vi.fn(async (): Promise<unknown[]> => []),
  createRuleForApi: vi.fn(),
  updateRuleForApi: vi.fn(),
  deleteRuleForApi: vi.fn(async () => undefined),
  reorderRulesForApi: vi.fn(async (): Promise<unknown[]> => []),
  getReceptionistForApi: vi.fn(),
  updateReceptionistForApi: vi.fn(),
  listKnowledgeEntriesForApi: vi.fn(),
  getKnowledgeEntryForApi: vi.fn(),
  updateKnowledgeEntryForApi: vi.fn(),
  deleteKnowledgeEntryForApi: vi.fn(async () => undefined),
  listAppointmentsForApi: vi.fn(),
  resolvePlatformKeyOwner: vi.fn(async () => "0b7c1d2e-3f40-4a51-8b62-7c83d94ea5b6"),
  requirePlatformBusinessAccess: vi.fn(async () => undefined),
  resolveActingUserId: vi.fn(async () => "6a1f0c2d-8e3b-4c5d-9e6f-7a8b9c0d1e2f"),
  listPhoneNumbersForApi: vi.fn(async (): Promise<unknown[]> => []),
  searchPhoneNumbersForApi: vi.fn(async (..._args: unknown[]): Promise<unknown[]> => []),
  claimPhoneNumberForApi: vi.fn(),
  getPhoneNumberClaimForApi: vi.fn(),
  releasePhoneNumberForApi: vi.fn(),
  // Requests with an Idempotency-Key run the handler once, as the real store does for a new key.
  runIdempotent: vi.fn(async (context: unknown, _scope: unknown, _hash: string, run: (transactional: unknown) => Promise<{ status: number; body: unknown }>) => ({ replayed: false, response: await run(context) })),
}));
const numbers = vi.hoisted(() => ({
  provider: { listAvailablePhoneNumbers: vi.fn() },
  searchLimit: vi.fn(async (): Promise<{ allowed: true } | { allowed: false; status: 429 | 503; reason: string }> => ({ allowed: true })),
}));

vi.mock("../domain-context", () => ({ createWorkerDomainContext: () => ({ db: {} }) }));
vi.mock("../error-reporting", () => ({ reportServerError: vi.fn() }));
vi.mock("../storage", () => ({ getStorageProvider: () => storageProvider }));
vi.mock("../twilio-provider", () => ({ getTwilioProvider: () => numbers.provider, getNumberClaimTokenSecret: () => "number-claim-secret" }));
vi.mock("../phone-number-search-limit", () => ({ checkPhoneNumberSearchLimit: numbers.searchLimit }));
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

  it("reserves an upload with the storage provider and checks the request first", async () => {
    const upload = { upload_id: sourceId, upload_url: "https://storage.example/put", upload_headers: { "content-type": "application/pdf" }, expires_at: "2026-10-11T12:15:00.000Z" };
    domain.createKnowledgeUploadForApi.mockResolvedValue(upload);
    const body = { file_name: "prices.pdf", content_type: "application/pdf", length: 2048, checksum_sha256: `${"A".repeat(43)}=` };
    const response = await v1.createKnowledgeUpload(call("/knowledge/uploads", { method: "POST", body: JSON.stringify(body) }));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ data: upload });
    expect(domain.createKnowledgeUploadForApi).toHaveBeenCalledWith(expect.anything(), expect.anything(), body, storageProvider);
    for (const bad of [{ ...body, content_type: "application/zip" }, { ...body, length: 10 * 1024 * 1024 + 1 }, { ...body, checksum_sha256: "nope" }, { ...body, file_name: ".." }]) {
      expect((await v1.createKnowledgeUpload(call("/knowledge/uploads", { method: "POST", body: JSON.stringify(bad) }))).status).toBe(400);
    }
    expect(domain.createKnowledgeUploadForApi).toHaveBeenCalledTimes(1);
  });

  it("completes an upload by its id and answers 202 with the file source", async () => {
    domain.completeKnowledgeUploadForApi.mockResolvedValue({ ...source, type: "file", url: null, page_limit: null, status: "pending" });
    const response = await v1.completeKnowledgeUpload(call(`/knowledge/uploads/${sourceId}/complete`, { method: "POST", body: JSON.stringify({ title: "Price list" }) }), { params: Promise.resolve({ upload_id: sourceId }) });
    expect(response.status).toBe(202);
    expect(domain.completeKnowledgeUploadForApi).toHaveBeenCalledWith(expect.anything(), expect.anything(), sourceId, { title: "Price list" }, storageProvider);
    const malformed = await v1.completeKnowledgeUpload(call("/knowledge/uploads/x/complete", { method: "POST", body: "{}" }), { params: Promise.resolve({ upload_id: "x" }) });
    expect(malformed.status).toBe(400);
  });

  it("needs knowledge:write", async () => {
    domain.resolveApiKey.mockResolvedValue({ businessId: "5d0bd9a4-7e1c-4a51-9a50-8e1b2c3d4e5f", apiKeyId: "0b7c1d2e-3f40-4a51-8b62-7c83d94ea5b6", scopes: ["business:read"] });
    const response = await v1.expandKnowledgeSource(call(`/knowledge/sources/${sourceId}/expand`, { method: "POST" }), { params: Promise.resolve({ source_id: sourceId }) });
    expect(response.status).toBe(403);
    expect(domain.expandKnowledgeSourceForApi).not.toHaveBeenCalled();
  });

  it("lists sources by type and status, and refuses values it doesn't know", async () => {
    domain.listKnowledgeSourcesForApi.mockResolvedValue({ data: [source], next_cursor: null, has_more: false });
    const response = await v1.listKnowledgeSources(call("/knowledge/sources?type=page&status=indexed"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: [source], next_cursor: null, has_more: false });
    expect(domain.listKnowledgeSourcesForApi).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ type: "page", status: "indexed" }));
    expect((await v1.listKnowledgeSources(call("/knowledge/sources?type=video"))).status).toBe(400);
    expect((await v1.listKnowledgeSources(call("/knowledge/sources?status=done"))).status).toBe(400);
    expect(domain.listKnowledgeSourcesForApi).toHaveBeenCalledTimes(1);
  });

  it("reads, turns off and deletes a source by its id", async () => {
    const params = { params: Promise.resolve({ source_id: sourceId }) };
    domain.getKnowledgeSourceForApi.mockResolvedValue(source);
    expect(await (await v1.getKnowledgeSource(call(`/knowledge/sources/${sourceId}`), params)).json()).toEqual({ data: source });
    domain.updateKnowledgeSourceForApi.mockResolvedValue({ ...source, active: false });
    const updated = await v1.updateKnowledgeSource(call(`/knowledge/sources/${sourceId}`, { method: "PATCH", body: JSON.stringify({ active: false }) }), { params: Promise.resolve({ source_id: sourceId }) });
    expect(updated.status).toBe(200);
    expect(domain.updateKnowledgeSourceForApi).toHaveBeenCalledWith(expect.anything(), expect.anything(), sourceId, { active: false });
    // Only active can change on a source.
    for (const bad of [{ title: "Prices" }, {}]) {
      expect((await v1.updateKnowledgeSource(call(`/knowledge/sources/${sourceId}`, { method: "PATCH", body: JSON.stringify(bad) }), { params: Promise.resolve({ source_id: sourceId }) })).status).toBe(400);
    }
    const deleted = await v1.deleteKnowledgeSource(call(`/knowledge/sources/${sourceId}`, { method: "DELETE" }), { params: Promise.resolve({ source_id: sourceId }) });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ data: { id: sourceId, deleted: true } });
    expect(domain.deleteKnowledgeSourceForApi).toHaveBeenCalledWith(expect.anything(), expect.anything(), sourceId);
  });
});

describe("knowledge entries", () => {
  const entryId = "3f0f6f2e-7c1a-4b8e-9a5d-2c3b4a5d6e7f";
  const entry = { id: entryId, type: "faq", title: "Do you park?", content: "Behind the building.", tags: [], priority: 0, active: true, created_at: "2026-10-11T12:00:00.000Z", updated_at: "2026-10-11T12:00:00.000Z" };
  const params = () => ({ params: Promise.resolve({ entry_id: entryId }) });

  it("lists entries by type", async () => {
    domain.listKnowledgeEntriesForApi.mockResolvedValue({ data: [entry], next_cursor: null, has_more: false });
    const response = await v1.listKnowledgeEntries(call("/knowledge?type=faq"));
    expect(response.status).toBe(200);
    expect(domain.listKnowledgeEntriesForApi).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ type: "faq" }));
    expect((await v1.listKnowledgeEntries(call("/knowledge?type=website"))).status).toBe(400);
  });

  it("edits the fields sent and checks them first", async () => {
    domain.updateKnowledgeEntryForApi.mockResolvedValue({ ...entry, title: "Is there parking?", priority: 5 });
    const response = await v1.updateKnowledgeEntry(call(`/knowledge/${entryId}`, { method: "PATCH", body: JSON.stringify({ title: " Is there parking? ", priority: 5, tags: ["parking"] }) }), params());
    expect(response.status).toBe(200);
    expect(domain.updateKnowledgeEntryForApi).toHaveBeenCalledWith(expect.anything(), expect.anything(), entryId, { title: "Is there parking?", priority: 5, tags: ["parking"] });
    for (const bad of [{ title: "" }, { priority: 101 }, { priority: 1.5 }, { type: "text" }, { question: "Parking?" }]) {
      expect((await v1.updateKnowledgeEntry(call(`/knowledge/${entryId}`, { method: "PATCH", body: JSON.stringify(bad) }), params())).status).toBe(400);
    }
    expect(domain.updateKnowledgeEntryForApi).toHaveBeenCalledTimes(1);
  });

  it("reads and deletes an entry by its id", async () => {
    domain.getKnowledgeEntryForApi.mockResolvedValue(entry);
    expect(await (await v1.getKnowledgeEntry(call(`/knowledge/${entryId}`), params())).json()).toEqual({ data: entry });
    const deleted = await v1.deleteKnowledgeEntry(call(`/knowledge/${entryId}`, { method: "DELETE" }), params());
    expect(await deleted.json()).toEqual({ data: { id: entryId, deleted: true } });
    expect((await v1.getKnowledgeEntry(call("/knowledge/sources"), { params: Promise.resolve({ entry_id: "sources" }) })).status).toBe(400);
  });

  it("refuses a malformed id before it reaches the domain", async () => {
    const entry = () => ({ params: Promise.resolve({ entry_id: "x" }) });
    const source = () => ({ params: Promise.resolve({ source_id: "x" }) });
    expect((await v1.updateKnowledgeEntry(call("/knowledge/x", { method: "PATCH", body: JSON.stringify({ active: true }) }), entry())).status).toBe(400);
    expect((await v1.deleteKnowledgeEntry(call("/knowledge/x", { method: "DELETE" }), entry())).status).toBe(400);
    expect((await v1.getKnowledgeSource(call("/knowledge/sources/x"), source())).status).toBe(400);
    expect((await v1.updateKnowledgeSource(call("/knowledge/sources/x", { method: "PATCH", body: JSON.stringify({ active: true }) }), source())).status).toBe(400);
    expect((await v1.deleteKnowledgeSource(call("/knowledge/sources/x", { method: "DELETE" }), source())).status).toBe(400);
    for (const operation of [domain.updateKnowledgeEntryForApi, domain.deleteKnowledgeEntryForApi, domain.getKnowledgeSourceForApi, domain.updateKnowledgeSourceForApi, domain.deleteKnowledgeSourceForApi]) expect(operation).not.toHaveBeenCalled();
  });

  it("needs knowledge:read to read and knowledge:write to change", async () => {
    domain.resolveApiKey.mockResolvedValue({ businessId: "5d0bd9a4-7e1c-4a51-9a50-8e1b2c3d4e5f", apiKeyId: "0b7c1d2e-3f40-4a51-8b62-7c83d94ea5b6", scopes: ["knowledge:write"] });
    expect((await v1.listKnowledgeEntries(call("/knowledge"))).status).toBe(403);
    expect((await v1.getKnowledgeSource(call(`/knowledge/sources/${entryId}`), { params: Promise.resolve({ source_id: entryId }) })).status).toBe(403);
    domain.resolveApiKey.mockResolvedValue({ businessId: "5d0bd9a4-7e1c-4a51-9a50-8e1b2c3d4e5f", apiKeyId: "0b7c1d2e-3f40-4a51-8b62-7c83d94ea5b6", scopes: ["knowledge:read"] });
    expect((await v1.deleteKnowledgeEntry(call(`/knowledge/${entryId}`, { method: "DELETE" }), params())).status).toBe(403);
    expect(domain.listKnowledgeEntriesForApi).not.toHaveBeenCalled();
    expect(domain.getKnowledgeSourceForApi).not.toHaveBeenCalled();
    expect(domain.deleteKnowledgeEntryForApi).not.toHaveBeenCalled();
  });
});

describe("services", () => {
  const serviceId = "3f0f6f2e-7c1a-4b8e-9a5d-2c3b4a5d6e7f";
  const staffId = "0b7c1d2e-3f40-4a51-8b62-7c83d94ea5b6";
  const service = { id: serviceId, name: "Cut", slug: "cut", description: null, duration_minutes: 30, active: true, staff_ids: [], created_at: "2026-10-11T12:00:00.000Z", updated_at: "2026-10-11T12:00:00.000Z" };
  const params = (id = serviceId) => ({ params: Promise.resolve({ service_id: id }) });

  it("lists turned-off services only when asked", async () => {
    expect((await v1.listServices(call("/services"))).status).toBe(200);
    expect(domain.listServicesForApi).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), { includeInactive: undefined });
    await v1.listServices(call("/services?include_inactive=true"));
    expect(domain.listServicesForApi).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), { includeInactive: true });
    await v1.listServices(call("/services?include_inactive=false"));
    expect(domain.listServicesForApi).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), { includeInactive: false });
    expect((await v1.listServices(call("/services?include_inactive=yes"))).status).toBe(400);
  });

  it("adds a service with checked fields and answers 201", async () => {
    domain.createServiceForApi.mockResolvedValue(service);
    const response = await v1.createService(call("/services", { method: "POST", body: JSON.stringify({ name: " Cut ", slug: " Cut ", duration_minutes: 30, staff_ids: [staffId] }) }));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ data: service });
    expect(domain.createServiceForApi).toHaveBeenCalledWith(expect.anything(), expect.anything(), { name: "Cut", slug: "cut", duration_minutes: 30, staff_ids: [staffId] });
    for (const bad of [{ name: "Cut" }, { name: "Cut", duration_minutes: 0 }, { name: "Cut", duration_minutes: 1_441 }, { name: "Cut", duration_minutes: 30.5 }, { name: "", duration_minutes: 30 }, { name: "Cut", duration_minutes: 30, slug: "cut here" }, { name: "Cut", duration_minutes: 30, staff_ids: ["x"] }, { name: "Cut", duration_minutes: 30, price: 10 }]) {
      expect((await v1.createService(call("/services", { method: "POST", body: JSON.stringify(bad) }))).status, JSON.stringify(bad)).toBe(400);
    }
    expect(domain.createServiceForApi).toHaveBeenCalledTimes(1);
  });

  it("changes and deletes a service by its id", async () => {
    domain.updateServiceForApi.mockResolvedValue({ ...service, active: false });
    const updated = await v1.updateService(call(`/services/${serviceId}`, { method: "PATCH", body: JSON.stringify({ active: false, description: null }) }), params());
    expect(updated.status).toBe(200);
    expect(domain.updateServiceForApi).toHaveBeenCalledWith(expect.anything(), expect.anything(), serviceId, { active: false, description: null });
    const deleted = await v1.deleteService(call(`/services/${serviceId}`, { method: "DELETE" }), params());
    expect(await deleted.json()).toEqual({ data: { id: serviceId, deleted: true } });
    expect(domain.deleteServiceForApi).toHaveBeenCalledWith(expect.anything(), expect.anything(), serviceId);
    expect((await v1.updateService(call("/services/x", { method: "PATCH", body: JSON.stringify({ active: true }) }), params("x"))).status).toBe(400);
    expect((await v1.deleteService(call("/services/x", { method: "DELETE" }), params("x"))).status).toBe(400);
    expect(domain.updateServiceForApi).toHaveBeenCalledTimes(1);
    expect(domain.deleteServiceForApi).toHaveBeenCalledTimes(1);
  });

  it("needs business:write to change services", async () => {
    domain.resolveApiKey.mockResolvedValue({ businessId: "5d0bd9a4-7e1c-4a51-9a50-8e1b2c3d4e5f", apiKeyId: "0b7c1d2e-3f40-4a51-8b62-7c83d94ea5b6", scopes: ["business:read"] });
    expect((await v1.createService(call("/services", { method: "POST", body: JSON.stringify({ name: "Cut", duration_minutes: 30 }) }))).status).toBe(403);
    expect((await v1.deleteService(call(`/services/${serviceId}`, { method: "DELETE" }), params())).status).toBe(403);
    expect((await v1.updateService(call(`/services/${serviceId}`, { method: "PATCH", body: JSON.stringify({ active: false }) }), params())).status).toBe(403);
    expect(domain.updateServiceForApi).not.toHaveBeenCalled();
    expect(domain.createServiceForApi).not.toHaveBeenCalled();
    expect(domain.deleteServiceForApi).not.toHaveBeenCalled();
  });
});

describe("billing", () => {
  const billing = { plan: "free_cloud", managed: false, subscription_state: null, billing_interval: null, current_period_end: null, spending_cap_cents: null, overage_spend_cents: 0, spending_cap_reached: false };
  const checkoutId = "3f0f6f2e-7c1a-4b8e-9a5d-2c3b4a5d6e7f";
  const platformKey = () => generatePlatformKey({ name: "Operator", partner: "lobbystack", ownerEmail: "ops@example.com", access: "all" });

  it("reads the plan and sets the spending cap", async () => {
    domain.getBillingForApi.mockResolvedValue(billing);
    expect(await (await v1.getBilling(call("/billing"))).json()).toEqual({ data: billing });
    domain.updateBillingForApi.mockResolvedValue({ ...billing, spending_cap_cents: 5_000 });
    expect((await v1.updateBilling(call("/billing", { method: "PATCH", body: JSON.stringify({ spending_cap_cents: 5_000 }) }))).status).toBe(200);
    expect(domain.updateBillingForApi).toHaveBeenCalledWith(expect.anything(), expect.anything(), { spending_cap_cents: 5_000 });
    for (const bad of [{}, { spending_cap_cents: -1 }, { spending_cap_cents: 1.5 }, { plan: "pro" }]) {
      expect((await v1.updateBilling(call("/billing", { method: "PATCH", body: JSON.stringify(bad) }))).status, JSON.stringify(bad)).toBe(400);
    }
    expect(domain.updateBillingForApi).toHaveBeenCalledTimes(1);
  });

  it("starts a checkout only for a plan and interval this deployment sells", async () => {
    vi.stubEnv("POLAR_ACCESS_TOKEN", "polar-token");
    vi.stubEnv("POLAR_ORGANIZATION_ID", "org");
    vi.stubEnv("POLAR_PRO_MONTHLY_PRODUCT_ID", "prod_pro_monthly");
    try {
      domain.createCheckoutForApi.mockResolvedValue({ id: checkoutId, plan: "pro", interval: "monthly", status: "pending", checkout_url: null, error: null, paid: false, created_at: "2026-10-11T12:00:00.000Z", updated_at: "2026-10-11T12:00:00.000Z" });
      expect((await v1.createCheckout(call("/billing/checkout", { method: "POST", body: JSON.stringify({ plan: "pro", interval: "monthly" }) }))).status).toBe(202);
      expect(domain.createCheckoutForApi).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), { plan: "pro", interval: "monthly" }, { available: true });
      await v1.createCheckout(call("/billing/checkout", { method: "POST", body: JSON.stringify({ plan: "pro", interval: "annual" }) }));
      expect(domain.createCheckoutForApi).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), { plan: "pro", interval: "annual" }, { available: false });
      expect((await v1.createCheckout(call("/billing/checkout", { method: "POST", body: JSON.stringify({ plan: "enterprise", interval: "monthly" }) }))).status).toBe(400);
      domain.getCheckoutForApi.mockResolvedValue({ id: checkoutId });
      expect((await v1.getCheckout(call(`/billing/checkout/${checkoutId}`), { params: Promise.resolve({ checkout_id: checkoutId }) })).status).toBe(200);
      expect((await v1.getCheckout(call("/billing/checkout/x"), { params: Promise.resolve({ checkout_id: "x" }) })).status).toBe(400);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("lets only an operator's platform key manage a plan outside Polar", async () => {
    // A per-business key, even with billing:manage, is refused.
    expect((await v1.setManagedPlan(call("/billing/managed-plan", { method: "POST", body: JSON.stringify({ plan: "enterprise" }) }))).status).toBe(403);
    expect((await v1.endManagedPlan(call("/billing/managed-plan", { method: "DELETE" }))).status).toBe(403);
    // So is a partner's platform key.
    const partner = generatePlatformKey({ name: "Partner", partner: "acme", ownerEmail: "ops@acme.example", access: "partner" });
    const operator = platformKey();
    vi.stubEnv("PLATFORM_API_KEYS", JSON.stringify([partner.entry, operator.entry]));
    try {
      const asKey = (key: string, init: RequestInit = {}) => new Request("https://app.example.com/api/v1/billing/managed-plan", { ...init, headers: { authorization: `Bearer ${key}`, "LobbyStack-Business": "5d0bd9a4-7e1c-4a51-9a50-8e1b2c3d4e5f" } });
      expect((await v1.setManagedPlan(asKey(partner.key, { method: "POST", body: JSON.stringify({ plan: "enterprise" }) }))).status).toBe(403);
      domain.setManagedPlanForApi.mockResolvedValue({ ...billing, plan: "enterprise", managed: true });
      const set = await v1.setManagedPlan(asKey(operator.key, { method: "POST", body: JSON.stringify({ plan: "enterprise" }) }));
      expect(set.status).toBe(200);
      expect(await set.json()).toMatchObject({ data: { plan: "enterprise", managed: true } });
      expect((await v1.setManagedPlan(asKey(operator.key, { method: "POST", body: JSON.stringify({ plan: "pro" }) }))).status).toBe(400);
      domain.endManagedPlanForApi.mockResolvedValue(billing);
      expect((await v1.endManagedPlan(asKey(operator.key, { method: "DELETE" }))).status).toBe(200);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(domain.setManagedPlanForApi).toHaveBeenCalledTimes(1);
    expect(domain.endManagedPlanForApi).toHaveBeenCalledTimes(1);
  });

  it("needs billing:manage", async () => {
    domain.resolveApiKey.mockResolvedValue({ businessId: "5d0bd9a4-7e1c-4a51-9a50-8e1b2c3d4e5f", apiKeyId: "0b7c1d2e-3f40-4a51-8b62-7c83d94ea5b6", scopes: ["business:write"] });
    expect((await v1.getBilling(call("/billing"))).status).toBe(403);
    expect((await v1.createCheckout(call("/billing/checkout", { method: "POST", body: JSON.stringify({ plan: "pro", interval: "monthly" }) }))).status).toBe(403);
    expect(domain.getBillingForApi).not.toHaveBeenCalled();
    expect(domain.createCheckoutForApi).not.toHaveBeenCalled();
  });
});

describe("phone numbers", () => {
  const actingUserId = "6a1f0c2d-8e3b-4c5d-9e6f-7a8b9c0d1e2f";
  const numberId = "8c2b7f4e-1d3a-4e5b-9c6d-0e1f2a3b4c5d";
  const claimId = "4e5f6a7b-8c9d-4e0f-a1b2-c3d4e5f6a7b8";
  const offer = { phone_number: "+14165550123", country: "CA", kind: "local", locality: "Toronto", region: "ON", capabilities: { voice: true, sms: true }, offer_token: "signed-offer", expires_at: "2026-10-11T12:05:00.000Z" };
  const claim = { id: claimId, status: "pending", phone_number: "+14165550123", phone_number_id: null, replaces_phone_number_id: null, error: null, created_at: "2026-10-11T12:00:00.000Z", updated_at: "2026-10-11T12:00:00.000Z" };
  const search = (body: unknown) => v1.searchPhoneNumbers(call("/phone-numbers/search", { method: "POST", body: JSON.stringify(body) }));
  const claimWith = (body: unknown, headers: Record<string, string> = { "Idempotency-Key": "claim-1" }) => v1.createPhoneNumberClaim(call("/phone-numbers/claims", { method: "POST", headers, body: JSON.stringify(body) }));

  it("searches as the account the key acts as, counting against that account's limit just before the carrier is asked", async () => {
    // As the domain does: its checks first, then beforeSearch, then the carrier.
    const asked = vi.fn();
    domain.searchPhoneNumbersForApi.mockImplementation(async (...args: unknown[]) => {
      await (args[3] as { beforeSearch?: () => Promise<void> }).beforeSearch?.();
      asked();
      return [offer];
    });
    const response = await search({ area_code: "416", limit: 5 });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: [offer], next_cursor: null, has_more: false });
    expect(numbers.searchLimit).toHaveBeenCalledWith({ userId: actingUserId, initial: false });
    expect(domain.searchPhoneNumbersForApi).toHaveBeenCalledWith(expect.anything(), expect.anything(), { area_code: "416", limit: 5 }, { userId: actingUserId, provider: numbers.provider, claimTokenSecret: "number-claim-secret", beforeSearch: expect.any(Function) });

    numbers.searchLimit.mockResolvedValueOnce({ allowed: false, status: 429, reason: "rate_limit_user" });
    const limited = await search({});
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ error: { code: "rate_limited" } });
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(Number(limited.headers.get("retry-after"))).toBeLessThanOrEqual(600);
    numbers.searchLimit.mockResolvedValueOnce({ allowed: false, status: 503, reason: "rate_limit_unavailable" });
    const unavailable = await search({});
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get("retry-after")).toBe("5");
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it("checks the search before it counts against the limit", async () => {
    for (const bad of [{ country: "FR" }, { kind: "mobile" }, { area_code: "41a" }, { limit: 0 }, { limit: 21 }, { replaces: "x" }, { areaCode: "416" }]) {
      expect((await search(bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect(numbers.searchLimit).not.toHaveBeenCalled();
    expect(domain.searchPhoneNumbersForApi).not.toHaveBeenCalled();
  });

  it("claims an offer only with an Idempotency-Key, as the account the key acts as", async () => {
    domain.claimPhoneNumberForApi.mockResolvedValue(claim);
    expect((await claimWith({ offer_token: "signed-offer" }, {})).status).toBe(400);
    expect((await claimWith({ offer_token: "" })).status).toBe(400);
    const response = await claimWith({ offer_token: "signed-offer" });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ data: claim });
    expect(domain.claimPhoneNumberForApi).toHaveBeenCalledTimes(1);
    expect(domain.claimPhoneNumberForApi).toHaveBeenCalledWith(expect.anything(), expect.anything(), { offerToken: "signed-offer" }, { userId: actingUserId, claimTokenSecret: "number-claim-secret" });
  });

  it("replaces a number with a replacement offer", async () => {
    domain.claimPhoneNumberForApi.mockResolvedValue({ ...claim, replaces_phone_number_id: numberId });
    const replace = (id: string, headers: Record<string, string> = { "Idempotency-Key": "replace-1" }) => v1.replacePhoneNumber(call(`/phone-numbers/${id}/replace`, { method: "POST", headers, body: JSON.stringify({ offer_token: "signed-offer" }) }), { params: Promise.resolve({ phone_number_id: id }) });
    expect((await replace(numberId)).status).toBe(202);
    expect(domain.claimPhoneNumberForApi).toHaveBeenCalledWith(expect.anything(), expect.anything(), { offerToken: "signed-offer", replaces: numberId }, { userId: actingUserId, claimTokenSecret: "number-claim-secret" });
    expect((await replace("x")).status).toBe(400);
    expect((await replace(numberId, {})).status).toBe(400);
    expect(domain.claimPhoneNumberForApi).toHaveBeenCalledTimes(1);
    // The same key and body sent to another number is a different request, so it can't replay this one.
    const otherId = "9d3c8a5f-2e4b-4f6c-8d7e-1f2a3b4c5d6e";
    await replace(otherId);
    const hashes = domain.runIdempotent.mock.calls.map(([, , hash]) => hash);
    expect(hashes.at(-1)).not.toBe(hashes[0]);
  });

  it("lists numbers, reads claims and releases a number", async () => {
    const number = { id: numberId, phone_number: "+14165550123", status: "active", release_scheduled_at: null, created_at: "2026-10-11T12:00:00.000Z", updated_at: "2026-10-11T12:00:00.000Z" };
    domain.listPhoneNumbersForApi.mockResolvedValue([number]);
    expect(await (await v1.listPhoneNumbers(call("/phone-numbers"))).json()).toEqual({ data: [number], next_cursor: null, has_more: false });
    domain.getPhoneNumberClaimForApi.mockResolvedValue(claim);
    expect((await v1.getPhoneNumberClaim(call(`/phone-numbers/claims/${claimId}`), { params: Promise.resolve({ claim_id: claimId }) })).status).toBe(200);
    expect((await v1.getPhoneNumberClaim(call("/phone-numbers/claims/x"), { params: Promise.resolve({ claim_id: "x" }) })).status).toBe(400);
    domain.releasePhoneNumberForApi.mockResolvedValue({ ...number, release_scheduled_at: "2026-10-11T12:01:00.000Z" });
    const released = await v1.releasePhoneNumber(call(`/phone-numbers/${numberId}`, { method: "DELETE" }), { params: Promise.resolve({ phone_number_id: numberId }) });
    expect(released.status).toBe(202);
    expect(domain.releasePhoneNumberForApi).toHaveBeenCalledWith(expect.anything(), expect.anything(), numberId);
  });

  it("needs phone_numbers:manage", async () => {
    domain.resolveApiKey.mockResolvedValue({ businessId: "5d0bd9a4-7e1c-4a51-9a50-8e1b2c3d4e5f", apiKeyId: "0b7c1d2e-3f40-4a51-8b62-7c83d94ea5b6", scopes: ["business:write", "billing:manage"] });
    expect((await search({})).status).toBe(403);
    expect((await claimWith({ offer_token: "signed-offer" })).status).toBe(403);
    expect((await v1.listPhoneNumbers(call("/phone-numbers"))).status).toBe(403);
    expect(domain.searchPhoneNumbersForApi).not.toHaveBeenCalled();
    expect(domain.claimPhoneNumberForApi).not.toHaveBeenCalled();
    expect(domain.listPhoneNumbersForApi).not.toHaveBeenCalled();
  });
});

describe("rules", () => {
  const ruleId = "3f0f6f2e-7c1a-4b8e-9a5d-2c3b4a5d6e7f";
  const otherId = "06d9c0dc-f18a-4cc6-a987-ac4963c87113";
  const rule = { id: ruleId, title: "No prices", content: "Never quote prices.", active: true, created_at: "2026-10-11T12:00:00.000Z", updated_at: "2026-10-11T12:00:00.000Z" };
  const params = (id = ruleId) => ({ params: Promise.resolve({ rule_id: id }) });

  it("lists the rules and adds one with checked fields", async () => {
    domain.listRulesForApi.mockResolvedValue([rule]);
    expect(await (await v1.listRules(call("/rules"))).json()).toEqual({ data: [rule], next_cursor: null, has_more: false });
    domain.createRuleForApi.mockResolvedValue(rule);
    const created = await v1.createRule(call("/rules", { method: "POST", body: JSON.stringify({ title: " No prices ", content: "Never quote prices." }) }));
    expect(created.status).toBe(201);
    expect(domain.createRuleForApi).toHaveBeenCalledWith(expect.anything(), expect.anything(), { title: "No prices", content: "Never quote prices." });
    for (const bad of [{ title: "No prices" }, { title: "", content: "x" }, { title: "x".repeat(161), content: "x" }, { title: "x", content: "x".repeat(10_001) }, { title: "x", content: "x", order: 1 }]) {
      expect((await v1.createRule(call("/rules", { method: "POST", body: JSON.stringify(bad) }))).status, JSON.stringify(bad)).toBe(400);
    }
    expect(domain.createRuleForApi).toHaveBeenCalledTimes(1);
  });

  it("changes, deletes and reorders rules by id", async () => {
    domain.updateRuleForApi.mockResolvedValue({ ...rule, active: false });
    expect((await v1.updateRule(call(`/rules/${ruleId}`, { method: "PATCH", body: JSON.stringify({ active: false }) }), params())).status).toBe(200);
    expect(domain.updateRuleForApi).toHaveBeenCalledWith(expect.anything(), expect.anything(), ruleId, { active: false });
    expect(await (await v1.deleteRule(call(`/rules/${ruleId}`, { method: "DELETE" }), params())).json()).toEqual({ data: { id: ruleId, deleted: true } });
    domain.reorderRulesForApi.mockResolvedValue([rule]);
    const reordered = await v1.reorderRules(call("/rules/reorder", { method: "POST", body: JSON.stringify({ rule_ids: [otherId, ruleId] }) }));
    expect(await reordered.json()).toEqual({ data: [rule], next_cursor: null, has_more: false });
    expect(domain.reorderRulesForApi).toHaveBeenCalledWith(expect.anything(), expect.anything(), { rule_ids: [otherId, ruleId] });
    expect((await v1.reorderRules(call("/rules/reorder", { method: "POST", body: JSON.stringify({ rule_ids: [] }) }))).status).toBe(400);
    expect((await v1.reorderRules(call("/rules/reorder", { method: "POST", body: JSON.stringify({ rule_ids: ["x"] }) }))).status).toBe(400);
    expect((await v1.updateRule(call("/rules/x", { method: "PATCH", body: JSON.stringify({ active: true }) }), params("x"))).status).toBe(400);
    // A rule takes only title, content and active, and calls read at most 4,000 characters of it.
    expect((await v1.updateRule(call(`/rules/${ruleId}`, { method: "PATCH", body: JSON.stringify({ position: 2 }) }), params())).status).toBe(400);
    expect((await v1.updateRule(call(`/rules/${ruleId}`, { method: "PATCH", body: JSON.stringify({ content: "x".repeat(4_001) }) }), params())).status).toBe(400);
    expect(domain.updateRuleForApi).toHaveBeenCalledTimes(1);
    expect(domain.reorderRulesForApi).toHaveBeenCalledTimes(1);
  });

  it("needs business:read to read and business:write to change", async () => {
    domain.resolveApiKey.mockResolvedValue({ businessId: "5d0bd9a4-7e1c-4a51-9a50-8e1b2c3d4e5f", apiKeyId: "0b7c1d2e-3f40-4a51-8b62-7c83d94ea5b6", scopes: ["business:read"] });
    expect((await v1.createRule(call("/rules", { method: "POST", body: JSON.stringify({ title: "x", content: "x" }) }))).status).toBe(403);
    expect((await v1.reorderRules(call("/rules/reorder", { method: "POST", body: JSON.stringify({ rule_ids: [ruleId] }) }))).status).toBe(403);
    expect((await v1.updateRule(call(`/rules/${ruleId}`, { method: "PATCH", body: JSON.stringify({ active: false }) }), params())).status).toBe(403);
    expect((await v1.deleteRule(call(`/rules/${ruleId}`, { method: "DELETE" }), params())).status).toBe(403);
    expect(domain.updateRuleForApi).not.toHaveBeenCalled();
    expect(domain.deleteRuleForApi).not.toHaveBeenCalled();
    domain.resolveApiKey.mockResolvedValue({ businessId: "5d0bd9a4-7e1c-4a51-9a50-8e1b2c3d4e5f", apiKeyId: "0b7c1d2e-3f40-4a51-8b62-7c83d94ea5b6", scopes: ["business:write"] });
    expect((await v1.listRules(call("/rules"))).status).toBe(403);
    expect(domain.createRuleForApi).not.toHaveBeenCalled();
    expect(domain.reorderRulesForApi).not.toHaveBeenCalled();
    expect(domain.listRulesForApi).not.toHaveBeenCalled();
  });
});

describe("receptionist settings", () => {
  const receptionist = { greeting: "Hi", tone: "warm", summary: "Maple", summary_source: "operator", booking_policy: "Book", voice_instructions: null, sms_instructions: null, chat_instructions: null, transfer_mode: "never", transfer_number: null, booking_mode: "instant", appointment_change_policy: { enabled: true, allow_cancel: true, allow_reschedule: true, verification_mode: "phone_match_and_facts" }, updated_at: "2026-10-11T12:00:00.000Z" };

  it("reads the settings", async () => {
    domain.getReceptionistForApi.mockResolvedValue(receptionist);
    const response = await v1.getReceptionist(call("/receptionist"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: receptionist });
  });

  it("passes the checked fields through and refuses anything the dashboard would refuse", async () => {
    domain.updateReceptionistForApi.mockResolvedValue({ ...receptionist, greeting: "Hello." });
    const response = await v1.updateReceptionist(call("/receptionist", { method: "PATCH", body: JSON.stringify({ greeting: " Hello. ", booking_mode: "request", transfer_number: "+14165550134" }) }));
    expect(response.status).toBe(200);
    expect(domain.updateReceptionistForApi).toHaveBeenCalledWith(expect.anything(), expect.anything(), { greeting: "Hello.", booking_mode: "request", transfer_number: "+14165550134" });
    for (const bad of [{ transfer_mode: "sometimes" }, { summary: "Mine.", regenerate_summary: true }, { greeting: "" }, { appointment_change_policy: { enabled: false } }, { locale: "fr" }]) {
      expect((await v1.updateReceptionist(call("/receptionist", { method: "PATCH", body: JSON.stringify(bad) }))).status).toBe(400);
    }
    expect(domain.updateReceptionistForApi).toHaveBeenCalledTimes(1);
  });

  it("needs business:read to read and business:write to change", async () => {
    domain.resolveApiKey.mockResolvedValue({ businessId: "5d0bd9a4-7e1c-4a51-9a50-8e1b2c3d4e5f", apiKeyId: "0b7c1d2e-3f40-4a51-8b62-7c83d94ea5b6", scopes: ["business:read"] });
    expect((await v1.updateReceptionist(call("/receptionist", { method: "PATCH", body: JSON.stringify({ greeting: "Hello." }) }))).status).toBe(403);
    domain.resolveApiKey.mockResolvedValue({ businessId: "5d0bd9a4-7e1c-4a51-9a50-8e1b2c3d4e5f", apiKeyId: "0b7c1d2e-3f40-4a51-8b62-7c83d94ea5b6", scopes: ["business:write"] });
    expect((await v1.getReceptionist(call("/receptionist"))).status).toBe(403);
    expect(domain.updateReceptionistForApi).not.toHaveBeenCalled();
    expect(domain.getReceptionistForApi).not.toHaveBeenCalled();
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
