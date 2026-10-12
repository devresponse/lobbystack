import { z } from "zod";

import { BUSINESS_HEADER, PUBLIC_API_AVAILABILITY_MAX_DAYS, PUBLIC_API_DEFAULT_PAGE_SIZE, PUBLIC_API_DEFAULT_RATE_LIMIT_PER_MINUTE, PUBLIC_API_MAX_PAGE_SIZE, PUBLIC_API_VERSION, WEBHOOK_TEST_EVENT_TYPE, apiKeyScopes, businessApiKeyScopes, webhookEventTypes, type ApiKeyScope, type BusinessApiKeyScope } from "./constants";
import {
  apiAppointmentCreateSchema,
  apiAppointmentRescheduleSchema,
  apiAppointmentSchema,
  apiAvailabilitySlotSchema,
  apiBusinessCreateSchema,
  apiBusinessSchema,
  apiBusinessSummarySchema,
  apiBusinessUpdateSchema,
  apiCallDetailSchema,
  apiCallSchema,
  apiContactCreateSchema,
  apiContactSchema,
  apiContactUpdateSchema,
  apiDeletedSchema,
  apiErrorSchema,
  apiKnowledgeEntryCreateSchema,
  apiKnowledgeEntrySchema,
  apiKnowledgeEntryUpdateSchema,
  apiKnowledgeSourceCreateSchema,
  apiKnowledgeSourceSchema,
  apiKnowledgeSourceUpdateSchema,
  apiKnowledgeUploadCompleteSchema,
  apiKnowledgeUploadCreateSchema,
  apiKnowledgeUploadSchema,
  apiMeSchema,
  apiMessageSchema,
  apiReceptionistSchema,
  apiReceptionistUpdateSchema,
  apiServiceSchema,
  apiStaffSchema,
  apiWebhookEndpointCreateSchema,
  apiWebhookEndpointSchema,
  apiWebhookEndpointUpdateSchema,
  apiWebhookEndpointWithSecretSchema,
  apiWebhookEventSchemas,
  apiWebhookTestEventSchema,
  apiWebhookTestResultSchema,
} from "./schemas";

type Param = { name: string; in: "path" | "query" | "header"; required?: boolean; description: string; schema: Record<string, unknown> };

export type ApiOperation = {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  summary: string;
  description?: string;
  tag: string;
  /** null: any valid key may call it. */
  scope: ApiKeyScope | null;
  /**
   * Most operations act on one business: a per-business key's own, or the one
   * a platform key names in the LobbyStack-Business header. optional: a
   * platform key may leave the header out. none: the operation acts on no one
   * business, so only platform keys may call it.
   */
  business?: "optional" | "none";
  params?: Param[];
  list?: boolean;
  /** true: Idempotency-Key makes retries safe. required: the request must send one. */
  idempotent?: boolean | "required";
  request?: string;
  response: string;
  status: 200 | 201 | 202;
};

const idParam = (name: string, what: string): Param => ({ name, in: "path", required: true, description: `The ${what} id.`, schema: { type: "string", format: "uuid" } });
const pageParams: Param[] = [
  { name: "limit", in: "query", description: `Items per page, 1 to ${PUBLIC_API_MAX_PAGE_SIZE}. Defaults to ${PUBLIC_API_DEFAULT_PAGE_SIZE}.`, schema: { type: "integer", minimum: 1, maximum: PUBLIC_API_MAX_PAGE_SIZE } },
  { name: "cursor", in: "query", description: "The next_cursor value from the previous page.", schema: { type: "string" } },
];

/**
 * Every v1 endpoint. Route handlers look up their required scope here, so the
 * scope the docs list is the scope the server enforces.
 */
