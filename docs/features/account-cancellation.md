# Cancel an account

Since fork PR #102, an owner whose account is down to one business, its root, can cancel the account from **Settings > Team**, where a later business has **Delete business** instead. Nothing is deleted: the business is closed to its whole team, its numbers stop answering, and its owner starts again as a new account, through onboarding. The deployment's operator can open it again. Checked against the code of fork PR #102.

## Know when Cancel account shows

- **On the account's root,** the business its owner has owned longest ([delete a business](business-deletion.md#know-which-businesses-can-be-deleted)), once it's the only business they own. The order they deleted the others in doesn't matter. Businesses they help run as an admin or a viewer don't count.
- **An owner who owns other businesses** sees the Delete section's note on their root instead: delete the others first, then cancel this one.
- **Only owners.** Admins and viewers don't see the section, and the server refuses them.
- **A business with two owners** can be canceled by either of them, once it's the only business that owner owns. It closes for both.

## Cancel the account

1. Open **Settings > Team**. The last section is **Cancel account**.
2. Click **Cancel account**. The dialog says what canceling does, and that nothing is deleted and nothing changes yet.
3. Type the business's name exactly as it's shown and click **Request cancellation**. The dialog says which address the link went to.
4. Open the email "Confirm canceling <business>" and its button **Confirm the cancellation**. The link works for 24 hours. Asking again sends a new link, and the earlier one stops working.
5. Sign in as the owner who asked, if you aren't already. Signed in as someone else, the page offers to sign in with another account.
6. Enter your password and click **Cancel account**. The page says the account is canceled.
7. **Start a new business** opens onboarding. The new business is the account's root, on the free plan, at a new address: the canceled business keeps its slug.

## Know who's told

