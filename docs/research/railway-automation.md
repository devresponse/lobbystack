# Automate a Railway deployment

On 2026-10-14 a study asked how to deploy LobbyStack to Railway from the fork, from nothing, with the fewest inputs and clicks, and without Railway's hosted template, which the maintainer ruled out. It recommended a bootstrap script built on Railway's infrastructure-as-code SDK, the Railway CLI and the providers' own APIs. **None of it has been built.** Until it is, the [deployment guide](../deployment/guide/README.md) is the way to deploy by hand, and its parts 3 to 5 already include the settings this study found missing. Tool versions and prices are as of 2026-10-14.

## Know the recommendation

Add three files to the fork:

- `.railway/selfhost.ts`, a self-host definition derived from `.railway/template.ts`;
- `scripts/bootstrap-railway.mjs`, which wraps the Railway CLI and the providers' APIs;
- optionally, a GitHub Actions workflow with a "Run workflow" button that runs the script.

A deployment would then be one settings file of about six values with no secrets, one command, and one sign-up form with an emailed code. Building and testing it is a few days of work (estimate).

A script can create the Railway project and its six parts (Postgres with pgvector, Redis, a storage bucket, the migrator, the admin and the worker), generate the 15 secrets, set about 100 variable entries and the domain, and deploy in the right order. With master accounts in place it can also create, per deployment, a Twilio subaccount and SIP trunk, an OpenAI project with its key, spend limit and call webhook, a Turnstile widget and an email sending key, then create the business and buy its number with the `lobbystack` CLI.

## Follow the order

The definition is applied twice, because Railway can't make one service wait for another, and the admin's build needs the address and keys that only exist after the first apply.

1. Check the tools and tokens, and generate the 15 secrets into a git-ignored `deploy/<name>/.secrets.env` that is never overwritten.
2. Create the Railway project.
3. Create the OpenAI project, key and monthly spend limit; the Twilio subaccount and trunk; the email sending key.
4. **First apply,** with a phase flag that leaves the admin and worker without a source: only the migrator builds, and its pre-deploy step runs the migrations and gives the database roles their logins.
5. Give the admin its address, then create the Turnstile widget for it, the OpenAI call webhook and the platform key, which needs no database.
6. **Second apply,** with the admin and worker pointed at the fork, so each builds once with every build-time value already set. Wait for `/api/health/ready`.
7. The operator signs up and enters the emailed code. These are the only clicks.
8. Run `lobbystack onboard` with the client's manifest, which creates the business, buys its number on the trunk and sends the owner a claim link.

Every step looks for what it made before creating anything, so a failed run can be restarted. Later changes go through `railway config plan` and `apply`, which show and fix drift.

## Know what stays manual

- **Once, ever (about 45 to 60 minutes, inferred):** each provider account, Railway's GitHub app, and Google's OAuth client, which only Google's console can create.
- **Per deployment:** the settings file, the sign-up form, DNS records when the domain isn't on Cloudflare, a test call, and the deployment's redirect address on the shared Google client.
- **Per client, later:** US texting registration, which names the client's business and takes days to weeks.

## Know what the study found

These broke fresh deployments then, and the deployment guide now covers each of them:

- Without `TURNSTILE_SECRET_KEY` and its site key, nobody can sign up on any address but localhost. The site key and the bucket's address are compiled into the admin image, so they must exist before its first build.
- Without `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=1860` on the worker, every deploy cuts the calls in progress.
- `ENCRYPTION_KEY`, `OTP_HASH_SECRET`, `DEPLOYMENT_MODE` and the Postgres password must be right before data exists. Losing `ENCRYPTION_KEY` makes every API key, calendar connection and webhook secret unusable, so keep a copy outside Railway.
- The Twilio trunk, the numbers and the credentials the app uses must all be in one Twilio (sub)account.
- Leave the `plan` section out of a self-hosted onboarding manifest.

Sign-up is open to anyone who finds a deployment's address, and a self-hosted plan has no minute or number limits, so a stranger could spend the deployment's OpenAI and Twilio credit. An OpenAI spend limit and a Twilio subaccount per deployment cap the damage; a sign-up allowlist would close it ([open items](../project/open-items.md)).

## Change the fork to remove the last manual steps

- A `bootstrap-owner` command in the migrator that creates the first owner, so no sign-up form is needed before onboarding.
- A way to adopt a number already bought in Twilio, so numbers can be bought ahead and moved to a client's subaccount with one API call. Today the app buys its own during onboarding.
- Reading the Turnstile site key and the storage address at run time, so one prebuilt admin image serves every deployment.
- A sign-up allowlist.

## Know the risks and costs

- **OpenAI:** GPT-Live needs a paid tier; how SIP gets enabled for a project has no documented process, and the call webhook's event type wasn't in the API's documented list, so the webhook may need the dashboard. Test an inbound call on the first project before promising a date.
- **Twilio:** US texting needs A2P 10DLC registration ($19.50 to $61 once, plus $1.50 to $10 a month per client); toll-free numbers need verification (up to 3 business days); UK and Australian numbers need a regulatory bundle the app doesn't send. Porting a number takes 5 to 7 working days or more; forwarding the old line works on day one, since the app recognizes forwarded calls.
- **Google:** keep the OAuth app published, or calendar connections expire every 7 days; unverified, it is limited to 100 users.
- **Railway:** the Free plan allows one volume and LobbyStack needs two. Hobby allows 5 GB per volume and 2 custom domains per service.
- **Hand-over:** transferring the Railway project doesn't move the provider accounts, which stay the operator's unless the client brings their own.
- **Costs:** about $11 to $19 a month of Railway usage per low-traffic deployment (estimate), $1.15 a month per Twilio number, and about $0.16 for a three-minute US call ($0.15 of GPT-Live, about $0.01 of Twilio).

Still unconfirmed: whether OpenAI's API can create the call webhook, how GPT-Live SIP gets enabled per project, whether a later apply can add a source to a service created without one, and whether Twilio trunks need Opus from Twilio sales.
