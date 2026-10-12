import {
  cancelAppointmentForApi,
  cancelKnowledgeSourceForApi,
  completeKnowledgeUploadForApi,
  createAppointmentForApi,
  createBusinessForApi,
  createContactForApi,
  createKnowledgeEntryForApi,
  createKnowledgeSourceForApi,
  createKnowledgeUploadForApi,
  createServiceForApi,
  createWebhookEndpoint,
  deleteKnowledgeEntryForApi,
  deleteKnowledgeSourceForApi,
  deleteServiceForApi,
  deleteWebhookEndpoint,
  expandKnowledgeSourceForApi,
  getAppointmentForApi,
  getAvailabilityForApi,
  getBusinessForApi,
  getKnowledgeEntryForApi,
  getKnowledgeSourceForApi,
  getMeForApi,
  getPlatformMeForApi,
  getReceptionistForApi,
  getCallForApi,
  getContactForApi,
  getWebhookEndpoint,
  idempotencyRequestHash,
  listAppointmentsForApi,
  listBusinessesForApi,
  listCallsForApi,
  listContactsForApi,
  listKnowledgeEntriesForApi,
  listKnowledgeSourcesForApi,
  listMessagesForApi,
  listServicesForApi,
  listStaffForApi,
  listWebhookEndpoints,
  PublicApiError,
  rescheduleAppointmentForApi,
  retryKnowledgeSourceForApi,
  sendWebhookTestEvent,
  updateBusinessForApi,
  updateContactForApi,
  updateKnowledgeEntryForApi,
  updateKnowledgeSourceForApi,
  updateReceptionistForApi,
  updateServiceForApi,
  updateWebhookEndpoint,
  type WebhookEndpointDetail,
  type WebhookManager,
} from "@lobbystack/domain";
import {
  apiAppointmentCreateSchema,
  apiAppointmentRescheduleSchema,
  apiBusinessCreateSchema,
  apiBusinessUpdateSchema,
  apiContactCreateSchema,
  apiContactUpdateSchema,
  apiKnowledgeEntryCreateSchema,
  apiKnowledgeEntryUpdateSchema,
  apiKnowledgeSourceCreateSchema,
  apiKnowledgeSourceUpdateSchema,
  apiKnowledgeUploadCompleteSchema,
  apiKnowledgeUploadCreateSchema,
  apiReceptionistUpdateSchema,
  apiServiceCreateSchema,
  apiServiceUpdateSchema,
  apiWebhookEndpointCreateSchema,
  apiWebhookEndpointUpdateSchema,
  webhookEventScope,
  type ApiWebhookEndpoint,
  type WebhookEventType,
} from "@lobbystack/shared";

import { getStorageProvider } from "../storage";
import { data, handleApiRequest, pageQuery, queryParam, readApiBody, uuidParam, type ApiCredential, type RestApiCaller } from "./http";

// One function per v1 operation. The route files under app/api/v1 only bind
// these to HTTP methods, so tests can call the same functions.

type Params<T extends string> = { params: Promise<Record<T, string>> };

function toApiEndpoint(endpoint: WebhookEndpointDetail): ApiWebhookEndpoint {
  return { id: endpoint.id, url: endpoint.url, description: endpoint.description, events: endpoint.events, status: endpoint.status, disabled_reason: endpoint.disabled_reason, created_at: endpoint.created_at, updated_at: endpoint.updated_at };
}

// An event carries the same data as the matching read endpoint, so subscribing to it needs that read scope.
function requireEventScopes(credential: ApiCredential, events: readonly WebhookEventType[]): void {
  const missing = [...new Set(events.map((event) => webhookEventScope[event]))].filter((scope) => !credential.scopes.includes(scope));
  if (missing.length) throw new PublicApiError(403, "insufficient_scope", `This API key needs ${missing.join(", ")} to subscribe to these events.`);
}

function webhookManager(caller: RestApiCaller): WebhookManager {
  if (caller.platformKeyId !== undefined) return { kind: "platform_key", platformKeyId: caller.platformKeyId, partnerId: caller.partnerId, actingUserId: caller.actingUserId };
  return { kind: "api_key", apiKeyId: caller.apiKeyId };
}

