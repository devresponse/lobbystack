# Deploy to Railway with one command

A new deployment follows the [deployment guide](../deployment/guide/README.md) by hand. A study on 2026-10-14 designed a bootstrap script that would deploy LobbyStack from the fork with one settings file of about six values, one command and one sign-up, without Railway's hosted template, which the maintainer ruled out ([Railway automation](../research/railway-automation.md)).

- **Status:** not started; whether to build it is undecided.
- **Effort:** a few days of building and testing (an estimate).

## Know what it would do

Create the Railway project and its six parts (Postgres with pgvector, Redis, a storage bucket, the migrator, the admin and the worker), generate the 15 secrets, set about 100 variable entries and the domain, and deploy in the right order. With the master accounts in place, it would also create for each deployment a Twilio subaccount and SIP trunk, an OpenAI project with its key, spend limit and call webhook, a Turnstile widget and an email sending key, then create the business and buy its number with the `lobbystack` CLI.

## Build it this way

- `.railway/selfhost.ts`, a self-hosting definition derived from `.railway/template.ts`; `scripts/bootstrap-railway.mjs`, which wraps the Railway CLI and the providers' APIs; and, if wanted, a GitHub Actions workflow with a "Run workflow" button.
- The definition is applied twice, since Railway can't make one service wait for another and the admin's build needs the address and keys that exist only after the first apply: first the migrator alone, then the admin and the worker with every build-time value set.
- Every step looks for what it made before creating anything, so a failed run can be restarted; later changes go through `railway config plan` and `apply`.

Four changes to the fork would remove the last manual steps: a `bootstrap-owner` command in the migrator, so no sign-up form is needed before onboarding; adopting a number already bought in Twilio; reading the Turnstile site key and the storage address at run time, so one prebuilt admin image serves every deployment; and a sign-up allowlist.

## Prove these first

Whether OpenAI's API can create the call webhook, how GPT-Live SIP gets turned on for a project, whether a later apply can add a source to a service created without one, and whether Twilio trunks need Opus from Twilio's sales team. Test an inbound call on the first OpenAI project before promising a date.

## Decide these

- Build the script, and with it the four changes to the fork?