export const apiOperations = {
  getMe: { method: "GET", path: "/me", tag: "Business", summary: "Check an API key", description: "Returns the key and its business. Any valid key can call it, whatever its scopes, so integrations use it to test a connection. A platform key can call it without the LobbyStack-Business header.", scope: null, business: "optional", response: "Me", status: 200 },
  getBusiness: { method: "GET", path: "/business", tag: "Business", summary: "Get the business", scope: "business:read", response: "Business", status: 200 },
  updateBusiness: { method: "PATCH", path: "/business", tag: "Business", summary: "Update the business", description: "Updates basic fields and opening hours. Sending hours replaces the whole week.", scope: "business:write", request: "BusinessUpdate", response: "Business", status: 200 },
  createBusiness: { method: "POST", path: "/businesses", tag: "Platform", summary: "Create a business", description: "Platform keys only. Creates a business owned by the account in the key's owner_email, and lets every key of the same partner act on it. Idempotency-Key is required: a retry with the same value returns the business it created, however much later, and a different body with that value is a 422.", scope: "businesses:create", business: "none", idempotent: "required", request: "BusinessCreate", response: "Business", status: 201 },
  listBusinesses: { method: "GET", path: "/businesses", tag: "Platform", summary: "List onboarded businesses", description: "Platform keys only. Lists the active businesses the key's partner onboarded, newest first.", scope: "business:read", business: "none", list: true, params: [...pageParams], response: "BusinessSummary", status: 200 },
  getReceptionist: { method: "GET", path: "/receptionist", tag: "Receptionist", summary: "Get the receptionist settings", description: "How the receptionist greets callers, what it says about the business, when it transfers calls and what it may book.", scope: "business:read", response: "Receptionist", status: 200 },
  updateReceptionist: { method: "PATCH", path: "/receptionist", tag: "Receptionist", summary: "Update the receptionist settings", description: "Changes the fields sent and leaves the rest. Calls and chats pick up the change once the business snapshot refreshes. The business default caller language is locale on PATCH /business.", scope: "business:write", request: "ReceptionistUpdate", response: "Receptionist", status: 200 },
  listServices: { method: "GET", path: "/services", tag: "Business", summary: "List services", description: "Lists the active services customers can book.", scope: "business:read", list: true, response: "Service", status: 200 },
  listStaff: { method: "GET", path: "/staff", tag: "Business", summary: "List staff", description: "Lists everyone who can take appointments, active or not. Pass an active staff id as staff_id to GET /availability, POST /appointments or reschedule.", scope: "business:read", list: true, response: "Staff", status: 200 },
  listCalls: { method: "GET", path: "/calls", tag: "Calls", summary: "List calls", description: "Newest first. Filter by start time to read one day or one week.", scope: "calls:read", list: true, params: [...pageParams, { name: "started_after", in: "query", description: "Only calls that started at or after this time.", schema: { type: "string", format: "date-time" } }, { name: "started_before", in: "query", description: "Only calls that started before this time.", schema: { type: "string", format: "date-time" } }], response: "Call", status: 200 },
  getCall: { method: "GET", path: "/calls/{call_id}", tag: "Calls", summary: "Get a call", description: "Includes the transcript.", scope: "calls:read", params: [idParam("call_id", "call")], response: "CallDetail", status: 200 },
  listContacts: { method: "GET", path: "/contacts", tag: "Contacts", summary: "List contacts", description: "Newest first.", scope: "contacts:read", list: true, params: [...pageParams, { name: "phone", in: "query", description: "Only the contact with this E.164 phone number.", schema: { type: "string" } }, { name: "email", in: "query", description: "Only contacts with this email address.", schema: { type: "string" } }, { name: "name", in: "query", description: "Only contacts whose name contains this text. Case does not matter.", schema: { type: "string", maxLength: 200 } }], response: "Contact", status: 200 },
  createContact: { method: "POST", path: "/contacts", tag: "Contacts", summary: "Create a contact", description: "Returns 409 conflict when a contact with the same phone number exists.", scope: "contacts:write", idempotent: true, request: "ContactCreate", response: "Contact", status: 201 },
  getContact: { method: "GET", path: "/contacts/{contact_id}", tag: "Contacts", summary: "Get a contact", scope: "contacts:read", params: [idParam("contact_id", "contact")], response: "Contact", status: 200 },
  updateContact: { method: "PATCH", path: "/contacts/{contact_id}", tag: "Contacts", summary: "Update a contact", scope: "contacts:write", params: [idParam("contact_id", "contact")], request: "ContactUpdate", response: "Contact", status: 200 },
  listAppointments: { method: "GET", path: "/appointments", tag: "Appointments", summary: "List appointments", description: "Newest booking first.", scope: "appointments:read", list: true, params: [...pageParams, { name: "status", in: "query", description: "confirmed or cancelled.", schema: { type: "string", enum: ["confirmed", "cancelled"] } }, { name: "starts_after", in: "query", description: "Only appointments starting at or after this time.", schema: { type: "string", format: "date-time" } }, { name: "starts_before", in: "query", description: "Only appointments starting before this time.", schema: { type: "string", format: "date-time" } }, { name: "contact_id", in: "query", description: "Only this contact's appointments.", schema: { type: "string", format: "uuid" } }], response: "Appointment", status: 200 },
  getAvailability: { method: "GET", path: "/availability", tag: "Appointments", summary: "List open appointment times", description: `Open start times for one service, in 30-minute steps within opening hours. The range can span up to ${PUBLIC_API_AVAILABILITY_MAX_DAYS} days.`, scope: "appointments:read", list: true, params: [{ name: "service_id", in: "query", required: true, description: "The service to book.", schema: { type: "string", format: "uuid" } }, { name: "start_date", in: "query", required: true, description: "First day, YYYY-MM-DD, in the business time zone.", schema: { type: "string", format: "date" } }, { name: "end_date", in: "query", description: "Last day, YYYY-MM-DD. Defaults to start_date.", schema: { type: "string", format: "date" } }, { name: "staff_id", in: "query", description: "Only times this active staff member is free.", schema: { type: "string", format: "uuid" } }], response: "AvailabilitySlot", status: 200 },
  createAppointment: { method: "POST", path: "/appointments", tag: "Appointments", summary: "Book an appointment", description: "Books only when the business's booking_mode is instant. Returns 409 booking_requires_confirmation in request mode and 409 booking_disabled when booking is off.", scope: "appointments:write", idempotent: true, request: "AppointmentCreate", response: "Appointment", status: 201 },
  getAppointment: { method: "GET", path: "/appointments/{appointment_id}", tag: "Appointments", summary: "Get an appointment", scope: "appointments:read", params: [idParam("appointment_id", "appointment")], response: "Appointment", status: 200 },
  cancelAppointment: { method: "POST", path: "/appointments/{appointment_id}/cancel", tag: "Appointments", summary: "Cancel an appointment", description: "Cancelling an appointment that is already cancelled returns it unchanged.", scope: "appointments:write", params: [idParam("appointment_id", "appointment")], response: "Appointment", status: 200 },
  rescheduleAppointment: { method: "POST", path: "/appointments/{appointment_id}/reschedule", tag: "Appointments", summary: "Reschedule an appointment", description: "Moves the appointment to a new open time, with the same staff member unless you pass staff_id. Requires booking_mode instant.", scope: "appointments:write", params: [idParam("appointment_id", "appointment")], request: "AppointmentReschedule", response: "Appointment", status: 200 },
  listMessages: { method: "GET", path: "/messages", tag: "Messages", summary: "List messages", description: "Messages the receptionist took for the team, newest first.", scope: "messages:read", list: true, params: [...pageParams, { name: "status", in: "query", description: "open or done.", schema: { type: "string", enum: ["open", "done"] } }], response: "Message", status: 200 },
  listKnowledgeEntries: { method: "GET", path: "/knowledge", tag: "Knowledge", summary: "List knowledge entries", description: "Text entries and FAQs, newest first. Websites, their pages and files are listed by GET /knowledge/sources.", scope: "knowledge:read", list: true, params: [...pageParams, { name: "type", in: "query", description: "text or faq.", schema: { type: "string", enum: ["text", "faq"] } }], response: "KnowledgeEntry", status: 200 },
  createKnowledgeEntry: { method: "POST", path: "/knowledge", tag: "Knowledge", summary: "Add a knowledge entry", description: "Adds a text entry or an FAQ that the receptionist can use to answer callers.", scope: "knowledge:write", idempotent: true, request: "KnowledgeEntryCreate", response: "KnowledgeEntry", status: 201 },
  getKnowledgeEntry: { method: "GET", path: "/knowledge/{entry_id}", tag: "Knowledge", summary: "Get a knowledge entry", scope: "knowledge:read", params: [idParam("entry_id", "knowledge entry")], response: "KnowledgeEntry", status: 200 },
  updateKnowledgeEntry: { method: "PATCH", path: "/knowledge/{entry_id}", tag: "Knowledge", summary: "Update a knowledge entry", description: "Changes an entry's text, labels or priority, or turns it off or back on. An FAQ stays an FAQ: its title is the question and its content the answer.", scope: "knowledge:write", params: [idParam("entry_id", "knowledge entry")], request: "KnowledgeEntryUpdate", response: "KnowledgeEntry", status: 200 },
  deleteKnowledgeEntry: { method: "DELETE", path: "/knowledge/{entry_id}", tag: "Knowledge", summary: "Delete a knowledge entry", scope: "knowledge:write", params: [idParam("entry_id", "knowledge entry")], response: "Deleted", status: 200 },
  listKnowledgeSources: { method: "GET", path: "/knowledge/sources", tag: "Knowledge", summary: "List knowledge sources", description: "Websites, the pages their crawls read, and uploaded files, newest first.", scope: "knowledge:read", list: true, params: [...pageParams, { name: "type", in: "query", description: "website, page or file.", schema: { type: "string", enum: ["website", "page", "file"] } }, { name: "status", in: "query", description: "pending, processing, indexed, error or cancelled.", schema: { type: "string", enum: ["pending", "processing", "indexed", "error", "cancelled"] } }], response: "KnowledgeSource", status: 200 },
  createKnowledgeSource: { method: "POST", path: "/knowledge/sources", tag: "Knowledge", summary: "Add a website", description: "Starts reading a website the receptionist can answer from. The first crawl reads a sample of the site; POST /knowledge/sources/{source_id}/expand reads the rest. A business still on its website step also takes the address as its website. Sending a site that is already a source returns that source, read again at its own page limit if its last crawl failed or was cancelled. Sending a page an earlier crawl read is a 409.", scope: "knowledge:write", request: "KnowledgeSourceCreate", response: "KnowledgeSource", status: 202 },
  getKnowledgeSource: { method: "GET", path: "/knowledge/sources/{source_id}", tag: "Knowledge", summary: "Get a knowledge source", scope: "knowledge:read", params: [idParam("source_id", "knowledge source")], response: "KnowledgeSource", status: 200 },
  updateKnowledgeSource: { method: "PATCH", path: "/knowledge/sources/{source_id}", tag: "Knowledge", summary: "Turn a knowledge source off or on", description: "Turning a website off leaves the pages its crawl read as they are: each page is its own source.", scope: "knowledge:write", params: [idParam("source_id", "knowledge source")], request: "KnowledgeSourceUpdate", response: "KnowledgeSource", status: 200 },
  deleteKnowledgeSource: { method: "DELETE", path: "/knowledge/sources/{source_id}", tag: "Knowledge", summary: "Delete a knowledge source", description: "Removes a website, page or file from the receptionist's knowledge, with the text read from it. Deleting a website stops its crawl, and the pages it already read stay until you delete them.", scope: "knowledge:write", params: [idParam("source_id", "knowledge source")], response: "Deleted", status: 200 },
  expandKnowledgeSource: { method: "POST", path: "/knowledge/sources/{source_id}/expand", tag: "Knowledge", summary: "Read the rest of a website", description: "Crawls the whole site, up to the full page limit, and replaces the sample the first crawl read. A page or a file is a 400.", scope: "knowledge:write", params: [idParam("source_id", "knowledge source")], response: "KnowledgeSource", status: 202 },
  retryKnowledgeSource: { method: "POST", path: "/knowledge/sources/{source_id}/retry", tag: "Knowledge", summary: "Read a source again", description: "Crawls a website or reads a file again, at the page limit it last used, for example after it failed or the site changed. A source that is still being read is a 409, and a page is a 400: retry its website.", scope: "knowledge:write", params: [idParam("source_id", "knowledge source")], response: "KnowledgeSource", status: 202 },
  createKnowledgeUpload: { method: "POST", path: "/knowledge/uploads", tag: "Knowledge", summary: "Start a file upload", description: "Reserves an upload for a document up to 10 MB and returns where to send it. Send the file's bytes with PUT to upload_url, with exactly upload_headers, within about 15 minutes. Then call POST /knowledge/uploads/{upload_id}/complete. An unfinished upload expires after a day.", scope: "knowledge:write", request: "KnowledgeUploadCreate", response: "KnowledgeUpload", status: 201 },
  completeKnowledgeUpload: { method: "POST", path: "/knowledge/uploads/{upload_id}/complete", tag: "Knowledge", summary: "Finish a file upload", description: "Checks the uploaded file against the upload request and queues it to be read. Returns the new file source. Completing an upload again returns the same source. A file that hasn't arrived yet is a 409 conflict: send it to upload_url, or start a new upload if upload_url has expired. A file that doesn't match the request is a 400. A business whose plan has no room for more knowledge text gets a 409 plan_limit_reached. Send {} to keep the file name as its title.", scope: "knowledge:write", params: [idParam("upload_id", "upload")], request: "KnowledgeUploadComplete", response: "KnowledgeSource", status: 202 },
  cancelKnowledgeSource: { method: "POST", path: "/knowledge/sources/{source_id}/cancel", tag: "Knowledge", summary: "Stop reading a source", description: "Stops a crawl or read that is still processing. A page is a 400: cancel its website. Anything else is a 409.", scope: "knowledge:write", params: [idParam("source_id", "knowledge source")], response: "KnowledgeSource", status: 200 },
  listWebhooks: { method: "GET", path: "/webhooks", tag: "Webhooks", summary: "List webhook endpoints", scope: "webhooks:manage", list: true, response: "WebhookEndpoint", status: 200 },
  // Not idempotent: a stored replay would keep the plain signing secret in idempotency_keys.
  createWebhook: { method: "POST", path: "/webhooks", tag: "Webhooks", summary: "Create a webhook endpoint", description: "Subscribes a URL to events. The key also needs the read scope for each event, such as calls:read for call.completed. The response includes the signing secret once. This endpoint ignores Idempotency-Key, so after a network error, check GET /webhooks before you retry.", scope: "webhooks:manage", request: "WebhookEndpointCreate", response: "WebhookEndpointWithSecret", status: 201 },
  getWebhook: { method: "GET", path: "/webhooks/{webhook_id}", tag: "Webhooks", summary: "Get a webhook endpoint", scope: "webhooks:manage", params: [idParam("webhook_id", "webhook endpoint")], response: "WebhookEndpoint", status: 200 },
  updateWebhook: { method: "PATCH", path: "/webhooks/{webhook_id}", tag: "Webhooks", summary: "Update a webhook endpoint", description: "Setting status to enabled re-enables an endpoint that was disabled after repeated failures. Changing url or events needs the read scope for each of the endpoint's events.", scope: "webhooks:manage", params: [idParam("webhook_id", "webhook endpoint")], request: "WebhookEndpointUpdate", response: "WebhookEndpoint", status: 200 },
  deleteWebhook: { method: "DELETE", path: "/webhooks/{webhook_id}", tag: "Webhooks", summary: "Delete a webhook endpoint", scope: "webhooks:manage", params: [idParam("webhook_id", "webhook endpoint")], response: "Deleted", status: 200 },
  testWebhook: { method: "POST", path: "/webhooks/{webhook_id}/test", tag: "Webhooks", summary: "Send a test event", description: `Queues a ${WEBHOOK_TEST_EVENT_TYPE} event to this endpoint only.`, scope: "webhooks:manage", params: [idParam("webhook_id", "webhook endpoint")], response: "WebhookTestResult", status: 202 },
} as const satisfies Record<string, ApiOperation>;

