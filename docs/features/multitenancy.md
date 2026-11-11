# Serve many businesses from one deployment

One deployment of LobbyStack serves many businesses. They share one database, one admin and one worker, and PostgreSQL keeps each business's rows apart. This page says what each business has to itself, what the whole deployment shares, and what that means for running it for several clients. Checked against `main` at `da1f548`.

## Know how businesses are kept apart

- Every table in the `public` schema has row-level security turned on and forced, so even the table's owner goes through the policies. Tables with a `business_id` column have policies scoped to the business.
- A request runs in a transaction that sets `app.business_id`. `app.can_access_business` allows a row only when that matches and the user has an active membership in the business (`packages/db/migrations/0002_rls.sql`).
- The admin and the worker connect as least-privilege roles, one per job (auth, app, worker and others, created by `docker/postgres/init/roles.sh`). In production they refuse to start on a privileged role.
- `VERIFY_RLS_BEHAVIOR=true pnpm db:verify-rls` checks that RLS is forced, that one business can't read another's rows, and that a role can't pretend to be another. CI's database job runs it on every pull request.

## Know what belongs to each business

- Members, with a role: `business_owner`, `business_admin`, `scheduler` or `viewer`. A person can belong to several businesses, switch between them in the sidebar and create more, up to [the account's limit](#limit-how-many-businesses-an-account-owns). Since fork PR #101 an owner can delete any business they own but their first, their root ([delete a business](business-deletion.md)). Since fork PR #102 an owner whose root is the only business they own can cancel it instead: its status becomes `canceled`, which closes it to every member at once, since row-level security counts a membership only while its business is active (`app.has_business_membership`), and nothing of it is deleted ([cancel an account](account-cancellation.md)).
- Its phone number, widget keys, public profile, calendar connection, contacts, calls, messages, knowledge, rules and services.
- Its receptionists, since fork PR #129: one default and as many more as its plan allows, each answering the numbers, widget keys and QR links the business gives it, and its QR links' scan counts ([receptionists](receptionists.md)). The tables that link receptionists to articles, questions and links name their business and use composite foreign keys, so the database refuses a link between two businesses, and a QR link's code is unique across the deployment.
- Its billing plan, usage and spending cap, and its own Polar customer (fork PR #72).

Calls find their business by the dialled number, texts by the number they were sent to, the website widget by its key, and a QR link (`/q/<code>`) by its code.

## Know what the deployment shares

- One OpenAI key and its models, and so one OpenAI rate limit and spending limit.
- One Twilio account and SIP trunk, and the shared text sender `TWILIO_ALERT_SMS_FROM`.
- One Polar organization, one Google OAuth app, one email sender and one brand.
- One set of limits: for example GPT-Live's concurrent sessions count across every business.

So one business that is attacked or misbehaves can use up what the others share. Set spending alerts at OpenAI and Twilio, and see [scalability](../reviews/scalability-2026-10-18.md) for what breaks first as businesses are added. Letting each business bring its own OpenAI and Twilio keys was studied on 2026-10-25 and isn't built ([roadmap](../roadmap/business-provider-keys.md)).

## Know who can sign up

Sign-up is open to anyone who can pass the Turnstile check (required everywhere but `localhost`), and there is no switch to close it. A new business gets the deployment's `DEPLOYMENT_MODE`: on `cloud`, the Free plan (30 voice minutes a month and no phone number) until it pays; on `self_hosted_standard`, the self-hosted plan with no limits. On a self-hosted deployment open to the internet, that means anyone can sign up and spend the deployment's OpenAI and Twilio budget. Use the deployment's own OpenAI project and Twilio subaccount with spending limits. A sign-up mode that can close sign-up or limit it to a list is recommended and not built ([roadmap](../roadmap/protect-the-deployment.md)).

There is no console for the person who runs the deployment: `platform_admin` is only a membership rank, and deployment-wide work goes through an operator key and the v1 API ([API and CLI](api-cli-integrations.md#pick-a-key)).

## Limit how many businesses an account owns

Since fork PR #154, one account can own 10 businesses, or the number the brand's `billing.json` sets in `accounts.maxBusinesses`, from 1 to 100 ([businesses per account](../../brands/README.md#businesses-per-account)). Each business adds recurring worker jobs, which is why there is a ceiling. The number comes with the build, so changing it needs a deploy and no apply. Checked on `feature/receptionists` at `f6c8a83`.

- An account owns a business when it is an active owner of an open business, the rows `app.list_user_businesses` lists with the role `business_owner`. A business where it's an admin, scheduler or viewer doesn't count, nor a deleted or canceled one. An operator's open prospect demos count until they're claimed or closed.
- Creating a business, accepting a claim link and claiming a prospect demo each check it, in the same transaction that would add the owner, after locking the account's `users` row so two at once count each other (`assertBusinessAllowanceInTransaction` in `packages/domain/src/server/tenancy.ts`). At the limit they answer 409 `business_limit` and change nothing: the claim link stays open and the demo unclaimed. A business the account already owns, such as the one its own claim link hands back, isn't counted twice.
- A platform key's `POST /v1/businesses` doesn't check it, on purpose: the account the key acts as owns those businesses until their customers claim them, and each claim checks the customer's number.
- Lowering the number takes nothing away: an account above it keeps every business and can't add another until it owns fewer.
- `GET /api/businesses` answers `businessLimit` with how many the account owns and the most it may own. The sidebar shows "2 of 10" beside **Create Business** and, at the limit, turns it off and says why; onboarding's business step says so before a name is typed. The accept-invite and claim-demo pages explain a refusal, and the claim-demo page keeps its link so **Try again** claims once a business is deleted.

There is no limit just for free businesses, no exception for one account, and no cap on how many businesses an account creates in a month; each would need more than the number in `billing.json`.

## Run it for several clients

- **One deployment for all clients**: cheapest. Clients share the providers above and the brand.
- **One deployment per client**: each client gets its own providers, brand, billing and data. The deployment guide [sets a client's production up in the client's own accounts](../deployment/guide/part-5-production.md#55-hand-an-instance-over-to-a-client). Handing a Railway project over moves the project but not the provider accounts.
