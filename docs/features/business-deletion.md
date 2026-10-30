# Delete a business

Since fork PR #101, an owner can delete a business, with everything in it, from **Settings > Team** in the dashboard. It can't be undone. An account's first business, its root, can never be deleted this way, so only an owner with more than one business can delete one: one of the later ones. The original project added a delete of its own in October 2026; the fork's was written for it instead of being copied. Checked against the code of fork PR #101.

## Know which businesses can be deleted

- **Each account has a root business:** the one its owner has owned longest, their earliest owner membership that's still active, among the businesses their workspace menu shows. For a normal sign-up that's the business made during onboarding. Ties go to the business made first. `app.root_business_id` in migration `0129` decides it.
- **A root business stays.** A business is refused when it's the root of any of its owners, so a later business of yours that is another co-owner's first can't be deleted by either of you.
- **An owner with one business can't delete it**, since it's their root. The Team page says why instead of showing the button.
- **Only owners delete.** The Team page calls owners and admins both "Admin", but only a `business_owner` sees the section and only one can delete; admins, schedulers and viewers can't.
- **The root moves when its owner leaves.** If an owner hands their first business over or is removed from it, their next oldest business becomes their root.

Nothing in the dashboard, the v1 API, the MCP server or the command line deletes a root business. Someone signed in to the database as `postgres` still can, as test fixtures and repair scripts do; that skips everything listed under [what happens](#know-what-happens-when-you-delete), so end the plan, release the numbers and delete the files by hand first.

## Delete a business

1. Open the business from the workspace menu at the top of the sidebar.
2. Open **Settings > Team**. The last section, **Delete business**, either has the button or says why this business can't be deleted.
3. Click **Delete business**. The dialog says what goes, and warns in red: "This is permanent. Nothing can be restored, by you or by support."
4. Type the business's name exactly as it's shown, capitals included, and your password. **Delete permanently** stays off until the name matches and the password is filled in.
5. Once it's deleted, the dashboard opens Home on another of your businesses.

A business with a paid plan takes a few seconds longer: the worker cancels the plan in Polar first, and the dialog waits up to 20 seconds for it. If it says the plan is being canceled, select **Delete permanently** again a moment later.

## Know what happens when you delete

- **Erased:** the business and every row that belongs to it: its team's memberships and invitations, calls, transcripts and summaries, texts and chats, contacts, appointments, knowledge, rules, services, hours, settings, widget keys, API keys, webhooks, billing account, usage and history, and its audit log. So do the provider events, analytics events and feedback that name it, which would otherwise outlive it unlinked, and the OAuth grants given to apps for it. Jobs and emails for it that haven't gone out are dropped.
- **Its files:** recordings, documents and uploads are deleted from storage by worker jobs (`privacy.deleteStoredObjects`, 500 files a job), which delete only files under the business's own folder and only once the business is gone.
- **Its phone numbers** go back to Twilio by worker jobs (`phoneNumber.releaseDeleted`), so they stop ringing and costing. The deployment's shared text sender (`TWILIO_ALERT_SMS_FROM`) stays. A release that keeps failing warns on its last try, about three hours later, with the number to release in Twilio's console.
- **A paid plan ends at once.** The admin's Polar token can't change subscriptions, so the delete queues `billing.revokeSubscription` and the worker revokes the subscription with its own token, which needs `subscriptions:write`. The delete goes ahead only once the plan has ended. Polar keeps the customer and its orders and invoices. A plan that Polar has set to end with its period counts as ended, since nothing renews it.
- **Its public page** at `/profile/<slug>` stops answering, and so does the website widget on its site. The slug is free again, so a business made later could take it, and the business's printed QR signs would then open that business's page: take the signs down first.
- **Its scheduled jobs stop.** A running worker drops a deleted business's recurring jobs within 5 minutes, and a worker that starts drops any that a business deleted while no worker ran left in Redis (`configureSchedulers` in `apps/worker/src/scheduler.ts`).
- **People keep their accounts.** Only their place on the business goes. Whoever had it open moves to another business of theirs, one they own first, and someone left with no business is asked to create one at their next visit.
- **A referrer's commissions** for the business go with it. Payouts already made stay as they were.

What it can't reach: OpenAI's own copy of each call's recording, kept 30 days; Twilio's logs; the emails after each call in the team's mailboxes; what webhooks already delivered; events already sent to PostHog; and backups until they age out ([guide 7.9](../deployment/guide/part-7-operations.md#79-data-retention-and-deletion-requests)).

## Know when it's refused

| What the dialog says | Why |
| --- | --- |
| The first business on your account, or on another owner's | It's a root business ([above](#know-which-businesses-can-be-deleted)) |
| The only business you own | Your root, with nothing else to move to |
| The name doesn't match | The typed name must match as shown; spaces around it don't count |
| That password isn't right | Your sign-in password. The name stays typed and the password clears |
| A phone number is still being set up | A number bought after the delete would belong to no business. Try again in a few minutes |
| A call is in progress | Try again when it ends |
| A plan purchase started less than an hour ago | Polar's checkout page stays payable for an hour, and a payment after the delete would buy a plan for a business that's gone |
| The plan is billed outside the app | A plan the deployment's operator set by hand (`managed`). Support ends it first |
| The plan is being canceled | The worker is canceling it. Try again in a moment |
| The plan couldn't be canceled | The worker has tried for 10 minutes. Usually the worker's Polar token lacks `subscriptions:write`, which the worker's warning in PostHog says |
| Too many tries | 10 tries an hour per person |

## Know how it's kept safe

- **The database refuses a root business.** Migration `0129` adds a trigger on `businesses` that, for the dashboard's database role, refuses to delete any owner's root business and anything not asked for by an active owner of the business. A bug in the code above it can't get past that. The worker's and migrator's roles keep their deletes, for test fixtures and repair scripts.
- **The server checks everything again** in one transaction (`deleteBusiness` in `packages/domain/src/server/businessDeletion.ts`): owner, root, name, and nothing under way. It names the business only by the request's address, never by the active one, so a stale tab can't delete the wrong business.
- **The password is checked** with Better Auth's own check, and the limit of 10 tries an hour comes before it, so the dialog can't be used to guess a password.
- **The worker's jobs can't be turned on a live business:** each releases a number or deletes files only once its business no longer exists.
- **A record of who deleted it:** the business's audit log goes with it, so the admin writes a `business.deleted` log line with the business's and the person's IDs, and how many numbers and files went.

The route is `DELETE /api/businesses?businessId=` with `confirmName` and `password` in the body ([route catalog](../reference/routes.md#8-dashboard-api)). The v1 API and the MCP server have no delete on purpose ([API gaps](../reference/api-gaps.md)).

## Know how it's tested

- `packages/domain/src/server/businessDeletion.integration.test.ts`, under `pnpm test:reliability` against PostgreSQL with the real roles: root businesses refused in the domain and by the database trigger, another owner's root, the root moving on, owners only, the typed name, everything under way, paid plans, and a delete that leaves no row behind while the root business keeps its own. Breaking the trigger or `app.is_root_business` fails it.
- The route (`apps/admin/app/api/businesses/route.test.ts`), the Team page (`apps/admin/src/components/live-team-surface.test.tsx`), the worker's three jobs (`apps/worker/src/handlers.businessDeletion.test.ts`), the schedulers dropped at a worker's start (`apps/worker/src/scheduler.test.ts`) and Polar's revoke (`packages/providers/src/polar/polarBilling.test.ts`).
- A browser journey, `apps/admin/e2e/business-deletion.e2e.ts`: an owner deletes a second business after a wrong password, and their first is refused both on the Team page and through the API.

Not tried yet: a delete on a deployment, a paid plan on Polar's sandbox, and a real Twilio number's release ([open items](../project/open-items.md)).