export type ApiOperationId = keyof typeof apiOperations;

/** Scopes at least one v1 operation requires. */
export const apiScopesInUse: readonly ApiKeyScope[] = apiKeyScopes.filter((scope) => (Object.values(apiOperations) as ApiOperation[]).some((operation) => operation.scope === scope));

/**
 * The scopes Settings > API keys offers: per-business scopes that at least
 * one endpoint uses, so a new scope shows up there with its first endpoint.
 */
export const offeredApiKeyScopes: readonly BusinessApiKeyScope[] = businessApiKeyScopes.filter((scope) => apiScopesInUse.includes(scope));

const componentSchemas: Record<string, z.ZodType> = {
  Error: apiErrorSchema,
  Me: apiMeSchema,
  Business: apiBusinessSchema,
  BusinessUpdate: apiBusinessUpdateSchema,
  BusinessCreate: apiBusinessCreateSchema,
  BusinessSummary: apiBusinessSummarySchema,
  Service: apiServiceSchema,
  Staff: apiStaffSchema,
  Call: apiCallSchema,
  CallDetail: apiCallDetailSchema,
  Contact: apiContactSchema,
  ContactCreate: apiContactCreateSchema,
  ContactUpdate: apiContactUpdateSchema,
  Appointment: apiAppointmentSchema,
  AppointmentCreate: apiAppointmentCreateSchema,
  AppointmentReschedule: apiAppointmentRescheduleSchema,
  AvailabilitySlot: apiAvailabilitySlotSchema,
  Message: apiMessageSchema,
  Receptionist: apiReceptionistSchema,
  ReceptionistUpdate: apiReceptionistUpdateSchema,
  KnowledgeEntry: apiKnowledgeEntrySchema,
  KnowledgeEntryCreate: apiKnowledgeEntryCreateSchema,
  KnowledgeEntryUpdate: apiKnowledgeEntryUpdateSchema,
  KnowledgeSource: apiKnowledgeSourceSchema,
  KnowledgeSourceCreate: apiKnowledgeSourceCreateSchema,
  KnowledgeSourceUpdate: apiKnowledgeSourceUpdateSchema,
  KnowledgeUpload: apiKnowledgeUploadSchema,
  KnowledgeUploadCreate: apiKnowledgeUploadCreateSchema,
  KnowledgeUploadComplete: apiKnowledgeUploadCompleteSchema,
  WebhookEndpoint: apiWebhookEndpointSchema,
  WebhookEndpointWithSecret: apiWebhookEndpointWithSecretSchema,
  WebhookEndpointCreate: apiWebhookEndpointCreateSchema,
  WebhookEndpointUpdate: apiWebhookEndpointUpdateSchema,
  WebhookTestResult: apiWebhookTestResultSchema,
  Deleted: apiDeletedSchema,
  WebhookTestEvent: apiWebhookTestEventSchema,
  ...Object.fromEntries(Object.entries(apiWebhookEventSchemas).map(([type, schema]) => [eventComponentName(type), schema])),
};