function dateParam(request: Request, name: string): Date | undefined {
  const value = queryParam(request, name);
  if (value === undefined) return undefined;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new PublicApiError(400, "invalid_request", `${name} must be an ISO 8601 timestamp.`);
  return parsed;
}

function textParam(request: Request, name: string, maxLength: number): string | undefined {
  const value = queryParam(request, name)?.trim();
  if (!value) return undefined;
  if (value.length > maxLength) throw new PublicApiError(400, "invalid_request", `${name} can be up to ${maxLength} characters.`, [{ path: name, message: `At most ${maxLength} characters.` }]);
  return value;
}

function booleanParam(request: Request, name: string): boolean | undefined {
  const value = queryParam(request, name);
  if (value === undefined) return undefined;
  if (value !== "true" && value !== "false") throw new PublicApiError(400, "invalid_request", `${name} must be true or false.`);
  return value === "true";
}

function enumParam<T extends string>(request: Request, name: string, values: readonly T[]): T | undefined {
  const value = queryParam(request, name);
  if (value === undefined) return undefined;
  if (!values.includes(value as T)) throw new PublicApiError(400, "invalid_request", `${name} must be one of: ${values.join(", ")}.`);
  return value as T;
}

export const v1 = {
  getMe: (request: Request) => handleApiRequest(request, "getMe", async ({ context, caller, credential }) => {
    if (credential.kind === "platform_key") return { body: data(await getPlatformMeForApi(context, credential, caller?.platformKeyId !== undefined ? caller : null)) };
    if (caller?.apiKeyId === undefined) throw new Error("A per-business key always has its business.");
    return { body: data(await getMeForApi(context, caller)) };
  }),
  getBusiness: (request: Request) => handleApiRequest(request, "getBusiness", async ({ context, caller }) => ({ body: data(await getBusinessForApi(context, caller)) })),
  updateBusiness: (request: Request) => handleApiRequest(request, "updateBusiness", async ({ context, caller }) => ({ body: data(await updateBusinessForApi(context, caller, await readApiBody(request, apiBusinessUpdateSchema))) })),
  createBusiness: (request: Request) => handleApiRequest(request, "createBusiness", async ({ context, credential, actingUserId, idempotencyKey }) => {
    if (!idempotencyKey) throw new Error("POST /businesses requires an Idempotency-Key.");
    const body = await readApiBody(request, apiBusinessCreateSchema);
    const result = await createBusinessForApi(context, { key: credential, actingUserId, idempotencyKey, requestHash: idempotencyRequestHash(body), body });
    return { body: data(result.business), ...(result.replayed ? { headers: { "Idempotent-Replayed": "true" } } : {}) };
  }),
  listBusinesses: (request: Request) => handleApiRequest(request, "listBusinesses", async ({ context, credential }) => ({ body: await listBusinessesForApi(context, { partnerId: credential.partnerId, ...pageQuery(request) }) })),
  getReceptionist: (request: Request) => handleApiRequest(request, "getReceptionist", async ({ context, caller }) => ({ body: data(await getReceptionistForApi(context, caller)) })),
  updateReceptionist: (request: Request) => handleApiRequest(request, "updateReceptionist", async ({ context, caller }) => ({ body: data(await updateReceptionistForApi(context, caller, await readApiBody(request, apiReceptionistUpdateSchema))) })),
  listServices: (request: Request) => handleApiRequest(request, "listServices", async ({ context, caller }) => ({ body: { data: await listServicesForApi(context, caller, { includeInactive: booleanParam(request, "include_inactive") }), next_cursor: null, has_more: false } })),
  createService: (request: Request) => handleApiRequest(request, "createService", async ({ context, caller }) => ({ body: data(await createServiceForApi(context, caller, await readApiBody(request, apiServiceCreateSchema))) })),
  updateService: (request: Request, { params }: Params<"service_id">) => handleApiRequest(request, "updateService", async ({ context, caller }) => {
    const serviceId = uuidParam((await params).service_id, "service_id");
    return { body: data(await updateServiceForApi(context, caller, serviceId, await readApiBody(request, apiServiceUpdateSchema))) };
  }),
  deleteService: (request: Request, { params }: Params<"service_id">) => handleApiRequest(request, "deleteService", async ({ context, caller }) => {
    const serviceId = uuidParam((await params).service_id, "service_id");
    await deleteServiceForApi(context, caller, serviceId);
    return { body: data({ id: serviceId, deleted: true }) };
  }),
  listStaff: (request: Request) => handleApiRequest(request, "listStaff", async ({ context, caller }) => ({ body: { data: await listStaffForApi(context, caller), next_cursor: null, has_more: false } })),

  listCalls: (request: Request) => handleApiRequest(request, "listCalls", async ({ context, caller }) => ({ body: await listCallsForApi(context, caller, { ...pageQuery(request), startedAfter: dateParam(request, "started_after"), startedBefore: dateParam(request, "started_before") }) })),
  getCall: (request: Request, { params }: Params<"call_id">) => handleApiRequest(request, "getCall", async ({ context, caller }) => ({ body: data(await getCallForApi(context, caller, uuidParam((await params).call_id, "call_id"))) })),

  listContacts: (request: Request) => handleApiRequest(request, "listContacts", async ({ context, caller }) => ({ body: await listContactsForApi(context, caller, { ...pageQuery(request), phone: queryParam(request, "phone"), email: queryParam(request, "email"), name: textParam(request, "name", 200) }) })),
  createContact: (request: Request) => handleApiRequest(request, "createContact", async ({ context, caller }) => ({ body: data(await createContactForApi(context, caller, await readApiBody(request, apiContactCreateSchema))) })),
  getContact: (request: Request, { params }: Params<"contact_id">) => handleApiRequest(request, "getContact", async ({ context, caller }) => ({ body: data(await getContactForApi(context, caller, uuidParam((await params).contact_id, "contact_id"))) })),
  updateContact: (request: Request, { params }: Params<"contact_id">) => handleApiRequest(request, "updateContact", async ({ context, caller }) => {
    const contactId = uuidParam((await params).contact_id, "contact_id");
    return { body: data(await updateContactForApi(context, caller, contactId, await readApiBody(request, apiContactUpdateSchema))) };
  }),

  listAppointments: (request: Request) => handleApiRequest(request, "listAppointments", async ({ context, caller }) => ({ body: await listAppointmentsForApi(context, caller, { ...pageQuery(request), status: enumParam(request, "status", ["confirmed", "cancelled"] as const), startsAfter: dateParam(request, "starts_after"), startsBefore: dateParam(request, "starts_before"), contactId: queryParam(request, "contact_id") === undefined ? undefined : uuidParam(queryParam(request, "contact_id"), "contact_id") }) })),
  getAvailability: (request: Request) => handleApiRequest(request, "getAvailability", async ({ context, caller }) => {
    const serviceId = uuidParam(queryParam(request, "service_id"), "service_id");
    const startDate = queryParam(request, "start_date");
    if (!startDate) throw new PublicApiError(400, "invalid_request", "start_date is required.", [{ path: "start_date", message: "Required." }]);
    const staffId = queryParam(request, "staff_id") === undefined ? undefined : uuidParam(queryParam(request, "staff_id"), "staff_id");
    return { body: { data: await getAvailabilityForApi(context, caller, { serviceId, startDate, endDate: queryParam(request, "end_date"), staffId }), next_cursor: null, has_more: false } };
  }),
  createAppointment: (request: Request) => handleApiRequest(request, "createAppointment", async ({ context, caller }) => ({ body: data(await createAppointmentForApi(context, caller, await readApiBody(request, apiAppointmentCreateSchema))) })),
  getAppointment: (request: Request, { params }: Params<"appointment_id">) => handleApiRequest(request, "getAppointment", async ({ context, caller }) => ({ body: data(await getAppointmentForApi(context, caller, uuidParam((await params).appointment_id, "appointment_id"))) })),
  cancelAppointment: (request: Request, { params }: Params<"appointment_id">) => handleApiRequest(request, "cancelAppointment", async ({ context, caller }) => ({ body: data(await cancelAppointmentForApi(context, caller, uuidParam((await params).appointment_id, "appointment_id"))) })),
  rescheduleAppointment: (request: Request, { params }: Params<"appointment_id">) => handleApiRequest(request, "rescheduleAppointment", async ({ context, caller }) => {
    const appointmentId = uuidParam((await params).appointment_id, "appointment_id");
    return { body: data(await rescheduleAppointmentForApi(context, caller, appointmentId, await readApiBody(request, apiAppointmentRescheduleSchema))) };
  }),

  listMessages: (request: Request) => handleApiRequest(request, "listMessages", async ({ context, caller }) => ({ body: await listMessagesForApi(context, caller, { ...pageQuery(request), status: enumParam(request, "status", ["open", "done"] as const) }) })),
  listKnowledgeEntries: (request: Request) => handleApiRequest(request, "listKnowledgeEntries", async ({ context, caller }) => ({ body: await listKnowledgeEntriesForApi(context, caller, { ...pageQuery(request), type: enumParam(request, "type", ["text", "faq"] as const) }) })),
  createKnowledgeEntry: (request: Request) => handleApiRequest(request, "createKnowledgeEntry", async ({ context, caller }) => ({ body: data(await createKnowledgeEntryForApi(context, caller, await readApiBody(request, apiKnowledgeEntryCreateSchema))) })),
  getKnowledgeEntry: (request: Request, { params }: Params<"entry_id">) => handleApiRequest(request, "getKnowledgeEntry", async ({ context, caller }) => ({ body: data(await getKnowledgeEntryForApi(context, caller, uuidParam((await params).entry_id, "entry_id"))) })),
  updateKnowledgeEntry: (request: Request, { params }: Params<"entry_id">) => handleApiRequest(request, "updateKnowledgeEntry", async ({ context, caller }) => {
    const entryId = uuidParam((await params).entry_id, "entry_id");
    return { body: data(await updateKnowledgeEntryForApi(context, caller, entryId, await readApiBody(request, apiKnowledgeEntryUpdateSchema))) };
  }),
  deleteKnowledgeEntry: (request: Request, { params }: Params<"entry_id">) => handleApiRequest(request, "deleteKnowledgeEntry", async ({ context, caller }) => {
    const entryId = uuidParam((await params).entry_id, "entry_id");
    await deleteKnowledgeEntryForApi(context, caller, entryId);
    return { body: data({ id: entryId, deleted: true }) };
  }),
  listKnowledgeSources: (request: Request) => handleApiRequest(request, "listKnowledgeSources", async ({ context, caller }) => ({ body: await listKnowledgeSourcesForApi(context, caller, { ...pageQuery(request), type: enumParam(request, "type", ["website", "page", "file"] as const), status: enumParam(request, "status", ["pending", "processing", "indexed", "error", "cancelled"] as const) }) })),
  createKnowledgeSource: (request: Request) => handleApiRequest(request, "createKnowledgeSource", async ({ context, caller }) => ({ body: data(await createKnowledgeSourceForApi(context, caller, await readApiBody(request, apiKnowledgeSourceCreateSchema))) })),
  getKnowledgeSource: (request: Request, { params }: Params<"source_id">) => handleApiRequest(request, "getKnowledgeSource", async ({ context, caller }) => ({ body: data(await getKnowledgeSourceForApi(context, caller, uuidParam((await params).source_id, "source_id"))) })),
  updateKnowledgeSource: (request: Request, { params }: Params<"source_id">) => handleApiRequest(request, "updateKnowledgeSource", async ({ context, caller }) => {
    const sourceId = uuidParam((await params).source_id, "source_id");
    return { body: data(await updateKnowledgeSourceForApi(context, caller, sourceId, await readApiBody(request, apiKnowledgeSourceUpdateSchema))) };
  }),
  deleteKnowledgeSource: (request: Request, { params }: Params<"source_id">) => handleApiRequest(request, "deleteKnowledgeSource", async ({ context, caller }) => {
    const sourceId = uuidParam((await params).source_id, "source_id");
    await deleteKnowledgeSourceForApi(context, caller, sourceId);
    return { body: data({ id: sourceId, deleted: true }) };
  }),
  expandKnowledgeSource: (request: Request, { params }: Params<"source_id">) => handleApiRequest(request, "expandKnowledgeSource", async ({ context, caller }) => ({ body: data(await expandKnowledgeSourceForApi(context, caller, uuidParam((await params).source_id, "source_id"))) })),
  retryKnowledgeSource: (request: Request, { params }: Params<"source_id">) => handleApiRequest(request, "retryKnowledgeSource", async ({ context, caller }) => ({ body: data(await retryKnowledgeSourceForApi(context, caller, uuidParam((await params).source_id, "source_id"))) })),
  createKnowledgeUpload: (request: Request) => handleApiRequest(request, "createKnowledgeUpload", async ({ context, caller }) => ({ body: data(await createKnowledgeUploadForApi(context, caller, await readApiBody(request, apiKnowledgeUploadCreateSchema), getStorageProvider())) })),
  completeKnowledgeUpload: (request: Request, { params }: Params<"upload_id">) => handleApiRequest(request, "completeKnowledgeUpload", async ({ context, caller }) => {
    const uploadId = uuidParam((await params).upload_id, "upload_id");
    return { body: data(await completeKnowledgeUploadForApi(context, caller, uploadId, await readApiBody(request, apiKnowledgeUploadCompleteSchema), getStorageProvider())) };
  }),
  cancelKnowledgeSource: (request: Request, { params }: Params<"source_id">) => handleApiRequest(request, "cancelKnowledgeSource", async ({ context, caller }) => ({ body: data(await cancelKnowledgeSourceForApi(context, caller, uuidParam((await params).source_id, "source_id"))) })),

  listWebhooks: (request: Request) => handleApiRequest(request, "listWebhooks", async ({ context, caller }) => ({ body: { data: (await listWebhookEndpoints(context, { businessId: caller.businessId, manager: webhookManager(caller) })).map(toApiEndpoint), next_cursor: null, has_more: false } })),
  createWebhook: (request: Request) => handleApiRequest(request, "createWebhook", async ({ context, caller, credential }) => {
    const body = await readApiBody(request, apiWebhookEndpointCreateSchema);
    requireEventScopes(credential, body.events);
    const created = await createWebhookEndpoint(context, { businessId: caller.businessId, manager: webhookManager(caller), url: body.url, events: body.events, description: body.description });
    return { body: data({ ...toApiEndpoint(created.endpoint), secret: created.secret }) };
  }),
  getWebhook: (request: Request, { params }: Params<"webhook_id">) => handleApiRequest(request, "getWebhook", async ({ context, caller }) => ({ body: data(toApiEndpoint(await getWebhookEndpoint(context, { businessId: caller.businessId, manager: webhookManager(caller), endpointId: uuidParam((await params).webhook_id, "webhook_id") }))) })),
  updateWebhook: (request: Request, { params }: Params<"webhook_id">) => handleApiRequest(request, "updateWebhook", async ({ context, caller, credential }) => {
    const endpointId = uuidParam((await params).webhook_id, "webhook_id");
    const body = await readApiBody(request, apiWebhookEndpointUpdateSchema);
    // A new url redirects the endpoint's existing events, so check those too.
    if (body.events !== undefined || body.url !== undefined) requireEventScopes(credential, body.events ?? (await getWebhookEndpoint(context, { businessId: caller.businessId, manager: webhookManager(caller), endpointId })).events);
    return { body: data(toApiEndpoint(await updateWebhookEndpoint(context, { businessId: caller.businessId, manager: webhookManager(caller), endpointId, url: body.url, events: body.events, description: body.description, status: body.status }))) };
  }),
  deleteWebhook: (request: Request, { params }: Params<"webhook_id">) => handleApiRequest(request, "deleteWebhook", async ({ context, caller }) => {
    const endpointId = uuidParam((await params).webhook_id, "webhook_id");
    await deleteWebhookEndpoint(context, { businessId: caller.businessId, manager: webhookManager(caller), endpointId });
    return { body: data({ id: endpointId, deleted: true }) };
  }),
  testWebhook: (request: Request, { params }: Params<"webhook_id">) => handleApiRequest(request, "testWebhook", async ({ context, caller }) => ({ body: data(await sendWebhookTestEvent(context, { businessId: caller.businessId, manager: webhookManager(caller), endpointId: uuidParam((await params).webhook_id, "webhook_id") })) })),
};
