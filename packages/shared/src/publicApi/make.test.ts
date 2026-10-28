import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { webhookEventResource, type WebhookEventType } from "./constants";
import { apiComponentSchemas, apiOperations, makeApiKeyScopes, makeOperationIds, makeWebhookEvents, offeredApiKeyScopes, type ApiOperation, type ApiOperationId } from "./operations";
import { apiAppointmentSchema, apiCallSchema, apiContactSchema, apiMessageSchema } from "./schemas";

// The Make app in integrations/make, in the local format of Make's Apps Editor:
// makecomapp.json names each component's code files, which are JSON with IML
// expressions such as {{parameters.contact_id}} in their strings.
const APP = fileURLToPath(new URL("../../../../integrations/make/app/", import.meta.url));

type Component = { label: string; moduleType?: string; webhook?: string; codeFiles: Record<string, string | null> };
type Param = { name: string; options?: unknown };
type Field = { name: string; type: string; spec?: Field[] | { type: string } };
type Request = { url: string; method?: string; qs?: Record<string, unknown>; body?: unknown; pagination?: { qs?: Record<string, unknown> } };

const read = (file: string): unknown => JSON.parse(readFileSync(APP + file, "utf8"));
const app = read("makecomapp.json") as { components: Record<"connection" | "webhook" | "module" | "rpc", Record<string, Component>> };
const code = (component: Component, type: string): unknown => read(component.codeFiles[type]!);
const requestsIn = (communication: unknown): Request[] => (Array.isArray(communication) ? communication : [communication]).filter((request: Request) => Boolean(request.url));
const operation = (id: ApiOperationId) => apiOperations[id] as ApiOperation;
// Parameters, with the ones nested under a select's options.
const paramNames = (params: Param[]): string[] => params.flatMap((param) => [param.name, ...(Array.isArray(param.options) ? paramNames(param.options.flatMap((option: { nested?: Param[] }) => option.nested ?? [])) : [])]);

/** The operation a request calls: "/contacts/{{parameters.contact_id}}" matches "/contacts/{contact_id}". */
function operationFor(request: Request): ApiOperationId {
  const shape = (path: string) => path.replace(/\{\{[^}]+\}\}|\{[a-z_]+\}/g, "{}");
  const method = request.method ?? "GET";
  // The connection check builds its own URL; everything else is relative to the base, /api/v1.
  const url = request.url.replace(/^\{\{temp\.dashboardUrl\}\}\/api\/v1/, "");
  const [id, ...others] = (Object.keys(apiOperations) as ApiOperationId[]).filter((candidate) => operation(candidate).method === method && shape(operation(candidate).path) === shape(url));
  if (!id || others.length) throw new Error(`${method} ${request.url} matches ${others.length ? "several operations" : "no operation"}.`);
  return id;
}

/** Each set of fields a body can send: one, or one per pick(parameters, ...) it chooses between. */
function bodyFields(body: unknown, params: string[]): string[][] {
  const omitted = (expression: string) => {
    const match = /^\{\{omit\(parameters((?:, '[a-z_]+')*)\)\}\}$/.exec(expression);
    if (!match) throw new Error(`Unexpected body expression ${expression}.`);
    const names = [...match[1]!.matchAll(/'([a-z_]+)'/g)].map(([, name]) => name);
    return params.filter((name) => !names.includes(name));
  };
  if (body === undefined) return [[]];
  if (typeof body === "string") {
    const picks = [...body.matchAll(/pick\(parameters((?:, '[a-z_]+')+)\)/g)].map(([, names]) => [...names!.matchAll(/'([a-z_]+)'/g)].map(([, name]) => name!));
    return picks.length ? picks : [omitted(body)];
  }
  const { "{{...}}": spread, ...fields } = body as Record<string, unknown>;
  return [[...new Set([...(typeof spread === "string" ? omitted(spread) : []), ...Object.keys(fields)])]];
}

/** The fields a request schema takes: one list for an object, one per option of a discriminated union. */
function requestShapes(schema: z.ZodType): string[][] {
  if (schema instanceof z.ZodDiscriminatedUnion) return (schema.options as z.ZodObject[]).map((option) => Object.keys(option.shape));
  if (schema instanceof z.ZodObject) return [Object.keys(schema.shape)];
  throw new Error("Unexpected request schema.");
}

/** Every field name in an output, nested ones as parent.child. */
function interfaceNames(fields: Field[], prefix = ""): string[] {
  return fields.flatMap((field) => [prefix + field.name, ...(Array.isArray(field.spec) ? interfaceNames(field.spec, `${prefix}${field.name}.`) : [])]).sort();
}
function schemaNames(schema: z.ZodType, prefix = ""): string[] {
  const inner = (type: z.ZodType): z.ZodType => (type instanceof z.ZodNullable || type instanceof z.ZodOptional ? inner(type.unwrap() as z.ZodType) : type);
  const object = (type: z.ZodType): z.ZodObject | null => {
    const unwrapped = inner(type);
    const element = unwrapped instanceof z.ZodArray ? inner(unwrapped.element as z.ZodType) : unwrapped;
    return element instanceof z.ZodObject ? element : null;
  };
  const shape = object(schema)!.shape as Record<string, z.ZodType>;
  return Object.entries(shape).flatMap(([name, type]) => [prefix + name, ...(object(type) ? schemaNames(type, `${prefix}${name}.`) : [])]).sort();
}