function eventComponentName(type: string): string {
  return `${type.split(/[._]/).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("")}Event`;
}

function ref(name: string) {
  return { $ref: `#/components/schemas/${name}` };
}

/** JSON Schema (draft 2020-12) for a v1 contract schema, as the OpenAPI document and the MCP tools publish it. */
export function apiJsonSchemaFor(schema: z.ZodType, io: "input" | "output"): Record<string, unknown> {
  const generated = z.toJSONSchema(schema, { target: "draft-2020-12", io, unrepresentable: "any" }) as Record<string, unknown>;
  delete generated.$schema;
  return stripFormatPatterns(generated) as Record<string, unknown>;
}

// Formats already say uuid or date-time; the generated regexes only add noise.
function stripFormatPatterns(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripFormatPatterns);
  if (!value || typeof value !== "object") return value;
  const entries = Object.entries(value as Record<string, unknown>).filter(([key]) => !(key === "pattern" && typeof (value as Record<string, unknown>).format === "string"));
  return Object.fromEntries(entries.map(([key, entry]) => [key, stripFormatPatterns(entry)]));
}

const errorResponse = (description: string) => ({ description, content: { "application/json": { schema: ref("Error") } } });

/** The OpenAPI 3.1 document for /api/v1, generated from the zod schemas above. */
export function buildOpenApiDocument(input: { serverUrl: string }): Record<string, unknown> {
  const inputs = new Set<string>((Object.values(apiOperations) as ApiOperation[]).flatMap((operation) => ("request" in operation ? [operation.request] : [])));
  const schemas = Object.fromEntries(Object.entries(componentSchemas).map(([name, schema]) => [name, apiJsonSchemaFor(schema, inputs.has(name) ? "input" : "output")]));
  const paths: Record<string, Record<string, unknown>> = {};
  for (const [operationId, operation] of Object.entries(apiOperations) as Array<[string, ApiOperation]>) {
    const data = operation.list ? { type: "array", items: ref(operation.response) } : ref(operation.response);
    const body = operation.list
      ? { type: "object", required: ["data", "next_cursor", "has_more"], properties: { data, next_cursor: { type: ["string", "null"], description: "Pass as cursor to get the next page. Null on the last page." }, has_more: { type: "boolean" } } }
      : { type: "object", required: ["data"], properties: { data } };
    const platformOnly = operation.business === "none";
    const businessParam: Param = {
      name: BUSINESS_HEADER,
      in: "header",
      description: operation.business === "optional"
        ? "The business a platform key acts on. Optional here: without it, business is null. A per-business key never needs it."
        : "The business a platform key acts on. Required with a platform key. A per-business key may leave it out; if it sends one, it must be the key's own business.",
      schema: { type: "string", format: "uuid" },
    };
    const idempotencyParam: Param = operation.idempotent === "required"
      ? { name: "Idempotency-Key", in: "header", required: true, description: "Required. A unique value, up to 255 characters, that makes retries of this request safe.", schema: { type: "string", maxLength: 255 } }
      : { name: "Idempotency-Key", in: "header", description: "A unique value, up to 255 characters, that makes retries of this request safe for 24 hours.", schema: { type: "string", maxLength: 255 } };
    const params = [...(operation.params ?? []), ...(platformOnly ? [] : [businessParam]), ...(operation.idempotent ? [idempotencyParam] : [])];
    paths[operation.path] ??= {};
    paths[operation.path]![operation.method.toLowerCase()] = {
      operationId,
      summary: operation.summary,
      ...(operation.description ? { description: operation.description } : {}),
      tags: [operation.tag],
      security: [{ bearerAuth: [] }],
      ...(operation.scope ? { "x-required-scope": operation.scope } : {}),
      ...(params.length ? { parameters: params } : {}),
      ...(operation.request ? { requestBody: { required: true, content: { "application/json": { schema: ref(operation.request) } } } } : {}),
      responses: {
        [String(operation.status)]: { description: operation.status === 201 ? "Created" : operation.status === 202 ? "Accepted" : "OK", content: { "application/json": { schema: body } } },
        400: errorResponse(operation.idempotent === "required"
          ? "The request is invalid (invalid_request), including a missing Idempotency-Key."
          : operation.business ? "The request is invalid (invalid_request)." : "The request is invalid (invalid_request), or a platform key sent no LobbyStack-Business header (business_required)."),
        401: errorResponse("The API key is missing, invalid, or revoked (unauthorized)."),
        403: errorResponse(["Refused.", ...(operation.scope ? [`insufficient_scope: the key lacks the ${operation.scope} scope.`] : []), platformOnly ? "forbidden: only platform keys can call this endpoint." : `forbidden: a per-business key named another business in ${BUSINESS_HEADER}.`, "key_owner_inactive: a platform key's owner_email has no verified LobbyStack account."].join(" ")),
        ...(platformOnly && !operation.path.includes("{") ? {} : { 404: errorResponse(operation.path.includes("{") ? "Not found (not_found), including a business a platform key cannot act on." : "A platform key named a business it cannot act on (not_found).") }),
        ...(operation.method !== "GET" ? { 409: errorResponse("The request conflicts with the current state.") } : {}),
        ...(operation.idempotent ? { 422: errorResponse("The Idempotency-Key was already used with a different request body (idempotency_key_reused).") } : {}),
        429: { ...errorResponse("Too many requests (rate_limited). Wait for the Retry-After header's number of seconds."), headers: { "Retry-After": { schema: { type: "integer" }, description: "Seconds to wait." } } },
      },
    };
  }
  const webhooks = Object.fromEntries([...webhookEventTypes.map((type) => [type, eventComponentName(type)] as const), [WEBHOOK_TEST_EVENT_TYPE, "WebhookTestEvent"] as const].map(([type, component]) => [type, {
    post: {
      summary: type,
      description: "Signed with the Standard Webhooks scheme: verify webhook-signature against webhook-id, webhook-timestamp and the raw body.",
      parameters: [
        { name: "webhook-id", in: "header", required: true, description: "Event id. The same for every retry of this event.", schema: { type: "string" } },
        { name: "webhook-timestamp", in: "header", required: true, description: "Unix time in seconds when this attempt was signed.", schema: { type: "string" } },
        { name: "webhook-signature", in: "header", required: true, description: "Space-separated signatures, each v1,<base64 HMAC-SHA256>.", schema: { type: "string" } },
      ],
      requestBody: { required: true, content: { "application/json": { schema: ref(component) } } },
      responses: { 200: { description: "Return any 2xx status within 10 seconds to acknowledge the event." } },
    },
  }]));
  return {
    openapi: "3.1.0",
    info: {
      title: "LobbyStack API",
      version: PUBLIC_API_VERSION,
      description: `Read calls, contacts, appointments and messages, book appointments, and subscribe to webhooks. Authenticate with an API key in the Authorization header. A platform key also names the business it acts on in the ${BUSINESS_HEADER} header. Each key allows ${PUBLIC_API_DEFAULT_RATE_LIMIT_PER_MINUTE} requests per minute by default.`,
    },
    servers: [{ url: input.serverUrl }],
    security: [{ bearerAuth: [] }],
    tags: ["Business", "Receptionist", "Calls", "Contacts", "Appointments", "Messages", "Knowledge", "Webhooks", "Platform"].map((name) => ({ name })),
    paths,
    webhooks,
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", description: `An API key from Settings > API keys (lsk_...), which acts on its own business, or a platform key from the PLATFORM_API_KEYS setting (lsp_...), which onboards and manages businesses. Scopes: ${apiKeyScopes.join(", ")}. Only platform keys can hold businesses:create and users:create.` } },
      schemas,
    },
  };
}
