import { NextResponse } from "next/server";
import { z } from "zod";

import { createService, listCatalog } from "@lobbystack/domain";
import { asApiResponse, businessIdFromRequest, requireApiSession, requireOperatorBusiness } from "@/lib/api-helpers";
import { jsonError, parseBody, parseQuery } from "@/lib/request-input";
import { createDomainContext } from "@/lib/domain-context";

export const dynamic = "force-dynamic";

const catalogQuery = z.object({
  search: z.string().trim().min(1).max(160).optional(),
  limit: z.coerce.number("limit must be a number.").int("limit must be a whole number.").min(1, "limit must be at least 1.").max(200, "limit can be 200 at most.").optional(),
  offset: z.coerce.number("offset must be a number.").int("offset must be a whole number.").min(0, "offset cannot be negative.").optional(),
});

const serviceCreate = z.object({
  businessId: z.string().trim().min(1).optional(),
  name: z.string("Give the service a name.").trim().min(1, "Give the service a name.").max(160, "A service name can be 160 characters at most."),
  slug: z.string().trim().min(1, "The web address part cannot be empty.").max(160, "The web address part can be 160 characters at most.").optional(),
  description: z.string().trim().max(2_000, "A description can be 2,000 characters at most.").nullish(),
  durationMinutes: z.coerce.number("Give the service's length in minutes.").int("The length must be a whole number of minutes.").min(1, "The length must be at least a minute.").max(1_440, "The length can be a day at most."),
  active: z.boolean("active is true or false.").optional(),
});

export async function GET(request: Request) {
  try {
    const { session, businessId } = await requireOperatorBusiness(request);
    // zod leaves out a parameter that wasn't sent, and exactOptionalPropertyTypes wants each one named.
    const { search, limit, offset } = parseQuery(request, catalogQuery);
    return NextResponse.json(await listCatalog(createDomainContext(), { userId: session.user.id, businessId, ...(search === undefined ? {} : { search }), ...(limit === undefined ? {} : { limit }), ...(offset === undefined ? {} : { offset }) }));
  } catch (error) {
    return asApiResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireApiSession(request);
    const input = await parseBody(request, serviceCreate);
    const businessId = input.businessId ?? businessIdFromRequest(request);
    if (!businessId) throw jsonError("A businessId is required.", 400, "business_required");
    // A name with no letters or digits leaves nothing to build the web address part from.
    const slug = input.slug ?? input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (!slug) throw jsonError("slug: Give the service's web address part, such as haircut.", 400, "invalid_request");
    const serviceId = await createService(createDomainContext(), { userId: session.user.id, businessId, name: input.name, slug, durationMinutes: input.durationMinutes, ...(input.active === undefined ? {} : { active: input.active }), ...(input.description ? { description: input.description } : {}) });
    return NextResponse.json({ serviceId }, { status: 201 });
  } catch (error) {
    return asApiResponse(error);
  }
}
