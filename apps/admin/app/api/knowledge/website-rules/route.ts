import { NextResponse } from "next/server";

import { createWebsiteRuleInTransaction, listWebsiteRulesInTransaction, readWebsiteRuleInput } from "@lobbystack/domain";
import { asApiResponse, readJson, withOperatorTransaction } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

// Website rules on the Knowledge page: each gives the pages of a website the
// business added under a path, such as /stores/kitsilano/, to one
// receptionist, now and on every crawl. GET lists them with how many pages
// each gave; anyone on the team reads them. POST adds one, for owners and
// admins.

export async function GET(request: Request) {
  try {
    return NextResponse.json(await withOperatorTransaction(request, async ({ businessId, tx }) => ({
      rules: await listWebsiteRulesInTransaction(tx, { businessId }),
    })));
  } catch (error) { return asApiResponse(error); }
}

export async function POST(request: Request) {
  try {
    const rule = readWebsiteRuleInput(await readJson(request));
    const created = await withOperatorTransaction(request, async ({ session, businessId, tx }) => (
      await createWebsiteRuleInTransaction(tx, { businessId, actorUserId: session.user.id, rule })
    ), { minimumRole: "business_admin" });
    return NextResponse.json({ rule: created }, { status: 201 });
  } catch (error) { return asApiResponse(error); }
}
