# Give a business its phone number

A business answers calls and sends texts on a Twilio number that LobbyStack buys for it. The owner picks one in onboarding or in **Settings > Phone number**, and an operator can claim one through the v1 API. This page covers the claim, its limits, what the fork changed and how to debug a failed pick. Checked against `main` at `da1f548`.

## Follow a claim

1. The dashboard searches Twilio for available numbers near the business and shows them. Each number comes with a signed offer that lasts 5 minutes.
2. The owner picks one. The admin reserves the claim in the database, which checks the plan and the limits below.
3. The worker buys the number from Twilio, attaches it to the SIP trunk (`TWILIO_SIP_TRUNK_SID`) and the text webhook, and marks the claim done. The business's context snapshot is refreshed, so the receptionist and the website widget's call button know the number (fork PR #30).
4. A replacement buys the new number first. The old one keeps working for 30 days, so callers who still have it get through, and then the worker releases it back to Twilio.

A released number keeps its row, marked released, and only numbers a business still holds must differ. So when Twilio offers a released number again, any business can buy it (fork PR #93, migration `0124`). Before, that purchase failed after Twilio had charged for the number, and the worker released it again.

The worker needs `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_SIP_TRUNK_SID`. Without them it ends the claim at once and its `job.failed` log line names the missing variable. Before fork PR #32, a claim stayed reserved for 15 minutes and refused the next pick.

## Know the limits

| Limit | Value |
| --- | --- |
| Numbers a plan includes | `businessNumbers` in the brand's `billing.json`: 0 on Free, 1 on Starter and Pro. A business holds one number at most. A cloud business whose plan includes none can't claim one (migration `0112`). |
| Reservations, failed ones included | 3 an hour |
| Numbers bought | 2 a day, 5 in 30 days |
| Offers | 5 minutes each |
| Dashboard searches | 10 first searches and 20 others in each 10 minutes |

The reservation and purchase limits count per person across their businesses, or per business when a platform key claims for it. They live in the database functions from migration `0094`. The search limit is in `apps/admin/src/lib/phone-number-search-limit.ts`.

## Debug "Request failed" and "We couldn't get that number"

Since fork PR #32 the dashboard says why a pick failed: an expired offer, a pick still in progress, a limit reached, or the plan. A real failure shows an Error ID.

1. With an Error ID, search the **admin** service's logs for it. The admin logs each server failure as one JSON line starting with `[admin] exception:`, with the route, the `errorId` and the cause: a database error's SQLSTATE or the carrier's status and code. The number routes run in the admin, not the worker.
2. For "We couldn't get that number", read the **worker**'s `job.failed` line for the claim. The claim's `last_error` also has the reason, which the v1 API shows and the dashboard doesn't.

Since fork PR #105, a deployment without `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` on the admin answers the dashboard's number searches with 503 `phone_numbers_unavailable`, before the search counts against the limit, and the picker says phone numbers aren't set up on this dashboard yet. The v1 API's search answers the same code. Before, the search failed with an Error ID and logged "Phone verification is not configured.", which named neither variable.

## Claim numbers through the API

Platform keys can find, claim, replace and release numbers for the businesses they manage, through the v1 API and the `lobbystack` command (fork PR #5, migration `0094`). An onboarding manifest can ask for a number. Leave `plan` out of a self-hosted deployment's manifests. The app can't adopt a number bought outside it.