- **The owner** gets the confirmation email, in their dashboard language.
- **The deployment's inbox** gets "Cancellation request: <business>" when the owner asks, and "Canceled: <business>" when they confirm. Both are in English and list the business's ID, slug, type, time zone, website, creation date, owners, team size, plan and phone numbers, with who asked and when. The second also says what happened to the plan and the numbers, and points to [reactivating it](../deployment/guide/part-7-operations.md#727-reactivate-a-canceled-business).
- **The inbox is the brand's `contactEmail`** in `brands/<brand>/brand.json`, else `FEEDBACK_TO_EMAIL`. With neither, nobody is told: the admin logs the warning `business.cancellation_inbox_missing`, and the owner can still cancel. It never falls back to LobbyStack's own addresses, as other contact links do.

## Know what happens when you cancel

- **Closed to the whole team at once,** the owner included: every dashboard page and API route of the business. Row-level security counts a membership only while its business is active (`app.has_business_membership`, migration `0130`). The memberships themselves stay as they were.
- **Whoever had it open** moves to another business of theirs, one they own first. Someone left with none, the owner usually, is asked to create a business at their next visit.
- **Its phone numbers stop answering at once.** Calls are turned away (`live.incoming_closed_business` in the admin's log), and texts get no reply. The numbers go back to Twilio 30 days later, by the worker's hourly `phone-number-reclaim` job, unless the business is reactivated first. The deployment's shared text sender (`TWILIO_ALERT_SMS_FROM`) stays.
- **It sends its customers nothing more:** no confirmations, reminders or texts, including ones already scheduled.
- **Its website widget, public page, API keys, connected apps and invitations stop working,** and platform API keys no longer reach it. The lookup behind each requires an active business, the invitations' since migration `0130`.
- **A paid plan ends at once.** Confirming queues `billing.revokeSubscription`, and the worker revokes the subscription in Polar, as for a delete. The worker's Polar token needs `subscriptions:write`. A plan set by hand (`managed`) isn't touched: the inbox's email says to end it. Polar keeps the customer and its orders.
- **The worker keeps only its housekeeping:** the retention sweeps, unused upload cleanup, the numbers' release, the telemetry flush and the cost rollup, at the pace of an idle business. Its other recurring jobs, such as calendar sync and the daily summary, stop within 5 minutes.
- **Nothing is deleted:** calls, transcripts, recordings, contacts, appointments, knowledge, settings, billing history and the audit log all stay. The business's retention settings keep applying, as before.
- **A record of who did it:** the audit log gets `business.cancellation_requested` and `business.canceled`, and the admin logs the same two events.

What it can't stop: webhook deliveries already queued for the business can still go out, and texts or emails already handed to Twilio or the mail server.

## Know when it's refused

| What the page says | Why |
| --- | --- |
| You own other businesses | Delete them first. Checked when asking and again when confirming |
| Only an owner of this business can cancel it | Admins and viewers can't |
| The name doesn't match | The typed name must match as shown; spaces around it don't count |
| That password isn't right | Your sign-in password. It clears, so you type it again |
| Sign in with that account | The link went to another owner's address |
| This link has expired | After 24 hours. Ask again in **Settings > Team** |
| A newer cancellation link was sent | Only the latest link works |
| This business is already canceled | The link was used |
| A phone number is still being set up | Try again in a few minutes |
| A call is in progress | Try again when it ends |
| A plan purchase started less than an hour ago | Polar's checkout page stays payable for an hour |
| Too many tries | 5 requests an hour and 10 confirmations an hour per person |

## Bring a canceled business back

The deployment's operator runs `app.reactivate_business` signed in to the database as `postgres`, with the business ID from the inbox's emails. [Guide 7.27](../deployment/guide/part-7-operations.md#727-reactivate-a-canceled-business) has the steps. It opens the business to its team again, keeps the numbers that are still the business's, and writes `business.reactivated` to its audit log.

It doesn't bring back the paid plan, which the owner buys again from **Settings > Plan**, or numbers already given back to Twilio. An owner who started a new business meanwhile then owns two: the reactivated one, which is older, is their root again, and the new one can be deleted.

## Know how it's kept safe

- **The database decides.** Migration `0130` refuses any change to a business's status by the dashboard's database role except through `app.cancel_business`, which checks again that the caller is an active owner and that the business is their root and the only business they own. `app.reactivate_business` is granted to no role, so only `postgres` can run it.
- **Asking does nothing on its own.** The link needs the owner who asked, signed in, and their password. Its token is stored hashed, as invitations' are.
- **The limits come before the password check,** so the page can't be used to guess a password.
- **The server checks everything again** when confirming, in one transaction (`confirmBusinessCancellation` in `packages/domain/src/server/businessCancellation.ts`), and names the business only from the link, never from the active one.

The routes are `POST` and `GET /api/businesses/cancellation`, `POST /api/businesses/cancellation/confirm` and the page `/{locale}/cancel-account` ([route catalog](../reference/routes.md#businesses-and-team)). The v1 API and the MCP server have no cancel on purpose ([API gaps](../reference/api-gaps.md)).

## Know how it's tested

- `packages/domain/src/server/businessCancellation.integration.test.ts`, under `pnpm test:reliability` against PostgreSQL with the real roles: the emails and the inbox, who may ask and when, replaced and expired links, the whole team locked out with nothing deleted, the numbers, the plan, starting again, the database's refusals and reactivation. Taking the business's status out of `app.has_business_membership` or the phone lookup, or dropping the trigger, fails it. `cancellationText.integration.test.ts` covers texts and reminders.
- The routes (`apps/admin/app/api/businesses/cancellation/route.test.ts` and `confirm/route.test.ts`), the Team page (`apps/admin/src/components/live-team-surface.test.tsx`), the confirmation page (`cancel-account-surface.test.tsx`), the call webhook (`apps/admin/app/api/webhooks/openai/live/route.test.ts`), the worker's schedules (`apps/worker/src/scheduler.test.ts`) and the three emails (`packages/providers/src/email/templates.test.ts`).
- A browser journey, `apps/admin/e2e/business-cancellation.e2e.ts`: an owner asks, gets the link, gives a wrong password and then the right one, and starts a new business.

Not tried yet: a cancellation on a deployment, a paid plan on Polar's sandbox, a call to a real Twilio number after a cancellation, the emails in real mailboxes, and a reactivation ([open items](../project/open-items.md)).
