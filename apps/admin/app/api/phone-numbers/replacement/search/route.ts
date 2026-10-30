import { NextResponse } from "next/server";

import { searchBusinessNumberInventory, type NumberSelection } from "@lobbystack/domain";
import { asApiResponse, readJson, requireOperatorBusiness } from "@/lib/api-helpers";
import { createDomainContext } from "@/lib/domain-context";
import { assertPhoneNumberSearchAllowed } from "@/lib/phone-number-search-limit";
import { getNumberClaimTokenSecret, requireTwilioProvider } from "@/lib/twilio-provider";

export async function POST(request: Request) {
  try {
    const { session, businessId } = await requireOperatorBusiness(request);
    const body = await readJson(request) as { selection?: Partial<NumberSelection>; limit?: number };
    // Without Twilio the picker says so, before a search counts against the limit or needs the claim secret.
    const twilio = requireTwilioProvider();
    await assertPhoneNumberSearchAllowed({ userId: session.user.id, initial: false });
    const result = await searchBusinessNumberInventory(createDomainContext(), { userId: session.user.id, businessId, purpose: "replacement", ...(body.selection ? { selection: body.selection } : {}), ...(body.limit !== undefined ? { limit: body.limit } : {}), claimTokenSecret: getNumberClaimTokenSecret() }, twilio);
    return NextResponse.json(result);
  } catch (error) { return asApiResponse(error); }
}