// Every request the app makes, except Make an API call, whose path the user types.
const calls: Array<{ component: string; request: Request; params: string[] }> = [
  ...Object.entries(app.components.connection).flatMap(([id, connection]) => requestsIn(code(connection, "communication")).map((request) => ({ component: `connection ${id}`, request, params: [] }))),
  ...Object.entries(app.components.webhook).flatMap(([id, webhook]) => ["attach", "detach"].flatMap((type) => requestsIn(code(webhook, type)).map((request) => ({ component: `webhook ${id} ${type}`, request, params: [] })))),
  ...Object.entries(app.components.module).filter(([, module]) => module.moduleType !== "instant_trigger" && module.moduleType !== "universal").flatMap(([id, module]) => requestsIn(code(module, "communication")).map((request) => ({ component: `module ${id}`, request, params: paramNames(code(module, "mappableParams") as Param[]) }))),
  ...Object.entries(app.components.rpc).flatMap(([id, rpc]) => requestsIn(code(rpc, "communication")).map((request) => ({ component: `drop-down ${id}`, request, params: [] }))),
];
const triggerEvent = (module: Component): WebhookEventType => (code(app.components.webhook[module.webhook!]!, "attach") as { body: { events: [WebhookEventType] } }).body.events[0];

describe("the key Settings > API keys sets up for Make", () => {
  it("allows exactly what the Make app's operations and triggers need", () => {
    expect(makeApiKeyScopes).toEqual(["business:read", "calls:read", "contacts:read", "contacts:write", "appointments:read", "appointments:write", "messages:read", "knowledge:write", "webhooks:manage"]);
    for (const id of makeOperationIds) {
      const { scope } = operation(id);
      if (scope) expect(makeApiKeyScopes).toContain(scope);
    }
    expect(offeredApiKeyScopes).toEqual(expect.arrayContaining([...makeApiKeyScopes]));
  });
});

describe("the Make app's API calls", () => {
  it("are the operations in makeOperationIds, and its triggers watch makeWebhookEvents", () => {
    expect(new Set(calls.map(({ request }) => operationFor(request)))).toEqual(new Set(makeOperationIds));
    const triggers = Object.values(app.components.module).filter((module) => module.moduleType === "instant_trigger");
    expect(triggers.map(triggerEvent).sort()).toEqual([...makeWebhookEvents].sort());
  });

  it("never need an Idempotency-Key, which Make has nothing to make one from", () => {
    for (const id of makeOperationIds) expect(operation(id).idempotent, id).not.toBe("required");
  });

  it("send only query parameters the operation takes", () => {
    for (const { component, request } of calls) {
      const taken = (operation(operationFor(request)).params ?? []).filter((param) => param.in === "query").map((param) => param.name);
      for (const name of [...Object.keys(request.qs ?? {}), ...Object.keys(request.pagination?.qs ?? {})]) expect(taken, `${component} sends ${name}`).toContain(name);
    }
  });

  it("send only body fields the operation takes, since unknown fields are refused", () => {
    for (const { component, request, params } of calls) {
      const sent = bodyFields(request.body, params);
      const { request: name } = operation(operationFor(request));
      if (!name) {
        expect(sent, component).toEqual([[]]);
        continue;
      }
      const shapes = requestShapes(apiComponentSchemas[name as keyof typeof apiComponentSchemas]);
      for (const fields of sent) expect(shapes.some((keys) => fields.every((field) => keys.includes(field))), `${component} sends ${fields.join(", ")}`).toBe(true);
    }
  });
});

describe("the Make app's samples and output fields", () => {
  const eventSchemas = { call: apiCallSchema, appointment: apiAppointmentSchema, message: apiMessageSchema, contact: apiContactSchema };
  const modules = Object.entries(app.components.module).filter(([, module]) => module.moduleType !== "universal");

  it.each(modules.map(([id]) => id))("%s matches what the API returns", (id) => {
    const module = app.components.module[id]!;
    const schema = module.moduleType === "instant_trigger"
      ? eventSchemas[webhookEventResource[triggerEvent(module)]]
      : apiComponentSchemas[operation(operationFor(requestsIn(code(module, "communication"))[0]!)).response as keyof typeof apiComponentSchemas] as z.ZodObject;
    const sample = code(module, "samples") as Record<string, unknown>;
    expect(schema.safeParse(sample).error?.issues ?? []).toEqual([]);
    expect(Object.keys(sample).sort()).toEqual(Object.keys(schema.shape).sort());
    expect(interfaceNames(code(module, "interface") as Field[])).toEqual(schemaNames(schema));
  });
});
