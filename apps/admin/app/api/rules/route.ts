import { NextResponse } from "next/server";
import { z } from "zod";

import { createAgentRule, deleteAgentRule, listAgentRules, reorderAgentRules, updateAgentRule } from "@lobbystack/domain";
import { RULE_CONTENT_MAX_LENGTH, RULE_TITLE_MAX_LENGTH, RULES_MAX } from "@lobbystack/shared";
import { asApiResponse, readJson, requireOperatorBusiness } from "@/lib/api-helpers";
import { createDomainContext } from "@/lib/domain-context";

const createSchema = z.object({ title: z.string().trim().min(1).max(RULE_TITLE_MAX_LENGTH), content: z.string().trim().min(1).max(RULE_CONTENT_MAX_LENGTH), active: z.boolean().optional() });
const updateSchema = z.object({ ruleId: z.uuid(), title: z.string().trim().min(1).max(RULE_TITLE_MAX_LENGTH).optional(), content: z.string().trim().min(1).max(RULE_CONTENT_MAX_LENGTH).optional(), active: z.boolean().optional() });
const reorderSchema = z.object({ ruleIds: z.array(z.uuid()).max(RULES_MAX) });
const deleteSchema = z.object({ ruleId: z.uuid() });

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const { session, businessId } = await requireOperatorBusiness(request);
    return NextResponse.json(await listAgentRules(createDomainContext(), { userId: session.user.id, businessId }));
  } catch (error) { return asApiResponse(error); }
}

export async function POST(request: Request) {
  try {
    const body = createSchema.parse(await readJson(request));
    const { session, businessId } = await requireOperatorBusiness(request);
    return NextResponse.json(await createAgentRule(createDomainContext(), { userId: session.user.id, businessId, title: body.title, content: body.content, ...(body.active === undefined ? {} : { active: body.active }) }), { status: 201 });
  } catch (error) { return asApiResponse(error); }
}

export async function PATCH(request: Request) {
  try {
    const { session, businessId } = await requireOperatorBusiness(request);
    const body = await readJson(request);
    if (typeof body === "object" && body !== null && "ruleIds" in body) {
      const input = reorderSchema.parse(body);
      await reorderAgentRules(createDomainContext(), { ...input, userId: session.user.id, businessId });
    } else {
      const input = updateSchema.parse(body);
      await updateAgentRule(createDomainContext(), { userId: session.user.id, businessId, ruleId: input.ruleId, ...(input.title === undefined ? {} : { title: input.title }), ...(input.content === undefined ? {} : { content: input.content }), ...(input.active === undefined ? {} : { active: input.active }) });
    }
    return NextResponse.json({ ok: true });
  } catch (error) { return asApiResponse(error); }
}

export async function DELETE(request: Request) {
  try {
    const input = deleteSchema.parse(await readJson(request));
    const { session, businessId } = await requireOperatorBusiness(request);
    await deleteAgentRule(createDomainContext(), { ...input, userId: session.user.id, businessId });
    return NextResponse.json({ ok: true });
  } catch (error) { return asApiResponse(error); }
}
