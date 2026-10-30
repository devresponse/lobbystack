import { NextResponse } from "next/server";

import { searchBusinessNumberInventory } from "@lobbystack/domain";
import { asApiResponse, requireOperatorBusiness } from "@/lib/api-helpers";
import { createDomainContext } from "@/lib/domain-context";
import { getNumberClaimTokenSecret, requireTwilioProvider } from "@/lib/twilio-provider";
import { assertPhoneNumberSearchAllowed } from "@/lib/phone-number-search-limit";

export async function GET(request: Request) {
  try {
    const { session, businessId } = await requireOperatorBusiness(request);
    // Without Twilio the picker says so, before a search counts against the limit or needs the claim secret.
    const twilio = requireTwilioProvider();
    await assertPhoneNumberSearchAllowed({ userId: session.user.id, initial: true });
    return NextResponse.json(await searchBusinessNumberInventory(createDomainContext(), { userId: session.user.id, businessId, limit: 10, claimTokenSecret: getNumberClaimTokenSecret() }, twilio));
  } catch (error) { return asApiResponse(error); }
}
