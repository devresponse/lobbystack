# Setting up an environment with `devops/bootstrap.mjs`

`bootstrap.mjs` sets up one LobbyStack environment on Railway, such as RealInfoBot's test environment, together with its OpenAI project, Twilio subaccount and trunk, Resend domain, Turnstile widget and DNS records. It replaces most of sections 3 to 12 of the Railway deployment guide with three commands. Where only a person can do a step, it stops, says exactly what to do, and waits.

**Status:** tested on 1 November 2026 against stand-ins for every API it calls, with the requests checked against each provider's documentation. It hasn't run against the real services yet. Run it on a test environment first, and read [What isn't confirmed](#what-isnt-confirmed).

**Which guide:** the section numbers here and in the script's messages, such as "guide 3.6" or "Appendix A.1", are those of the single-deployment Railway guide that ships with a white-label fork's deployment kit. That guide isn't in this repository. In this repository's [deployment guide](../docs/deployment/guide/README.md), the same ground is [Part 3](../docs/deployment/guide/part-3-outside-services.md) (outside services), [Part 4](../docs/deployment/guide/part-4-test-environment.md) (the test environment), [Part 5](../docs/deployment/guide/part-5-production.md) (production) and [Appendix A](../docs/deployment/guide/appendix-a-variables.md) (variables).

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
3. **Tokens.** The script reads each one from the environment variable of the same name, then from the secrets file ([below](#2-put-your-keys-in-the-secrets-file)), and otherwise asks for it with typing hidden. It never saves a token in its state file.

   | Variable | What it is | Where to make it |
   | --- | --- | --- |
   | `RAILWAY_API_TOKEN` | An account token, or a workspace token for the workspace in `RAILWAY_WORKSPACE_ID` | railway.com/account/tokens |
   | `OPENAI_ADMIN_KEY` | An admin key. Only organization owners can make one | platform.openai.com/settings/organization/admin-keys |
   | `TWILIO_MAIN_ACCOUNT_SID`, `TWILIO_MAIN_AUTH_TOKEN` | The main account's SID and Auth Token, which own the subaccounts (API keys can't create them) | Twilio console, Account Info |
   | `RESEND_ADMIN_KEY` | A **Full access** key, used only to make the domain and the sending key. Delete it afterwards | resend.com/api-keys |
   | `CLOUDFLARE_API_TOKEN` | A token with **Zone > DNS > Edit** on the zone, and **Account > Turnstile > Edit** | dash.cloudflare.com/profile/api-tokens |

   In PowerShell, set one for the session with `$env:RAILWAY_API_TOKEN = Read-Host -MaskInput`, put them in the secrets file, or paste each one when the script asks.

## 1. Write the settings file

In the repository folder:

```sh
node devops/bootstrap.mjs init realinfobot-test
```

This writes `.env.bootstrap-realinfobot-test` and `.env.bootstrap-realinfobot-test.secrets`. Git ignores both, like every `.env.*` file. Fill in the first:

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
| `STEP_GITHUB` ... `STEP_TURNSTILE` | `yes` | `no` skips that service's API. The script then takes its values from the secrets file, or asks you for them |

## 2. Put your keys in the secrets file

`.env.bootstrap-<name>.secrets` holds keys, one `KEY=value` per line. Fill in only what you have: an empty line means the script asks you, or creates that thing itself.

If your settings file was made before the script had a secrets file, run `node devops/bootstrap.mjs init <name>` again: it adds only the secrets file and leaves the settings alone.

- **Tokens** the script uses to create things: `RAILWAY_API_TOKEN`, `OPENAI_ADMIN_KEY`, `TWILIO_MAIN_ACCOUNT_SID`, `TWILIO_MAIN_AUTH_TOKEN`, `RESEND_ADMIN_KEY` and `CLOUDFLARE_API_TOKEN` (the table above). An environment variable of the same name wins over the file.
- **Things you already have.** The script uses each one instead of creating a new one, and then doesn't need that service's token for it:

  | Keys | Instead of |
  | --- | --- |
  | `OPENAI_PROJECT_ID` and `OPENAI_API_KEY` | Creating the OpenAI project and its key. Give both: the key must belong to that project, whose ID also goes into the trunk's SIP address. With only one given, the script asks for the other |
  | `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` | Creating the Twilio subaccount. The trunk is then made in that account |
  | `TWILIO_SIP_TRUNK_SID` | Creating the trunk. It must be in the account above. The script still checks it has exactly one origination URI, to the OpenAI project |
  | `SMTP_PASSWORD` | Creating Resend's sending key. The domain and its DNS records are still set up, unless `STEP_RESEND=no` |
  | `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` | Creating the Turnstile widget |
  | `POLAR_ADMIN_TOKEN` and `POLAR_WORKER_TOKEN` | Stopping to ask for them (cloud mode) |
  | `OPENAI_WEBHOOK_SECRET` | Stopping at the webhook step in `connect`, once the webhook exists |
  | Any of the 13 platform secrets, such as `ENCRYPTION_KEY` | Making a new one |

  The provider keys in this table come only from the file, never from the environment, so an `OPENAI_API_KEY` that happens to be set in your shell is never put on Railway by mistake.

**A variable file works too.** `--secrets <file>` reads another file instead, such as `.env.realinfobot`, the variable file for `node devops/railway-vars.mjs`. Its `[service]` lines are understood: `POLAR_ACCESS_TOKEN` under the admin's line is the admin's Polar token, under the worker's the worker's, and `NEXT_PUBLIC_TURNSTILE_SITE_KEY` is the widget's site key. Values that are empty, `?`, a `<placeholder>` or a `${{reference}}` count as not given. If the `[service]` lines are commented out, a key with a different value per service, such as `POLAR_ACCESS_TOKEN`, can't be told apart: the script warns, uses neither, and asks, unless `POLAR_ADMIN_TOKEN` and `POLAR_WORKER_TOKEN` are in the environment.

```sh
node devops/bootstrap.mjs up .env.bootstrap-realinfobot-test --secrets .env.realinfobot
```

As it runs, the script names each key it took from the file, never its value. It warns you if Git doesn't ignore the file.

## 3. Check the plan

```sh
node devops/bootstrap.mjs up .env.bootstrap-realinfobot-test --dry-run
```

It lists every step in order and calls nothing. It also refuses a settings file with a mistake in it, and says which line.

## 4. Set it up

```sh
node devops/bootstrap.mjs up .env.bootstrap-realinfobot-test
```

1. It asks you to type `yes`, since the services it creates bill your accounts. Before buying a toll-free number, it asks again.
2. It works through the steps, one line each. At a **BY HAND** step, it says what to do and waits for Enter.
3. Two waits come near the end. First, open the Railway project and click **Deploy** on the banner, then check that Postgres's and Redis's logs say they're ready to accept connections. Second, after migrate is connected, wait until its deployment succeeds; its log ends with `RLS enabled and forced on <n> tables`. Only then press Enter: the admin and the worker connect next, and Railway builds them.
4. It ends with the address. When `https://<address>/api/health/ready` shows `"ok":true`, go on.

`--yes` skips the questions and the waits, so use it only to finish a run whose waits are already behind you.

## 5. Connect the providers

```sh
node devops/bootstrap.mjs connect .env.bootstrap-realinfobot-test
```

It checks that the admin is ready and shows the right brand. It then tells you how to create OpenAI's incoming-call webhook and asks for its `whsec_` secret, unless `OPENAI_WEBHOOK_SECRET` is in the secrets file. Next it runs `pnpm platform-key:create`, which leaves the key in `.platform-keys/`: move the key to the password manager, then delete that file. Finally it sets both values on the admin, which redeploys it. It ends by printing the last steps, which need you:

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
| `.env.bootstrap-<name>.secrets` | Your keys, as you typed them in. `init` writes it, and the script only reads it |
| `.env.bootstrap-<name>.state.json` | Every step's result: the 13 generated secrets, the provider keys it made or was given, and the IDs |
| `.env.bootstrap-<name>.vars` | Every service's variables in guide Appendix A's format, so `node devops/railway-vars.mjs` can set them again |

Git ignores all four. The last three hold secrets. Once the environment works, delete the tokens from the secrets file, or the whole file once its keys are in the password manager. For the state and variable files: copy them into the password manager entry for the environment, keep a second copy of `ENCRYPTION_KEY` and `OTP_HASH_SECRET` (guide decision 10), and never commit or send these files. The script never prints a secret. Production gets its own settings file and new secrets; never copy test's.

## What isn't confirmed

- **Nothing has run against the real services yet.** The requests follow each provider's documentation as read on 1 November 2026. Railway's API docs don't show some of these steps, so the first real run settles them:
  - Railway's API docs don't list a field for migrate's pre-deploy command. The script tries `preDeployCommand` and, if Railway refuses it, prints the exact command to paste into migrate's settings.
  - Whether Railway can generate the admin's address before its first deploy (guide Appendix D). If it refuses, the run stops at that step: run `up` again after the first deploy.
  - Whether variables set with deploys skipped show up as staged changes with a **Deploy** banner, as the script tells you to expect.
  - The TXT record for a custom domain: the script makes the CNAME, then asks you to copy the TXT record from Railway's networking settings.
- Resend's documentation doesn't name the field that limits a key to one domain. The script sends `domain_id`; if Resend refuses it, the run stops at that step.
- `fullName` turns Resend's record names into host names in the zone. Check the records in Cloudflare after the first run.
