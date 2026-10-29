import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";
import type { z } from "zod";

import { apiOperations, offeredApiKeyScopes, zapierApiKeyScopes, zapierOperationIds } from "./operations";
import { apiAppointmentSchema, apiCallSchema, apiContactSchema, apiKnowledgeEntrySchema, apiMessageSchema, apiServiceSchema, apiStaffSchema } from "./schemas";

// The Zapier integration's samples, which people see while they build a Zap
// before any real data arrives. It is plain CommonJS outside the workspace.
const { samples } = createRequire(import.meta.url)("../../../../integrations/zapier/lib/resources.js") as { samples: Record<string, Record<string, unknown>> };

describe("the key Settings > API keys sets up for Zapier", () => {
  it("allows exactly what the Zapier integration's operations need", () => {
    expect(zapierApiKeyScopes).toEqual(["business:read", "calls:read", "contacts:read", "contacts:write", "appointments:read", "appointments:write", "messages:read", "knowledge:write", "webhooks:manage"]);
    for (const id of zapierOperationIds) {
      const { scope } = apiOperations[id] as { scope: string | null };
      if (scope) expect(zapierApiKeyScopes).toContain(scope);
    }
    expect(offeredApiKeyScopes).toEqual(expect.arrayContaining([...zapierApiKeyScopes]));
  });
});

describe("the Zapier integration's samples", () => {
  const schemas: Record<string, z.ZodObject> = {
    call: apiCallSchema,
    contact: apiContactSchema,
    appointment: apiAppointmentSchema,
    message: apiMessageSchema,
    knowledgeEntry: apiKnowledgeEntrySchema,
    service: apiServiceSchema,
    staff: apiStaffSchema,
  };

  it.each(Object.keys(schemas))("match what the API returns for a %s", (resource) => {
    const sample = samples[resource]!;
    const schema = schemas[resource]!;
    expect(schema.safeParse(sample).error?.issues ?? []).toEqual([]);
    expect(Object.keys(sample).sort()).toEqual(Object.keys(schema.shape).sort());
  });
});
