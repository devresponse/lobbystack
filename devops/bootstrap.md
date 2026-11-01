# Setting up an environment with `devops/bootstrap.mjs`

`bootstrap.mjs` sets up one LobbyStack environment on Railway, such as RealInfoBot's test environment, together with its OpenAI project, Twilio subaccount and trunk, Resend domain, Turnstile widget and DNS records. It replaces most of sections 3 to 12 of the Railway deployment guide with three commands. Where only a person can do a step, it stops, says exactly what to do, and waits.

**Status:** tested on 1 November 2026 against stand-ins for every API it calls, with the requests checked against each provider's documentation. It hasn't run against the real services yet. Run it on a test environment first, and read [What isn't confirmed](#what-isnt-confirmed).

## What it does, and what stays with you

| Step | The script | You |
| --- | --- | --- |
| GitHub | Turns on the fork's checks, and checks that the branch has the brand folder | Click **Sync fork** if the brand is missing |
| OpenAI | Creates the project and its API key, owned by a service account | Make sure GPT-Live SIP works for the project, set the spending limit, and later create the incoming-call webhook (OpenAI's API can't make that one yet) |
| Twilio | Creates the subaccount, the SIP trunk (Secure Trunking, transfers) and its origination URI to the OpenAI project. In cloud mode, it buys or reuses the toll-free number and sets its texting address | Geo permissions, business profile, texting registration and toll-free verification, which Twilio reviews |
| Email | Creates the Resend domain, its DNS records in Cloudflare (or prints them for you), and a key that can only send from that domain | Nothing, unless your DNS isn't at Cloudflare |
| Polar (cloud mode) | Asks for the two tokens | Create the tokens: Polar makes them only in its dashboard |
| Railway | Creates the project, the five services, both volumes, the bucket, every setting of guide section 9, the admin's address, the 13 secrets and all about 90 variables, then connects the code: migrate first, then the admin and the worker | Click **Deploy** once for Postgres and Redis, and wait for migrate to pass |
| Turnstile | Creates the widget for the admin's address | Nothing |
| After the address works | Checks `/api/health/ready`, makes the platform key, sets the webhook secret and the key on the admin | Create the webhook, sign up with the email code, sign the command line in, run `pnpm billing` (cloud mode) and the smoke test |

## Before you start

1. **Accounts** (guide 3.1): Railway on Pro, OpenAI with credit, Twilio upgraded from trial, Resend, Cloudflare, and Polar for cloud mode.
2. **Your computer:** Node.js 18 or later, and `pnpm install` done in the repository folder. Two tools are optional, and the script asks you to do their step by hand without them:
   - the Railway CLI (`npm install --global @railway/cli`), used only to make the bucket;
   - the GitHub CLI (`gh`, signed in), used to turn on the fork's checks.
3. **Tokens.** The script asks for each one with typing hidden, or reads it from the environment variable of the same name. It never saves a token.

   | Variable | What it is | Where to make it |
   | --- | --- | --- |
   | `RAILWAY_API_TOKEN` | An account token, or a workspace token for the workspace in `RAILWAY_WORKSPACE_ID` | railway.com/account/tokens |
   | `OPENAI_ADMIN_KEY` | An admin key. Only organization owners can make one | platform.openai.com/settings/organization/admin-keys |
   | `TWILIO_MAIN_ACCOUNT_SID`, `TWILIO_MAIN_AUTH_TOKEN` | The main account's SID and Auth Token, which own the subaccounts (API keys can't create them) | Twilio console, Account Info |
   | `RESEND_ADMIN_KEY` | A **Full access** key, used only to make the domain and the sending key. Delete it afterwards | resend.com/api-keys |
   | `CLOUDFLARE_API_TOKEN` | A token with **Zone > DNS > Edit** on the zone, and **Account > Turnstile > Edit** | dash.cloudflare.com/profile/api-tokens |

   In PowerShell, set one for the session with `$env:RAILWAY_API_TOKEN = Read-Host -MaskInput`, or leave them unset and paste each one when the script asks.

## 1. Write the settings file

In the repository folder:

```sh
node devops/bootstrap.mjs init realinfobot-test
```

This writes `.env.bootstrap-realinfobot-test`. Git ignores it, like every `.env.*` file. Fill it in:

