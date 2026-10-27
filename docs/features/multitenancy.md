# Serve many businesses from one deployment

One deployment of LobbyStack serves many businesses. They share one database, one admin and one worker, and PostgreSQL keeps each business's rows apart. This page says what each business has to itself, what the whole deployment shares, and what that means for running it for several clients. Checked against `main` at `da1f548`.

## Know how businesses are kept apart

- Every table in the `public` schema has row-level security turned on and forced, so even the table's owner goes through the policies. Tables with a `business_id` column have policies scoped to the business.
- A request runs in a transaction that sets `app.business_id`. `app.can_access_business` allows a row only when that matches and the user has an active membership in the business (`packages/db/migrations/0002_rls.sql`).
- The admin and the worker connect as least-privilege roles, one per job (auth, app, worker and others, created by `docker/postgres/init/roles.sh`). In production they refuse to start on a privileged role.
- `VERIFY_RLS_BEHAVIOR=true pnpm db:verify-rls` checks that RLS is forced, that one business can't read another's rows, and that a role can't pretend to be another. CI's database job runs it on every pull request.

## Know what belongs to each business

- Members, with a role: `business_owner`, `business_admin`, `scheduler` or `viewer`. A person can belong to several businesses, switch between them in the sidebar and create more.
- Its phone number, widget keys, public profile, calendar connection, contacts, calls, messages, knowledge, rules and services.
- Its billing plan, usage and spending cap, and its own Polar customer (fork PR #72).

Calls find their business by the dialled number, texts by the number they were sent to, and the website widget by its key.

## Know what the deployment shares

- One OpenAI key and its models, and so one OpenAI rate limit and spending limit.
- One Twilio account and SIP trunk, and the shared text sender `TWILIO_ALERT_SMS_FROM`.
- One Polar organization, one Google OAuth app, one email sender and one brand.
- One set of limits: for example GPT-Live's concurrent sessions count across every business.

So one business that is attacked or misbehaves can use up what the others share. Set spending alerts at OpenAI and Twilio, and see [scalability](../reviews/scalability-2026-10-18.md) for what breaks first as businesses are added. Letting each business bring its own OpenAI and Twilio keys was studied on 2026-10-25 and isn't built ([roadmap](../roadmap/business-provider-keys.md)).

## Know who can sign up

Sign-up is open to anyone who can pass the Turnstile check (required everywhere but `localhost`), and there is no switch to close it. A new business gets the deployment's `DEPLOYMENT_MODE`: on `cloud`, the Free plan (30 voice minutes a month and no phone number) until it pays; on `self_hosted_standard`, the self-hosted plan with no limits. On a self-hosted deployment open to the internet, that means anyone can sign up and spend the deployment's OpenAI and Twilio budget. Use the deployment's own OpenAI project and Twilio subaccount with spending limits. A sign-up mode that can close sign-up or limit it to a list is recommended and not built ([roadmap](../roadmap/protect-the-deployment.md)).

There is no console for the person who runs the deployment: `platform_admin` is only a membership rank, and deployment-wide work goes through an operator key and the v1 API ([API and CLI](api-cli-integrations.md#pick-a-key)).

## Run it for several clients

- **One deployment for all clients**: cheapest. Clients share the providers above and the brand.
- **One deployment per client**: each client gets its own providers, brand, billing and data. The deployment guide [sets a client's production up in the client's own accounts](../deployment/guide/part-5-production.md#55-hand-an-instance-over-to-a-client). Handing a Railway project over moves the project but not the provider accounts.
