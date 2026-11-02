# Remove a Railway deployment's last manual steps

Since fork PR #113 (2026-11-01), `devops/bootstrap.mjs` sets up a Railway deployment and its outside services from one settings file, and stops at the steps only a person can do ([devops/bootstrap.md](../../devops/bootstrap.md)). It has set up a real test environment, which answered a phone call on 2026-11-02. A study on 2026-10-14 proposed four changes to the fork that would remove some of the steps still left to a person ([Railway automation](../research/railway-automation.md)).

- **Status:** the script is built; the four changes aren't started, and whether to build them is undecided.
- **Effort:** not estimated.

## Know what it would do

- A `bootstrap-owner` command in the migrator that creates the first owner, so no sign-up form is needed before onboarding.
- A way to adopt a number already bought in Twilio, so numbers can be bought ahead and moved to a client's subaccount with one API call. Today the app buys its own during onboarding.
- Reading the Turnstile site key and the storage address at run time, so one prebuilt admin image serves every deployment.
- A sign-up allowlist.

Two smaller changes would help the script itself:

- Set Polar's webhook secret on the admin from the file `pnpm billing apply` writes. Today that takes a rename and `devops/railway-vars.mjs` with a project token.
- Keep a test for the script in the repository, with stand-ins for each provider's API, such as the one its 2026-11-02 review used. Today `pnpm test` doesn't cover `devops/`.

## Know what stays by hand

OpenAI's API can't create the incoming-call webhook or set a project's spending limit, and Polar makes tokens only in its dashboard, so those steps stay with a person whatever the fork changes ([what the script doesn't do](../../devops/bootstrap.md#what-it-doesnt-do-and-why)).

## Decide these

- Build any of the four changes, and which first?