| Setting | Example | Notes |
| --- | --- | --- |
| `NAME` | `realinfobot-test` | Names the Railway project, the OpenAI project and the Twilio subaccount |
| `BRAND` | `realinfobot` | A folder under `brands/` on the branch below |
| `ENVIRONMENT` | `test` | `production` adds `REQUIRE_EMAIL_VERIFICATION=true` and leaves out `BRAND_PRESET` |
| `REPO`, `BRANCH` | `realinfobot/lobbystack`, `main` | What Railway builds |
| `DEPLOYMENT_MODE` | `cloud` | Or `self_hosted_standard`. Decision 1 of the guide: hard to change once businesses exist |
| `OPERATOR_EMAIL` | `you@example.com` | Owns the platform key, and gets the DMARC reports |
| `RAILWAY_WORKSPACE_ID` | | Empty: your personal workspace |
| `BUCKET_REGION` | `iad` | `sjc`, `iad`, `ams` or `sin`. It never changes |
| `CUSTOM_HOST` | `test.realinfobot.com` | Optional. Empty: Railway's free address with `BRAND_PRESET` |
| `EMAIL_DOMAIN`, `EMAIL_FROM` | `notifications.realinfobot.com`, `no-reply@notifications.realinfobot.com` | The subdomain kept for email, and the sender on it |
| `RESEND_REGION` | `us-east-1` | It can't change later |
| `CLOUDFLARE_ZONE`, `CLOUDFLARE_ACCOUNT_ID` | `realinfobot.com`, the account ID | The zone that holds both domains. Empty zone: the script prints the DNS records for you to add. Empty account: you make the Turnstile widget by hand |
| `TWILIO_TOLLFREE` | `buy` | Cloud mode only: `buy`, a number you already have in the subaccount, or empty |
| `POLAR_ORGANIZATION_ID`, `POLAR` | the ID, `sandbox` | Cloud mode only |
| `STEP_GITHUB` ... `STEP_TURNSTILE` | `yes` | `no` skips that service's API. The script then asks you for its values instead, for example an OpenAI project you already made |

## 2. Check the plan

```sh
node devops/bootstrap.mjs up .env.bootstrap-realinfobot-test --dry-run
```

It lists every step in order and calls nothing. It also refuses a settings file with a mistake in it, and says which line.

## 3. Set it up

```sh
node devops/bootstrap.mjs up .env.bootstrap-realinfobot-test
```

1. It asks you to type `yes`, since the services it creates bill your accounts. Before buying a toll-free number, it asks again.
2. It works through the steps, one line each. At a **BY HAND** step, it says what to do and waits for Enter.
3. Two waits come near the end. First, open the Railway project and click **Deploy** on the banner, then check that Postgres's and Redis's logs say they're ready to accept connections. Second, after migrate is connected, wait until its deployment succeeds; its log ends with `RLS enabled and forced on <n> tables`. Only then press Enter: the admin and the worker connect next, and Railway builds them.
4. It ends with the address. When `https://<address>/api/health/ready` shows `"ok":true`, go on.

`--yes` skips the questions and the waits, so use it only to finish a run whose waits are already behind you.

## 4. Connect the providers

```sh
node devops/bootstrap.mjs connect .env.bootstrap-realinfobot-test
```

It checks that the admin is ready and shows the right brand. It then tells you how to create OpenAI's incoming-call webhook and asks for its `whsec_` secret. Next it runs `pnpm platform-key:create`, which leaves the key in `.platform-keys/`: move the key to the password manager, then delete that file. Finally it sets both values on the admin, which redeploys it. It ends by printing the last steps, which need you:

1. Sign up at `https://<address>/en/signup` with `OPERATOR_EMAIL`, using the 6-digit code from the email.
2. `pnpm lobbystack login --url https://<address> --key-stdin --profile <name>`, then paste the platform key.
3. In cloud mode, `pnpm billing plan` and `pnpm billing apply` with that profile and a Polar setup token (guide 12.4).
4. `pnpm smoke:production`, then a test call (guide 13).

## Stopping, resuming and checking

- Each step is recorded in `.env.bootstrap-<name>.state.json` as soon as it succeeds. If a run stops, fix the problem it names and run the same command again: finished steps show `=` and are skipped. OpenAI projects, Twilio subaccounts and trunks, Resend domains, DNS records and Railway services are found by name, so they're never made twice.
- `node devops/bootstrap.mjs status <settings file>` lists what's done.
- `up` creates a **new** Railway project. Don't point it at an environment you've already started by hand, such as one set up from `.env.realinfobot`.

## Files it writes, and secrets

| File | Holds |
| --- | --- |
| `.env.bootstrap-<name>` | Your settings. Nothing secret |
| `.env.bootstrap-<name>.state.json` | Every step's result: the 13 generated secrets, the provider keys it made or was given, and the IDs |
| `.env.bootstrap-<name>.vars` | Every service's variables in guide Appendix A's format, so `node devops/railway-vars.mjs` can set them again |

Git ignores all three. The last two hold secrets: copy them into the password manager entry for the environment, keep a second copy of `ENCRYPTION_KEY` and `OTP_HASH_SECRET` (guide decision 10), and never commit or send these files. The script never prints a secret. Production gets its own settings file and new secrets; never copy test's.

## What isn't confirmed

- **Nothing has run against the real services yet.** The requests follow each provider's documentation as read on 1 November 2026. Railway's API docs don't show some of these steps, so the first real run settles them:
  - Railway's API docs don't list a field for migrate's pre-deploy command. The script tries `preDeployCommand` and, if Railway refuses it, prints the exact command to paste into migrate's settings.
  - Whether Railway can generate the admin's address before its first deploy (guide Appendix D). If it refuses, the run stops at that step: run `up` again after the first deploy.
  - Whether variables set with deploys skipped show up as staged changes with a **Deploy** banner, as the script tells you to expect.
  - The TXT record for a custom domain: the script makes the CNAME, then asks you to copy the TXT record from Railway's networking settings.
- Resend's documentation doesn't name the field that limits a key to one domain. The script sends `domain_id`; if Resend refuses it, the run stops at that step.
- `fullName` turns Resend's record names into host names in the zone. Check the records in Cloudflare after the first run.
