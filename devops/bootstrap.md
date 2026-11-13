# Set up a LobbyStack environment with `devops/bootstrap.mjs`

`bootstrap.mjs` sets up one LobbyStack environment on Railway, with the outside services it needs: an OpenAI project and key, a Twilio subaccount and SIP trunk, a Resend sending domain, Cloudflare DNS records and a Turnstile widget, a PostHog project unless you turn it off, and in cloud mode the Polar tokens and the plans Polar sells, or the Stripe keys. You describe the environment in one small settings file, and what it makes is named after the dashboard's address (`APP_BASE_URL`), or after `NAME` without one. The script does the rest through each provider's API, records every finished step, and stops with exact instructions where only a person can act.

**Status:** the PostHog step is new on 13 November 2026 (fork PR #165). `scripts/bootstrap.test.ts` runs it against a stand-in for PostHog's API, written from PostHog's published API schema and its code; of it, only `doctor`'s checks have met PostHog itself, once, on 13 November 2026. `connect`'s Polar billing is new on 12 November 2026 (`releases/r2` at `4711924` plus fork PR #157). `scripts/bootstrap.test.ts`, which `pnpm test:scripts` runs, runs `up`, `doctor`, `status` and `connect` through their Polar steps, against one local stand-in for Railway's API, Polar's API and the admin, and a stand-in for `pnpm billing`. Its first run against Polar's sandbox and a real admin, on Windows on 13 November 2026, set the plans up, then stopped at the admin's webhook secret, which it misread; fork PR #160 fixes that ([What isn't confirmed](#what-isnt-confirmed)). The rest was checked on 2 November 2026 against `main` at `df0a0ed`: a test harness, not kept in the repository, ran every command against stand-ins for each API, 67 checks covering a fresh run named after `APP_BASE_URL` or after `NAME`, an older state file, a changed `APP_BASE_URL`, reruns, `--yes`, `redo`, a deleted project, duplicate names, a running deployment's variables, the lock and the state-file guard. Before that, on 1 and 2 November 2026, the script set up a real test environment several times, from a private template and with its own address, and on 2 November that environment answered a phone call. The parts not yet run against a real service are listed in [What isn't confirmed](#what-isnt-confirmed). Set up a test environment first.

Section numbers such as "guide 3.2" in this page and in the script's messages are those of the [deployment guide](../docs/deployment/guide/README.md): mainly [Part 3](../docs/deployment/guide/part-3-outside-services.md) (outside services), [Part 4](../docs/deployment/guide/part-4-test-environment.md) (a test environment), [Part 5](../docs/deployment/guide/part-5-production.md) (production) and [Appendix A](../docs/deployment/guide/appendix-a-variables.md) (variables). The script does most of Parts 3 and 4.

Every setting, secret and Railway variable the script reads, keeps or writes, with where each comes from and how it is checked, is in [Bootstrap script variables](../docs/deployment/bootstrap-variables.md).

## The whole process

| # | What | Command or place |
| --- | --- | --- |
| 1 | Accounts, tools and tokens | [Before you start](#before-you-start) |
| 2 | Write the settings and secrets files | `node devops/bootstrap.mjs init <name>` |
| 3 | Check them | `doctor`, then `up --dry-run` |
| 4 | Set everything up and deploy | `up` |
| 5 | The steps only a person can do | the OpenAI, Twilio and Cloudflare dashboards |
| 6 | Connect the incoming-call webhook, and make the platform key. In cloud mode with Polar, it also sells the plans (step 8) | `connect` |
| 7 | Sign up, and sign the command line in. With Polar, sign up before `connect`, or when it asks | the dashboard, `pnpm lobbystack login` |
| 8 | Cloud mode only: sell plans through Polar or Stripe | Polar: `connect`, with the worker's token or a setup token. Stripe: `pnpm billing plan`, `apply`, `verify` |
| 9 | Check that it all works | health check, a test call, `pnpm smoke:production` |

`<name>` is the environment's name, such as `acme-test`, and the settings file is `.env.bootstrap-<name>`. Run every command from the repository folder.

## What the script does, and what stays with you

| Part | The script | You |
| --- | --- | --- |
| GitHub | Checks that the fork's CI, Runtime images and Replacement Platform workflows are on, turning on any that are off, and that `BRANCH` has the brand's folder | Turn the workflows on by hand if `gh` isn't signed in as the fork's owner. Sync the fork if the brand is missing |
| OpenAI | Creates the project and its API key, owned by a service account | Make sure the project takes GPT-Live SIP calls, set its spending limit, and create the incoming-call webhook |
| Twilio | Creates the subaccount, the SIP trunk (Secure Trunking, transfers) and its one origination URI, to the OpenAI project. In cloud mode it buys or reuses the shared toll-free number | Geo permissions, the business profile, texting registration and toll-free verification |
| Email | Creates the Resend domain, its DNS records, a DMARC record if there's none, and a key that can only send from that domain | Nothing, if the domain's DNS is at Cloudflare |
| Railway | Creates the project, the five services, both volumes, the bucket, each service's settings, the admin's address, the 13 platform secrets and about 100 variables. It deploys Postgres and Redis, waits for migrate to pass, then connects the admin and the worker, which Railway builds | Nothing |
| The admin's own address (`APP_BASE_URL`) | Adds it to the admin as a custom domain, writes its CNAME and Railway's TXT check in Cloudflare, and makes it the admin's `APP_BASE_URL`. It checks all of it again after the deploy | Nothing, if the domain's DNS is at Cloudflare |
| Turnstile | Creates the widget, or adds this deployment's addresses to the widget whose keys you gave | Nothing, if the Cloudflare token can edit Turnstile |
| `connect` | Checks the admin's health, takes the webhook's secret, makes the operator's platform key, and sets both on the admin | Create the webhook in OpenAI first |
| Polar, in cloud mode | `up` takes the admin's and the worker's tokens, and reads the organization from the worker's, which becomes `POLAR_ORGANIZATION_ID`. `connect` then sells the plans: `pnpm billing plan`, `apply` once you type `yes`, the Polar webhook's secret on the admin, and `verify` | Make the two tokens, or one for both, and sign up as `OPERATOR_EMAIL`. Unless the worker's token has the setup scopes too, give `connect` a setup token and delete it afterwards ([step 8](#8-cloud-mode-sell-plans-through-polar)) |
| Stripe, in cloud mode with `BILLING_PROVIDER=stripe` | Takes the admin's and the worker's restricted keys, checks that each is of the deployment's mode and that both belong to one account, and puts that account on both services as `STRIPE_ACCOUNT_ID`, with `BILLING_PROVIDER` | Make those keys, and later run `pnpm billing --stripe` ([on Stripe](#on-stripe)) |
| PostHog, unless `POSTHOG=no` | Finds or makes the deployment's project, turns its screen recordings on and limits them to the deployment's addresses, and puts its token and address on the admin, the worker and migrate, logs included, before the admin's first build ([PostHog](#posthog)) | Sign up at PostHog, and make one personal API key. PostHog's free plan allows one project per organization: `up` takes over the one a new organization starts with, and a second deployment in that organization needs pay-as-you-go first |

## Before you start

**Accounts:** Railway on a paid plan, OpenAI with prepaid credit, Twilio upgraded from trial (a trial account has no SIP trunking), Resend, Cloudflare holding the domain's DNS, PostHog unless you set `POSTHOG=no`, and Polar or Stripe for cloud mode ([guide 1.1](../docs/deployment/guide/part-1-prepare.md#11-accounts-youll-need)).

**Your computer:**

- Node.js 18 or later, and `pnpm install` done in the repository folder: `connect` makes the platform key with pnpm.
- Optional: the Railway CLI (`npm install --global @railway/cli`), used only to make the bucket. Without it, the script tells you to make the bucket by hand.
- Optional: the GitHub CLI (`gh`), signed in, which checks the fork's workflows and brand folder.
- **On Windows, run the script in PowerShell or Windows Terminal.** Git Bash's terminal can't hide what you type, so the script warns you there; put the keys in the secrets file instead. The smoke test in [step 9](#9-check-that-it-all-works) is the exception: it needs Git Bash.
- **On Windows, keep the files to your account.** Windows ignores the files' private mode, and a folder made at the top of a drive, such as `C:\repos`, lets every account on the computer read them. `doctor` says when that's so. To fix it, run this in PowerShell for each file that holds secrets:

  ```powershell
  icacls .env.bootstrap-<name>.secrets /inheritance:r /grant:r "${env:USERNAME}:F"
  ```

**Tokens.** The script reads each token from the environment variable of the same name, then from the secrets file ([step 2](#2-write-the-settings-and-secrets-files)), and otherwise asks, with typing hidden. It never saves a token in its state file, and never prints one.

| Variable | What it must be | Where to make it |
| --- | --- | --- |
| `RAILWAY_API_TOKEN` | An account token, or a workspace token for `RAILWAY_WORKSPACE_ID`. A project token can't create projects | `railway.com/account/tokens` |
| `OPENAI_ADMIN_KEY` | An admin key, which only an organization owner can make | `platform.openai.com/settings/organization/admin-keys` |
| `TWILIO_MAIN_ACCOUNT_SID`, `TWILIO_MAIN_AUTH_TOKEN` | The main account's SID and Auth Token, which own the subaccounts | Twilio's console, **Account Info** |
| `RESEND_ADMIN_KEY` | A **Full access** key, used only to create the domain and the sending key. Delete it afterwards | `resend.com/api-keys` |
| `CLOUDFLARE_API_TOKEN` | **Zone > DNS > Edit** on the zone, and **Account > Turnstile > Edit** on the account | `dash.cloudflare.com/profile/api-tokens` |
| `POSTHOG_PERSONAL_API_KEY` | A personal API key (`phx_…`) made in the region `POSTHOG` names, with `organization:read`, `project:read` and `project:write`, limited to your organization. Your PostHog user must be an admin of it to make a project. Not needed with `POSTHOG=no`, or with `POSTHOG_PROJECT_TOKEN` in the secrets file | `us.posthog.com/settings/user-api-keys` (or `eu.`), **Create personal API key**. PostHog's API can't make one |

In cloud mode with Polar, `connect` sets the plans up with the worker's token when Polar lets that token do it, that is when it was made with the setup scopes too. Otherwise it asks for one more, a short-lived **Polar setup token** (`POLAR_SETUP_TOKEN`), keeps it in memory only, and checks that it belongs to the deployment's organization ([step 8](#8-cloud-mode-sell-plans-through-polar)). With Stripe, two more come later, and the script never sees them: a **Stripe setup key** for `pnpm billing --stripe`, and a **Railway project token** for `node devops/railway-vars.mjs` ([on Stripe](#on-stripe)).

## 2. Write the settings and secrets files

```sh
node devops/bootstrap.mjs init <name>
```

This writes `.env.bootstrap-<name>` for the settings and `.env.bootstrap-<name>.secrets` for the keys. Git ignores both, like every `.env.*` file. Write each setting on its own line as `KEY=value`, with no comment after the value. Quotes around a value are allowed and dropped.

| Setting | Example | What it is |
| --- | --- | --- |
| `NAME` | `acme-test` | The fallback name: the projects are named after `APP_BASE_URL`'s address when it's set, else after `NAME` ([what things are named](#what-things-are-named)). It also names the command line's profile. Lower-case letters, digits and dashes. It may be empty when `APP_BASE_URL` is set |
| `BRAND` | `acme` | A folder under `brands/` on `BRANCH`. In cloud mode it also needs a `billing.json` ([guide 3.6](../docs/deployment/guide/part-3-outside-services.md#36-your-brand)) |
| `ENVIRONMENT` | `test` | `test` or `production`. Production adds `REQUIRE_EMAIL_VERIFICATION=true`, sets no `BRAND_PRESET`, and so needs `APP_BASE_URL` on one of the brand's domains |
| `REPO`, `BRANCH` | `your-org/lobbystack`, `main` | The fork and the branch Railway builds. Railway's GitHub app must reach the repository: Railway can build a public repository it can't reach, but then never redeploys on a push, and `up` warns about it |
| `DEPLOYMENT_MODE` | `self_hosted_standard` | `self_hosted_standard` (every business unlimited) or `cloud` (businesses buy plans, through `BILLING_PROVIDER`'s provider). Hard to change once businesses exist ([guide 1.3](../docs/deployment/guide/part-1-prepare.md#13-decide-these-before-any-data-exists), decision 1) |
| `OPERATOR_EMAIL` | `ops@example.com` | Owns the platform key, signs up first, and receives DMARC reports |
| `RAILWAY_WORKSPACE_ID` | the workspace's ID | Railway won't create a project without it. It's in the workspace's **Settings**, **General** tab, and `doctor` lists the workspaces the token reaches |
| `BUCKET_REGION` | `iad` | `sjc`, `iad`, `ams` or `sin`. It can't change later |
| `APP_BASE_URL` | `demo.example.com` | Optional: the dashboard's own address, with or without `https://`, inside `CLOUDFLARE_ZONE`. It also names the projects. Empty: the admin keeps Railway's free address. See [the address and the brand](#the-address-and-the-brand). `CUSTOM_HOST`, its older name, still works |
| `EMAIL_DOMAIN`, `EMAIL_FROM` | `mail.example.com`, `Acme <no-reply@mail.example.com>` | The subdomain kept for sending email, inside `CLOUDFLARE_ZONE`, and the sender on it |
| `RESEND_REGION` | `us-east-1` | `us-east-1`, `eu-west-1`, `sa-east-1` or `ap-northeast-1`. It can't change later |
| `CLOUDFLARE_ZONE` | `example.com` | The zone's domain name, not its 32-character Zone ID. Empty: the script prints every DNS record for you to add |
| `CLOUDFLARE_ACCOUNT_ID` | 32 characters | From the zone's **Overview** page. Empty: you make the Turnstile widget by hand |
| `TWILIO_TOLLFREE` | `buy` | Cloud mode only: `buy`, a number already in the subaccount such as `+18445550123`, or empty for none |
| `BILLING_PROVIDER` | `polar` | Cloud mode only: `polar` or `stripe`, who sells the plans. A deployment keeps its provider ([Stripe billing](../docs/providers/stripe.md)) |
| `POLAR`, `POLAR_ORGANIZATION_ID` | `sandbox`, empty | With `BILLING_PROVIDER=polar` only. `POLAR` is `sandbox` or `live`. `POLAR_ORGANIZATION_ID` may stay empty: `up` reads the organization from the worker's token. Set, it must be that organization's ID, a UUID, or `up` stops |
| `STRIPE` | `sandbox` | With `BILLING_PROVIDER=stripe` only: `sandbox` or `live`. The account is the one the keys belong to |
| `POSTHOG` | `us` | `us` or `eu`, the PostHog cloud region your organization is in, a self-hosted instance's `https://` address, or `no` for no PostHog. Empty or missing means `us`, except on a deployment `up` deployed before the PostHog step ([PostHog](#posthog)) |
| `POSTHOG_ORGANIZATION_ID` | empty | Only when the personal key reaches several organizations: the one to use, a UUID. `doctor` and the step list the ones the key reaches |
| `POSTHOG_PROXY` | empty | Optional: a reverse proxy's `https://` address for the dashboard's events, such as PostHog's managed proxy, which ad blockers don't stop ([guide 3.7](../docs/deployment/guide/part-3-outside-services.md#37-optional-services)). The worker's events and the logs still go straight to PostHog |
| `POSTHOG_RECORDINGS` | `yes` | `yes` turns the project's screen recordings on and limits them to the deployment's addresses; `no` leaves the project's setting as it is (off in a new one). The dashboard records only operators whose business has telemetry on |
| `POSTHOG_LOGS` | `yes` | `yes` sends migrate's, the admin's and the worker's logs, traces and metrics to the project too (`OTEL_EXPORTER_OTLP_*`) |
| `STEP_GITHUB` … `STEP_TURNSTILE` | `yes` | `no` skips that service's API, and its values then come from the secrets file, or are asked for |
| `RAILWAY_TEMPLATE` | the code `template` printed | Optional: make the Railway layout from your private template in one call ([below](#optional-a-private-railway-template)) |
| `TEMPLATE_PROJECT`, `TEMPLATE_REPO` | `lobbystack-template`, `your-org/lobbystack` | Optional, read only by `template` |

The script refuses a settings file with a mistake in it and says what to change. It warns about a setting it doesn't read, which is usually a misspelling, and about a key set twice to different values, where the last line wins.

### The address and the brand

The admin and the worker take their brand from `APP_BASE_URL`'s domain when `brands/index.json` gives that domain a brand, and from `BRAND_PRESET` on any other address ([guide 3.1](../docs/deployment/guide/part-3-outside-services.md#31-choose-your-addresses)). With `BRAND_REQUIRED=true`, which the script sets, they refuse to start under the default brand. So:

- **Without `APP_BASE_URL`**, or with one on a domain no brand claims, a test environment gets `BRAND_PRESET=<BRAND>`.
- **With `APP_BASE_URL` on the brand's own domain**, the domain picks the brand, and the script sets no `BRAND_PRESET`.
- **An address on another brand's domain** is refused, since that brand would win over `BRAND_PRESET`.
- **Production** sets no `BRAND_PRESET`, so it needs `APP_BASE_URL` on one of the brand's domains. Add the domain to `brands/index.json`, on `BRANCH`, first.

The script reads `brands/index.json` from your copy of the code, so keep that copy up to date with `BRANCH`.

### What things are named

What the script makes at the providers is named after `APP_BASE_URL`'s address, such as `demo.example.com`, or after `NAME` when there's no `APP_BASE_URL`:

| Thing | Name |
| --- | --- |
| The Railway project, the OpenAI project, the Twilio subaccount, the Turnstile widget, the Resend key and the PostHog project | `demo.example.com` |
| The OpenAI service account that owns the key | `demo.example.com platform` |
| The Twilio trunk | `demo.example.com to OpenAI` |
| The shared toll-free number (cloud mode) | `demo.example.com shared texts` |
| The two Polar tokens or Stripe keys you make | `demo.example.com admin` and `demo.example.com worker` |

An address longer than 50 characters leaves the names to `NAME`, since Twilio's names stop at 64 characters.

- **Names are kept once used.** Each step records the name it gave or found in the state file, and later runs look for that name, or for the thing's ID. Changing `APP_BASE_URL` or `NAME` afterwards renames nothing and makes nothing new. `status`, `doctor` and `up` show each name in use. When the settings would name new things otherwise, they also print one line saying the names stay as recorded. To use new names everywhere, start a new settings file, which sets up a new environment.
- **A state file from before names were recorded** was named after `NAME`, so the script records those names: on screen with `status` and `doctor`, and in the file at the next `up`, `connect` or `redo`. Keep `NAME` in such a settings file.
- **Names aren't unique at most providers.** When a name matches two OpenAI projects, Twilio subaccounts, trunks, Turnstile widgets or Resend keys, the run stops and lists their IDs rather than pick one. Delete or rename the extra one, or give the one to use in the secrets file. PostHog's project names are unique within an organization, ignoring case, so there the name finds one project at most.
- Things given in the secrets file keep whatever names they have.

### The secrets file

It holds keys, one `KEY=value` per line. Fill in only what you have: an empty line means the script asks, or creates that thing.

- **The tokens above.** An environment variable of the same name wins over the file. `POLAR_SETUP_TOKEN` is read the same way, but pasting it when `connect` asks keeps it off the disk.
- **Things you already have,** used instead of creating new ones:
  - `OPENAI_PROJECT_ID` with `OPENAI_API_KEY`, both or neither;
  - `TWILIO_ACCOUNT_SID` with `TWILIO_AUTH_TOKEN`, and optionally `TWILIO_SIP_TRUNK_SID`;
  - `SMTP_PASSWORD`, Resend's sending key;
  - `TURNSTILE_SITE_KEY` with `TURNSTILE_SECRET_KEY`;
  - `POLAR_ADMIN_TOKEN` with `POLAR_WORKER_TOKEN`, in cloud mode;
  - `STRIPE_ADMIN_KEY` with `STRIPE_WORKER_KEY`, in cloud mode with `BILLING_PROVIDER=stripe`, or as `STRIPE_API_KEY` under each service's `[...]` line of a `railway-vars.mjs` file;
  - `POSTHOG_PROJECT_TOKEN`, a PostHog project's token (`phc_…`), to use that project as it is, with no personal key: its settings, such as screen recordings, stay as they are. Two deployments can share a project this way. A `railway-vars.mjs` file gives it as the admin's `NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN`;
  - `OPENAI_WEBHOOK_SECRET`, for `connect`;
  - any of the 13 platform secrets, such as `ENCRYPTION_KEY`, to reuse ones already made: at least 32 letters, digits, dashes or underscores each.

  These come only from the file, never from the environment, so a key that happens to be set in your shell is never picked up.
- **`--secrets <file>`** reads another file instead, such as a variable file for `node devops/railway-vars.mjs`. Its `[service]` lines are understood. Empty values, `?`, `<placeholders>` and `${{references}}` count as not given.

## 3. Check

```sh
node devops/bootstrap.mjs doctor .env.bootstrap-<name>
node devops/bootstrap.mjs up .env.bootstrap-<name> --dry-run
```

`doctor` changes nothing. It checks:

- Node.js, pnpm, the Railway CLI and the GitHub CLI;
- that Git ignores the files that hold secrets, and on Windows whether other accounts can read them;
- every token it finds, with a read-only call, saying what already exists and will be reused;
- in cloud mode with Polar, the organization that the worker's token and, when given, the setup token belong to: both must be the same one, and `POLAR_ORGANIZATION_ID` when it's set. Without a setup token, it says whether `connect` can set the plans up with the deployment's own token or will ask for one. One token for both the admin and the worker is a note, not a **FIX**;
- with PostHog, the organization the personal key reaches, whether `up` will reuse a project (an earlier run's, the one whose token the admin has already, or one with the deployment's name), and otherwise whether it can make one, or take over the organization's only unused project when its plan allows no more: a **FIX** when the plan allows no more projects and none can be taken over, or when your user isn't an admin of it.

Each problem is marked **FIX**. The dry run lists every step in order and calls nothing.

## 4. Set it up

```sh
node devops/bootstrap.mjs up .env.bootstrap-<name>
```

It asks you to type `yes`, since the services bill your accounts. Then it works through the steps, one line each: `+` runs a step, and `=` skips one that's already done.

1. **GitHub, OpenAI, Twilio, email, Polar or Stripe, then PostHog:** the outside services, in that order. On Polar, `polar.tokens` reads the organization the worker's token belongs to, records it as `POLAR_ORGANIZATION_ID`, and stops when the setting names another. On Stripe, `stripe.keys` reads each key's account from Stripe and stops when the two differ, or when a key is of the other mode. `posthog.project` finds or makes the PostHog project ([PostHog](#posthog)).
2. **Railway:** the project, found by name or made in `RAILWAY_WORKSPACE_ID`. Then the services, volumes and bucket, from your template or one by one, and each service's settings and migrate's pre-deploy command.
3. **Address:** the admin's Railway address; with `APP_BASE_URL`, the custom domain and its DNS records; then the Turnstile widget.
4. **Variables:** the 13 platform secrets (kept, given, read back from Railway, or new), then every service's variables, without deploying yet. They're also written to `.env.bootstrap-<name>.vars`. On a deployment that's already running, this step sets only the values that differ, and Railway deploys each service that changed again; the worker deploys again too when an admin value it refers to changed. It never changes a running database's settings.
5. **Deploy:**
   1. Postgres and Redis, with their passwords, until Railway reports them running.
   2. migrate, until its deployment succeeds. Its pre-deploy runs the migrations, sets the database roles' passwords and checks RLS.
   3. The admin and the worker, which Railway then builds.

   After connecting each code service, the script checks that Railway made a deployment trigger for `REPO` and `BRANCH`. Without one, pushes don't redeploy, and it prints a **WARNING** with the fix.
6. **After the deploy:**
   - `post.dns`, with `APP_BASE_URL`: the custom domain is on the admin and its records are in Cloudflare, DNS only. It says whether Railway has verified the domain and issued its certificate.
   - `post.urls`: the admin's `APP_BASE_URL`, `SITE_URL` and `AUTH_TRUSTED_ORIGINS`, and the worker's `APP_BASE_URL`, match the settings. With `APP_BASE_URL`, `AUTH_TRUSTED_ORIGINS` lists both addresses, so signing in works on either.
   - `post.turnstile`: the widget lists the Railway address and `APP_BASE_URL`.
   - `post.posthog`, with PostHog and `POSTHOG_RECORDINGS=yes`: the project takes screen recordings from the Railway address and `APP_BASE_URL`, added to any it lists already.

It ends with the address, and with any step still waiting for you. In cloud mode with Polar, it also says to sign up as `OPERATOR_EMAIL` before `connect` ([step 8](#8-cloud-mode-sell-plans-through-polar)). A **BY HAND** step says exactly what to do and waits for Enter. The admin answers at `https://<address>/api/health/ready` once its build finishes. With `APP_BASE_URL`, the Railway address answers first, while DNS spreads and Railway issues the certificate.

**Options:**

- `--yes` doesn't stop at questions or at **BY HAND** steps. A step it didn't wait at isn't recorded as done: `up` and `connect` list it at the end with the command that finishes it, `status` shows it as `OPEN`, and it runs again, and waits, the next time you run that command without `--yes`. A value the script needs, such as a token, is still asked for.
- `--verbose` shows each API call.
- `--dry-run` shows the steps and calls nothing.

**One run at a time.** While `up`, `connect`, `redo` or `template` runs, it holds a lock beside the state file, and a second run on the same file stops at once, naming the first. A run that was killed leaves its lock behind, and the next run takes it over. As well, a run never saves over a state file that something else changed after it started: it stops instead, saving nothing.

### PostHog

PostHog gets the dashboard's analytics, screen recordings and error reports, the worker's call events and errors, and with `POSTHOG_LOGS=yes` every service's logs ([guide 3.7](../docs/deployment/guide/part-3-outside-services.md#37-optional-services), PostHog). It's on unless `POSTHOG=no`. `posthog.project` runs before Railway, since the admin's first build takes the project's token and address. It works in the one organization the personal key reaches, or in `POSTHOG_ORGANIZATION_ID`, and takes the first of these:

1. `POSTHOG_PROJECT_TOKEN` from the secrets file, as it is. Nothing is asked of PostHog, so no personal key is needed, and the project's settings stay as they are;
2. the project an earlier run recorded;
3. the project whose token the admin has already, such as one set by hand, with the admin's `NEXT_PUBLIC_POSTHOG_HOST`. When that project isn't in the organization, its token and address are kept as they are, PostHog's US address when the admin names none, and its settings aren't touched;
4. the project with the deployment's name ([what things are named](#what-things-are-named));
5. a new project with that name, with screen recordings on when `POSTHOG_RECORDINGS=yes`. A project PostHog's API makes has them off, and the dashboard's recorder then never starts;
6. instead of 5, when the organization's plan allows no more projects: its only project that has never received an event, such as the one PostHog makes with a new organization, renamed to the deployment's name, with screen recordings on when `POSTHOG_RECORDINGS=yes`. A project that has received events is in use somewhere, so `up` never takes it over, and when several have never received one, it doesn't choose. A project that another deployment uses but that hasn't received an event yet, such as one set up minutes before, looks unused too, so set up a second deployment in the same organization only once the first one's project shows events in PostHog.

`variables` then puts the values on the services: the token and the address the dashboard sends to (`POSTHOG_PROXY`, else PostHog's, such as `https://us.i.posthog.com`) on the admin, the token by reference and PostHog's own address on the worker, and with `POSTHOG_LOGS=yes` the two `OTEL_EXPORTER_OTLP_*` values, PostHog's logs address and the token, on migrate, the admin and the worker. After the deploy, `post.posthog` lets the project take recordings only from the deployment's addresses.

- **PostHog's plans limit projects.** The free plan allows one project per organization, pay-as-you-go six, with no monthly fee, and the Boost add-on ($250 a month) any number. When the organization has as many as its plan allows, `up` takes over its only project that has never received an event (6 above), so a new free organization works as it is. Otherwise PostHog refuses the new project and the step stops with four ways out: rename the project this deployment should use to the deployment's name in PostHog, which `up` then reuses (4 above), move the organization to pay-as-you-go in PostHog's billing settings, put an existing project's token in the secrets file as `POSTHOG_PROJECT_TOKEN`, which the deployments then share, or set `POSTHOG=no`. `doctor` says which before `up`.
- **Only an admin of the organization can make a project,** unless the organization lets members make them. Otherwise the step stops and says so; an admin can make the project and give you its token for `POSTHOG_PROJECT_TOKEN`.
- **A deployment `up` deployed before the PostHog step** has no `POSTHOG` line, and `up` leaves it without PostHog, saying how to add it. To add it, put `POSTHOG=us` (or `eu`, or your instance's address) in its settings file and run `up`: `posthog.project` runs, `variables` runs again, and Railway deploys migrate, the admin and the worker again with the new values. A token already on the admin is kept (3 above).
- **Self-hosted PostHog** has the same API at its own address, which `POSTHOG` then names, and which serves both the app and the events. PostHog supports only its cloud, and keeps some features there. If the instance doesn't take logs at `/i/v1/logs`, set `POSTHOG_LOGS=no`. The dashboard's links into PostHog's app still open PostHog's US cloud (`apps/admin/src/lib/client-analytics.ts`).
- **The personal key** is read from the environment or the secrets file, never kept in the state file or put on Railway. Delete it from the secrets file once the environment works, as with the other tokens.

## 5. The steps only a person can do

These are the **BY HAND** steps `up` shows. The script can't do them for you: see [What it doesn't do, and why](#what-it-doesnt-do-and-why).

- **OpenAI,** in the project the script made, chosen in the project menu at the top left of `platform.openai.com`:
  - **GPT-Live SIP.** OpenAI documents no switch for phone calls ([guide 3.2](../docs/deployment/guide/part-3-outside-services.md#32-openai), "Phone calls (SIP)"), so the first test call is the check. If it fails after [step 6](#6-connect-the-incoming-call-webhook-and-make-the-platform-key) is done, see [troubleshooting](#when-something-goes-wrong).
  - **Limits > Spend:** a monthly limit, **Enforce a hard limit** on, and alerts below it (guide 3.2, steps 12 and 13).
- **Twilio,** in the subaccount: **Voice > Settings > Geo permissions** for each country whose phones take transfers, and the business profile and US texting registration, which Twilio reviews for days (guide 3.3, steps 3 and 14). In cloud mode, send the toll-free number for verification (guide 3.3, step 19).
- **Railway,** only without the Railway CLI: a bucket named exactly `Bucket` in `BUCKET_REGION` (guide 4.4, step 11).
- **Cloudflare,** only if `CLOUDFLARE_ZONE` or `CLOUDFLARE_ACCOUNT_ID` is empty: the DNS records `up` printed, and a Turnstile widget for the admin's addresses, **Managed**, with no pre-clearance ([guide 3.5](../docs/deployment/guide/part-3-outside-services.md#35-cloudflare-turnstile)).

## 6. Connect the incoming-call webhook, and make the platform key

First create OpenAI's incoming-call webhook ([guide 3.2](../docs/deployment/guide/part-3-outside-services.md#32-openai), steps 14 to 16). **Create it in the project the Twilio trunk sends calls to**, the one the script made, whose ID (`proj_…`) `connect` prints. OpenAI sends each call only to the webhooks of the project that received it, so a webhook in any other project never hears of these calls, and they ring unanswered.

1. Choose that project in the project menu, then open **Settings > Webhooks** and click **Create**.
2. **URL:** `https://<address>/api/webhooks/openai/live`, with no slash at the end. `<address>` is `APP_BASE_URL`, or the Railway address without it.
3. **Event types:** only `live.transport.incoming`. Don't add `realtime.call.incoming`: it belongs to an older OpenAI service, and a second handler would race the admin to answer each call.
4. Click **Create**, and copy the signing secret it shows once, which starts with `whsec_`. Put it in the secrets file as `OPENAI_WEBHOOK_SECRET`, or paste it when `connect` asks.

```sh
node devops/bootstrap.mjs connect .env.bootstrap-<name>
```

1. It checks that the admin answers `/api/health/ready` with the right brand, trying `APP_BASE_URL` and the admin's current Railway address.
2. It takes the webhook's secret: from the secrets file, from the admin if it's there already, or by asking.
3. It makes the operator's platform key with `pnpm platform-key:create`, adding it to the admin's existing keys, and writes the key itself to `.platform-keys/<prefix>.json`. If the admin already has an operator key for `OPERATOR_EMAIL`, it keeps that one.
4. It sets `OPENAI_WEBHOOK_SECRET` and `PLATFORM_API_KEYS` on the admin, which redeploys it.
5. In cloud mode with Polar, it sells the plans: it waits for that deployment, then runs `pnpm billing` ([step 8](#8-cloud-mode-sell-plans-through-polar)).

`connect` stops before changing anything if the Railway project is being deleted, or if `APP_BASE_URL` changed after `up` ran, and prints what to run first. With `--yes`, it doesn't wait for the webhook: the webhook stays open, and step 4 waits for it. If the admin's address changed since the webhook was made, such as after a move to a new project without `APP_BASE_URL`, `connect` asks you to change the webhook's URL in OpenAI. The secret stays the same.

## 7. Sign up, and sign the command line in

1. Once the admin's new deployment is active, sign up at `https://<address>/en/signup` as `OPERATOR_EMAIL`, with the 6-digit code from the email ([guide 6.1](../docs/deployment/guide/part-6-first-run.md#61-create-your-account)). With Polar, do it before `connect`, as `up`'s last message says, or when `connect` asks: its billing steps use the operator key, which works only for a verified account.
2. Sign the command line in with the platform key. In PowerShell, this reads the key from its file without showing it:

   ```powershell
   (Get-Content .platform-keys\<prefix>.json -Raw | ConvertFrom-Json).key | pnpm lobbystack login --url https://<address> --key-stdin --profile <name>
   ```

   Elsewhere, run `pnpm lobbystack login --url https://<address> --key-stdin --profile <name>`, paste the key, press Enter, then press Ctrl+D.
3. Move the key to your password manager, then delete `.platform-keys/<prefix>.json`.

`connect` prints these commands with your address, profile and file filled in. The profile is `NAME`, or the address without one, as lower-case letters, digits and dashes, cut to the command line's limit of 40 characters.

## 8. Cloud mode: sell plans through Polar

Until this step, the plan dialog shows the brand's prices from `brands/<brand>/billing.json` but can't sell them: **Start Starter** and **Upgrade to Pro** stay greyed out, because no Polar product sells those prices yet. With Polar, `connect` does this step itself, right after the webhook and the platform key, with the same `pnpm billing` that [guide 3.7](../docs/deployment/guide/part-3-outside-services.md#selling-plans-polar), "Selling plans (Polar)", steps 5 to 8, runs by hand. It needs two things from you:

- **The operator's account.** `pnpm billing` works through the admin with the operator's platform key, which acts as `OPERATOR_EMAIL`'s account, so that account must be signed up, with its email verified ([step 7](#7-sign-up-and-sign-the-command-line-in), step 1). If it isn't yet, `connect` says so as a **BY HAND** step and waits.
- **A Polar token that can set the plans up.** `connect` tries the deployment's own tokens first, the worker's and then the admin's, and uses the first one that belongs to the deployment's organization and that Polar shows the organization's webhooks. Then it asks for nothing more. Tokens made just as [guide 3.7](../docs/deployment/guide/part-3-outside-services.md#selling-plans-polar), "Selling plans (Polar)", step 3, describes can't, since neither may read webhooks, so then `connect` asks for a **setup token**: in Polar's organization (`POLAR` picks sandbox or live), open **Settings > Developers** and click **New Token**. Give it the shortest end date offered and five scopes: `organizations:write`, `meters:write`, `products:write`, `discounts:write` and `webhooks:write`. Paste it when `connect` asks; typing is hidden. `connect` checks that it belongs to the deployment's organization and that Polar shows it the webhooks, and keeps it in memory only: it never goes in the state file, the log or Railway. If Polar refuses the deployment's own token something `pnpm billing` does, such as making a product, `connect` asks for a setup token the same way, then runs the plan and the apply again.

**To need no setup token,** give the worker's token those five scopes as well when you make it, or make one token with every scope of both and give it as both `POLAR_ADMIN_TOKEN` and `POLAR_WORKER_TOKEN`. That saves a token, at a cost: the worker, and with one token the admin too, then runs with a token that can change the plans in Polar and read the webhook's signing secret, which guide 3.7 keeps off Railway. Polar doesn't change a token's scopes once it's made, so on a deployment already set up this takes a new token: put it in the secrets file, run `redo … polar.tokens`, then `up`. `doctor` says which token `connect` will use.

Then `connect` runs three steps:

1. **`connect.billing.apply`** runs `pnpm billing plan`, which changes nothing and lists what an apply would do, asks you to type `yes`, then runs `pnpm billing apply`. That makes the products, prices, meters and discounts in Polar, records which product sells each price, and makes Polar's webhook to `https://<address>/api/webhooks/polar`. On a first run, the apply's own check at the end reports `DRIFT webhook_secret`, since the admin doesn't have the webhook's secret yet. That's expected: the next step sets it.
2. **`connect.billing.secret`** reads the webhook's signing secret from Polar, sets it on the admin as `POLAR_WEBHOOK_SECRET`, which redeploys it, and waits until the admin runs with it. The state file keeps the secret too.
3. **`connect.billing.verify`** runs `pnpm billing verify`, which checks that `billing.json`, the admin's tables and Polar agree.

**Then delete the setup token,** if `connect` asked for one, in Polar under **Settings > Developers**: nothing else uses it. `connect`'s last message puts this first. A token of the deployment's own stays, since the admin or the worker runs with it.

**Start Starter** and **Upgrade to Pro** now open Polar's checkout. In the sandbox, pay with Polar's test card. Polar's webhook then moves the business onto the plan, and a plan that includes a number lets the business buy one.

- **`pnpm billing` runs from your copy of the code,** and reads `brands/<brand>/billing.json` there, so keep that copy on `BRANCH` and up to date, as for `brands/index.json`. It runs in a new folder only you can read, deleted afterwards, and `connect` gives it the admin's address and the operator key itself, so the command line's saved profiles are neither read nor changed.
- **Running `connect` again finishes what a run left.** A plan that `pnpm billing` refuses, or a `yes` not typed, changes nothing. A run that stops after the apply has kept the webhook's secret, and Polar lists it again, so the apply doesn't run twice. When `verify` finds a difference, its `DRIFT` lines say what: fix it, run `connect` again, and it runs the apply again, asking for `yes` again. Each run that has a billing step left asks for the setup token again, unless `POLAR_SETUP_TOKEN` is set or the deployment's own token can set the plans up.
- **With `--yes`,** `connect` doesn't wait for the sign-up: the billing steps stay open, and the next `connect` without `--yes` does them. Once the account is verified, `--yes` applies the plan without asking.
- **To change the plans later,** change `billing.json` in a pull request and deploy it, then run `node devops/bootstrap.mjs redo .env.bootstrap-<name> connect.billing.apply` and `connect`.
- **To do it by hand instead,** follow [guide 3.7](../docs/deployment/guide/part-3-outside-services.md#selling-plans-polar), "Selling plans (Polar)", steps 5 to 8, which run the same `pnpm billing plan`, `apply` and `verify` and put the webhook's secret on the admin with `node devops/railway-vars.mjs`. On a deployment set up that way, or before `connect` did this, the next `connect` runs these steps once as well: the plan should list nothing to change, and the admin has the webhook's secret already, but it still asks for `yes`, and for a setup token unless the deployment's own token can set the plans up.

Polar's own command line (`@polar-sh/cli` 3.0 or later) can make the setup token without copying it: `polar auth token`, with each of the five scopes as a `--scope` option, opens the dashboard's token page with them ticked, and prints the token once you click **Create and send to CLI**. In a POSIX shell:

```sh
POLAR_SETUP_TOKEN="$(polar auth token --scope organizations:write --scope meters:write --scope products:write --scope discounts:write --scope webhooks:write)" node devops/bootstrap.mjs connect .env.bootstrap-<name>
```

This hasn't been tried with the script, nor on Polar's sandbox. The page's end date defaults to 30 days, and whether it offers a shorter one isn't known, so delete the token afterwards all the same.

### On Stripe

With `BILLING_PROVIDER=stripe`, `connect` doesn't sell the plans yet: after [step 7](#7-sign-up-and-sign-the-command-line-in), run `pnpm billing --stripe` yourself, as [guide 3.7](../docs/deployment/guide/part-3-outside-services.md#selling-plans-stripe), "Selling plans (Stripe)", steps 6 to 8 say. The brand's `billing.json` needs a `stripe` block first, added in a pull request and deployed: `doctor` and `connect` say when it has none.

1. **A setup key.** In the same sandbox as the deployment's keys, make a restricted key with write access to products, prices, coupons, meters, the billing portal's configurations, webhook endpoints and event destinations ([Stripe billing](../docs/providers/stripe.md#know-the-keys)). Give it as `STRIPE_SETUP_KEY`, or paste it when asked.
2. **Preview, then apply:**

   ```sh
   pnpm billing plan  --brand <brand> --stripe sandbox --profile <name>
   pnpm billing apply --brand <brand> --stripe sandbox --profile <name> --railway-file .env.stripe-<name>
   ```

   `apply` makes Stripe's products, prices, meters, billing portal configuration, webhook endpoint and meter error destination, links them, and writes `STRIPE_ACCOUNT_ID` for the admin and the worker, which the script set already, and the two secrets Stripe shows once, `STRIPE_WEBHOOK_SECRET` and `STRIPE_METER_WEBHOOK_SECRET`, for the admin.
3. **Put the secrets on the admin.** `railway-vars.mjs` needs a project token for this project and environment (in Railway: the project, **Settings > Tokens**). The file names the admin `admin`, as this script does.

   ```powershell
   $env:RAILWAY_TOKEN = Read-Host -MaskInput "Railway project token"
   node devops/railway-vars.mjs .env.stripe-<name>
   Remove-Item Env:RAILWAY_TOKEN; Remove-Item .env.stripe-<name>
   ```

   The admin redeploys with the secrets. Then set what `plan` listed for Stripe's Dashboard: the grace period before an invoice with usage is finalized, the retries after a failed payment, and the branding.
4. **Check:** `pnpm billing verify --brand <brand> --stripe sandbox --profile <name>` should end `Result: in sync (exit 0)`. Then delete the setup key in Stripe.

**Start Starter** then opens Stripe's checkout. In the sandbox, pay with Stripe's test card `4242 4242 4242 4242`. Stripe's webhook moves the business onto the plan, and the worker makes its overage subscription, anchored to the 1st.

## 9. Check that it all works

- `https://<address>/api/health/ready` answers `"ok":true` with the brand, and `database`, `storage` and `redis` all `ok`. With `APP_BASE_URL`, check both addresses.
- Sign-up and sign-in work on the address you use. If Turnstile refuses, the widget doesn't list that address ([troubleshooting](#when-something-goes-wrong)).
- The dashboard's **Test Call** button starts a browser call.
- Set up the first business and buy its number ([guide 6.3](../docs/deployment/guide/part-6-first-run.md#63-set-up-the-first-business) and [6.4](../docs/deployment/guide/part-6-first-run.md#64-get-a-phone-number-and-make-the-first-calls)), then call it: the receptionist answers. If it doesn't, see [troubleshooting](#when-something-goes-wrong).
- Optionally, the smoke test checks the address, each number's settings at Twilio, and sign-in ([guide 4.9](../docs/deployment/guide/part-4-test-environment.md#49-smoke-test)). Give it this deployment's values on the same line, or it checks the original project's address and numbers. On Windows, run it in Git Bash:

  ```sh
  ADMIN_BASE_URL=https://<address> \
  TWILIO_ACCOUNT_SID=<the subaccount's AC…> TWILIO_AUTH_TOKEN=<its Auth Token> TWILIO_SIP_TRUNK_SID=<the TK…> \
  SMOKE_EXPECTED_NUMBERS=<the business number> pnpm smoke:production
  ```

  The subaccount's values are in `.env.bootstrap-<name>.vars`. The Auth Token stays in your terminal's history, so run this only on your own computer.

## Optional: a private Railway template

`up` can make the Railway layout from a private template of your own in one call, instead of service by service. Make the template once:

```sh
node devops/bootstrap.mjs template .env.bootstrap-<name>
```

1. It builds a project named `TEMPLATE_PROJECT` (by default `lobbystack-template`) with the same Railway steps as `up`: the five services, both volumes, the bucket, the settings and the pre-deploy command, and only the variables that are the same everywhere, such as references between services, ports and paths. No key, password, address or brand goes in.
2. Railway makes a template only of services with a source and a repository link, so it points migrate, the admin and the worker at `TEMPLATE_REPO` (or `REPO`) on `BRANCH`. Railway's GitHub app must reach that repository. If it can't, the script stops and says so.
3. It asks Railway for the template, saves what Railway put in it to `.env.bootstrap-<name>.template.json`, and prints `RAILWAY_TEMPLATE=<code>`. Put that line in each settings file that should use it.

With `RAILWAY_TEMPLATE` set, `up` settles the 13 secrets first, then deploys the template into the new project with Postgres's and Redis's passwords. Railway drops plain values from a template, so `up` fills them in. It waits until Railway shows everything the template made, and carries on: every later step finds what the template made by name, and adds anything it left out. If the project already has its services, the template isn't deployed again.

- The template project's code services are linked to `TEMPLATE_REPO`, so each push there builds them, and those builds fail without secrets. Once you have the code, disconnect the three services in that project, or delete the project.
- Only your workspace lists the template, but anyone with its code can read it. It holds no secrets, but don't publish it.
- When the layout changes, delete `.env.bootstrap-<name>.template.state.json` and run `template` again, then use the new code.

## Running it again is safe

Every command can run again: finished steps show `=`, and every step finds what an earlier run made, by its recorded ID or name, and reuses or updates it.

- **What exists is found, not made twice:**
  - the Railway project (by its ID, else by its recorded name, never one that's being deleted), its services, volumes, bucket, addresses and custom domain;
  - the OpenAI project, the Twilio subaccount and trunk, the Turnstile widget and the PostHog project, by the IDs an earlier run recorded, else by their names; the toll-free number and the Resend domain;
  - the DNS records, by their full names, so a record Railway names relative to the zone is found again.
- **Values are never replaced by mistake.** The 13 platform secrets come from the state file, then the secrets file, then the values already on Railway, and only then are new ones made, so a lost state file can't change the database's passwords. Keys a provider shows once (OpenAI's, Resend's) are read back from Railway; if they never got there, the script asks before replacing them. `connect` keeps the admin's other platform keys. A failed read from Railway stops the run, rather than counting as "not set".
- **Variables are upserted:** each run sets the values it knows and leaves the others alone.

| To | Run |
| --- | --- |
| See what's done, and what's waiting for you by hand | `node devops/bootstrap.mjs status .env.bootstrap-<name>` |
| Run a finished step again | `node devops/bootstrap.mjs redo .env.bootstrap-<name> <step>` (several names, or a group such as `"twilio.*"`), then `up`, or `connect` for `connect.*` steps. The steps that pass its values on run again too, and redo lists them: a redone key reaches Railway through `variables`, and a redone webhook through `connect.variables` |
| Rebuild in a new Railway project, such as after deleting the old one | Delete the old project in Railway, then `redo … railway.project`, `up` and `connect`. The new project gets the old one's name |
| Give the admin another `APP_BASE_URL` | Change the setting, then `redo … railway.domain railway.custom turnstile variables "post.*"`, `up` and `connect`. `connect` asks you to change the webhook's URL. The projects keep their names. Remove the old domain and its CNAME by hand once you no longer want them |
| Move to another OpenAI project, such as one that already has the webhook | Put its `OPENAI_PROJECT_ID` and `OPENAI_API_KEY` in the secrets file, then `redo … openai.project` and `up`: the trunk's address, the admin's key and the worker follow. If its webhook's secret differs, put that in the secrets file too, then `redo … connect.webhook` and `connect` |
| Add PostHog to a deployment `up` deployed before the PostHog step | Put `POSTHOG=us` (or `eu`, or your instance's address) in the settings file, then `up`. Railway deploys migrate, the admin and the worker again ([PostHog](#posthog)) |
| Use another PostHog project | Put its token in the secrets file as `POSTHOG_PROJECT_TOKEN`, then `redo … posthog.project` and `up`: `variables` and `post.posthog` run again |
| Sell changed plans, once a change to `billing.json` is deployed (cloud mode with Polar) | `redo … connect.billing.apply`, then `connect`. It asks for `yes` again, and for a setup token unless the deployment's own token can set the plans up, then puts any new webhook secret on the admin and checks |
| Recover a state file that names an old project, while the live one has the same name | `redo … railway.project`, then `up --yes`, then `connect`: it finds the live project by name and sets it up again, which redeploys its services once. The data and passwords stay |

**What `redo railway.project` does:** it forgets the old project's IDs and addresses, but not its name, and every step that made or set something in that project runs again: the `railway.*` steps, `turnstile`, `variables`, `deploy.*`, `post.*`, `connect.health`, `connect.variables`, and the `connect.billing.*` steps, since the new database has no plans yet, so `connect` sets the plans up again, asking for a setup token unless the deployment's own token can. Without `APP_BASE_URL`, `twilio.tollfree` runs again too, since the texting address changes with the Railway address. The rest stays: the OpenAI project, Twilio, Resend, the Polar tokens and organization, the platform secrets, the webhook's secret and the operator's key, which `connect` puts on the new admin.

## When something goes wrong

The script stops at the failing step, names it, and lists **What to try**. Finished steps stay recorded: fix the problem, and run the same command again. Each run of `up`, `connect`, `doctor`, `redo` and `template` is written to `.env.bootstrap-<name>.log`, with the time and each API call (never headers or bodies) and with secrets shown as `‹hidden›`. `--verbose` shows the calls as they happen. Ctrl+C stops at once, at a question too; finished steps stay recorded.

| You see | Do this |
| --- | --- |
| `<settings file> needs fixing` | Change what it lists. Each line says what the setting must be |
| `Warning: … settings the script doesn't read` | Usually a misspelled setting: check its name against [step 2](#2-write-the-settings-and-secrets-files) |
| `Warning: … more than once, to different values` | Delete the line you don't want: the last one is used |
| `RAILWAY_WORKSPACE_ID is empty`, or `You must specify a workspaceId` | Put the workspace's ID in the settings. The error and `doctor` list the ones the token reaches |
| `didn't accept <TOKEN>` | Run `doctor`, and copy the token again in full. Railway needs an account or workspace token, OpenAI an admin key, Resend a Full access key, Twilio the main account's Auth Token, and PostHog a personal API key made in `POSTHOG`'s region |
| `PostHog won't make another project in the organization …` | The organization has as many projects as its PostHog plan allows, and none that `up` can take over: each has received events, or several haven't. Rename the one this deployment should use to the deployment's name in PostHog, move the organization to pay-as-you-go, give an existing project's token as `POSTHOG_PROJECT_TOKEN`, or set `POSTHOG=no` ([PostHog](#posthog)) |
| `your PostHog user isn't an admin of the organization …` | Ask an admin to make you one, or to make the project and give you its token for `POSTHOG_PROJECT_TOKEN` |
| `the PostHog personal API key reaches 2 organizations` | Put the one to use in the settings file as `POSTHOG_ORGANIZATION_ID`: the message lists them |
| `no PostHog personal API key (phx_…) given` | Make one ([before you start](#before-you-start)) and put it in the secrets file, or set `POSTHOG=no` |
| `isn't allowed to do this` | The token lacks a permission, such as Cloudflare's **DNS Edit** or **Turnstile Edit**, or Twilio is still a trial |
| `STRIPE_ADMIN_KEY is a live key, and STRIPE is sandbox`, or the reverse | Make the key in the deployment's mode: a sandbox's keys start with `rk_test_` |
| `the admin's key belongs to Stripe account …, and the worker's to …` | Make both keys in the deployment's own account or sandbox, put them in the secrets file, and run `up` again |
| `can't see a zone named …` | `CLOUDFLARE_ZONE` is the domain name, not the Zone ID, and the token's Zone Resources must include it |
| `couldn't be reached` | Check the internet connection, a VPN or a firewall. Behind a proxy, set `HTTPS_PROXY` and `NODE_USE_ENV_PROXY=1` |
| `another bootstrap.mjs run (…, process …) is using …` | Let that run finish, or close its window. If no such run is left, delete the `.lock` file it names |
| `another run changed <state file> after this one read it` | Something else saved progress since this run started, such as an old window. Close old windows, then run the command again |
| `the Railway project … is being deleted`, or `Railway has no project …` | The state file names a deleted project. Run the `redo` it prints, then `up`, then `connect` |
| `Railway has 2 projects named …` | Delete or rename the extra project |
| `OpenAI has active projects named "…": 2 of them have that name (…)` (or Twilio subaccounts, trunks, Turnstile widgets, Resend keys) | Names aren't unique there, so the script won't pick one. Archive, delete or rename the extra one, or give the one to use in the secrets file ([what things are named](#what-things-are-named)) |
| `names stay as first recorded, …` | Not an error: the settings would name new things otherwise, and what exists keeps its recorded name. To name everything after the settings, start a new settings file |
| `… is from before the script recorded names … put that NAME back` | The state file was made before names were recorded, so the script needs the `NAME` it was made with to know what things are called. Put it back in the settings file |
| `Postgres's … on Railway differ from the state file's, and the database runs with Railway's` | Someone changed a database setting on Railway, or the state file holds others. The script never changes a running database's passwords: follow [guide 7.18](../docs/deployment/guide/part-7-operations.md#718-rotate-secrets-and-keys) to change one, or set the state file's value to Railway's |
| `already has a volume, mounted at …` | Change that volume's mount path in Railway to the one named |
| `WARNING: <service> has no trigger for …` | Railway's GitHub app can't reach `REPO`, so pushes won't redeploy. Add the repository to the app, then in the service's **Settings > Source**, disconnect and connect it again |
| `migrate's deployment ended failed` | Read migrate's deployment log in Railway ([guide 4.5](../docs/deployment/guide/part-4-test-environment.md#45-add-the-migrate-service-and-set-up-the-database), step 6, and [8.2](../docs/deployment/guide/part-8-troubleshooting.md#82-builds-and-start-up)). `Connection terminated due to connection timeout` means Postgres isn't running: check its logs, redeploy it, then run `up` again |
| Stopped at `railway.domain` | Railway may give the address only after the admin's first deploy: run `up` again |
| Stopped at `connect.health` | The admin isn't answering yet. `connect` lists what each address answered: check the admin's deployment, then run `connect` again |
| `up ran before APP_BASE_URL was …` | Run the `redo` it prints, then `up`, then `connect` |
| `Application not found` from an `up.railway.app` address | That address belongs to no running service, usually one of a deleted project ([recover](#running-it-again-is-safe)) |
| `<name> has A … now. Replace it with a CNAME …?` | `APP_BASE_URL`'s name has an address record in Cloudflare. Type `yes` to replace it (`--yes` replaces it without asking), or choose another address |
| `Railway: not verified yet` | DNS hasn't spread yet. Keep the CNAME **DNS only** (grey cloud): Railway issues the certificate by itself, usually within minutes |
| Sign-up or sign-in fails its Turnstile check | The widget doesn't list the address you're on. `post.turnstile` adds the deployment's addresses when the token can edit Turnstile; otherwise add them in Cloudflare: Turnstile, the widget, **Hostname management**. Cloudflare caps a widget's hostnames, so remove old Railway addresses now and then |
| The upgrade buttons are greyed out (cloud mode) | No Polar product sells the plans yet: run `connect` until its billing steps are done ([step 8](#8-cloud-mode-sell-plans-through-polar)). On Stripe, see [on Stripe](#on-stripe) |
| `DRIFT webhook_secret: POLAR_WEBHOOK_SECRET isn't set`, in what `pnpm billing apply` prints | Expected on a first run: the admin doesn't have the new webhook's secret yet, and `connect.billing.secret` sets it next. From a `pnpm billing verify` you run yourself later, the admin has lost it: `redo … connect.billing.secret`, then `connect` |
| `Sign up at …`, a **BY HAND** step in `connect` | The operator key acts as `OPERATOR_EMAIL`'s account, which isn't verified yet. Sign up with the code from the email, then press Enter |
| `the worker's Polar token belongs to … and POLAR_ORGANIZATION_ID … is …` (`up`), or `the setup token belongs to …` (`connect`) | Make every Polar token in the deployment's one organization. The message names it, and says how to move to another |
| `Polar shows the setup token no webhooks` (`connect`) | The token lacks `webhooks:write`, and likely the other setup scopes. Make one with all five ([step 8](#8-cloud-mode-sell-plans-through-polar)) |
| `Polar refused the worker's Polar token for that (above)` (`connect`) | The worker's token may read webhooks but lacks another setup scope, such as `products:write`. `connect` asks for a setup token and runs the plan and the apply again: what the refused apply made, it finds again |
| `pnpm billing plan refused, so nothing changed` | Fix what `plan` listed above it, then run `connect` again. A `billing.json` the admin's version doesn't know, such as one from a newer copy of the code, is refused: keep your copy on `BRANCH` |
| `pnpm billing verify found differences` | The `DRIFT` lines above it say what. Fix it, then run `connect` again: it runs the apply again, asking for `yes` |
| A phone call rings unanswered, and the admin logs nothing | The call stopped between Twilio and the admin. First check the webhook's project, the cause seen on 2 November 2026: it must be the one in the trunk's origination URI (`sip:<project>@sip.api.openai.com;transport=tls`), with only `live.transport.incoming` and the admin's URL. If the webhook's page shows no delivery, Twilio's call log (**Monitor > Logs > Calls**) shows the SIP response: a 403 or 404 from OpenAI suggests GPT-Live SIP isn't enabled for the project, so ask OpenAI support |
| The webhook's deliveries are refused with 400 | The admin's `OPENAI_WEBHOOK_SECRET` isn't the webhook's. Put the right one in the secrets file, then `redo … connect.webhook connect.variables` and `connect` |
| `has 2 origination URIs` | In Twilio, keep only the one to `sip:<project>@sip.api.openai.com;transport=tls` ([guide 3.3](../docs/deployment/guide/part-3-outside-services.md#33-twilio), step 11). A second one sends some calls elsewhere |
| Stopped at `resend.key` | Make a Sending access key for the domain at `resend.com/api-keys`, put it in the secrets file as `SMTP_PASSWORD`, and run again |
| `Railway's GitHub access can't reach <repo>` (`template`) | Add the repository to Railway's GitHub app, or set `TEMPLATE_REPO` to one it reaches |
| `no valid value given` | The script needed a value and got none. Put it in the secrets file, or run in a terminal where you can type it |

## Files it writes, and secrets

| File | Holds |
| --- | --- |
| `.env.bootstrap-<name>` | The settings. Nothing secret |
| `.env.bootstrap-<name>.secrets` | Your keys. The script only reads it |
| `.env.bootstrap-<name>.state.json` | Each step's result: the 13 platform secrets, the provider keys made or given, the IDs, and with Polar the webhook's signing secret. Never the setup token, the operator key itself, nor the PostHog personal key |
| `.env.bootstrap-<name>.state.json.lock` | Only while a run is going. Delete it only if no run is left |
| `.env.bootstrap-<name>.vars` | Every service's variables, in the format `node devops/railway-vars.mjs` reads |
| `.env.bootstrap-<name>.log` | What each run printed, and each API call, with secrets hidden |
| `.env.bootstrap-<name>.template.state.json`, `.template.json` | Only after `template`. Nothing secret |
| `.platform-keys/<prefix>.json` | Written by `connect`: the platform key. Move it to the password manager, then delete it |
| `.env.stripe-<name>` | Written by `pnpm billing apply --stripe`: Stripe's two signing secrets, until Railway has them. Delete it then |
| The file you give `--railway-file` for Polar | Only if you run `pnpm billing apply` for Polar yourself: the webhook's secret, until Railway has it. Delete it then. `connect` writes its own in a temporary folder only you can read, and deletes it at once |

Git ignores all of them. Once the environment works, copy the state and variable files into the environment's entry in the password manager, keeping a second copy of `ENCRYPTION_KEY` and `OTP_HASH_SECRET` ([guide 1.3](../docs/deployment/guide/part-1-prepare.md#13-decide-these-before-any-data-exists), decision 6). Delete the tokens from the secrets file, and never commit or send these files. Production gets its own settings file and new secrets: never copy test's.

## What it doesn't do, and why

- **OpenAI's webhook, GPT-Live SIP access and spending limit.** OpenAI's API has no endpoint for any of them: its webhook and project-limit settings exist only in the dashboard, and it documents no switch for SIP calls. So the webhook is the one step between `up` and `connect`, and SIP access may need OpenAI support.
- **Twilio's geo permissions, business profile, texting registration and toll-free verification.** Twilio has APIs for these, but each needs a decision or documents the script can't supply. Each country you allow for transfers adds a risk of toll fraud, so you choose them. The business profile and registrations need your business's details and Twilio's review, which takes days.
- **Polar's tokens and Stripe's keys.** Polar makes organization tokens, the setup token among them, and Stripe restricted keys, only in their dashboards: Polar's API makes none, and its command line opens the dashboard's page for it. With Polar, `connect` does the rest of selling plans ([step 8](#8-cloud-mode-sell-plans-through-polar)).
- **Selling plans through Stripe.** It's still `pnpm billing --stripe`, run by you after `connect` and signing the command line in, and `railway-vars.mjs` puts Stripe's secrets on the admin ([on Stripe](#on-stripe)).
- **Signing up, the command-line login, and phone numbers.** Signing up needs the code emailed to a person, and each business buys its own number from the dashboard (in cloud mode, once its plan includes one).
- **DNS outside Cloudflare.** The script prints the records for you to add.
- **PostHog's personal API key, its plan, and a managed reverse proxy.** PostHog makes personal keys only on its settings page, and moving to a paid plan is a billing decision. Its managed proxy needs a DNS record and a domain name ad blockers don't know; once it works, put its address in `POSTHOG_PROXY` ([guide 3.7](../docs/deployment/guide/part-3-outside-services.md#37-optional-services)).
- **The other optional services:** Google Calendar, the map, website import, Zapier and Make ([guide 3.7](../docs/deployment/guide/part-3-outside-services.md#37-optional-services)). Add their variables by hand.
- **What production adds** ([guide 5.2](../docs/deployment/guide/part-5-production.md#52-production-on-railway)): the `production` branch (set `BRANCH`), Postgres backups and a copy outside Railway, Railway's notifications, an outside uptime check, and the workspace's spending alert. Run the script with a separate settings file, `ENVIRONMENT=production` and `POLAR=live`, then do those steps.
- **Cleaning up.** Old custom domains, old Railway addresses on the Turnstile widget, and deleted Railway projects (Railway removes them a couple of days later) stay until you remove them.

## What isn't confirmed

The real runs on 1 and 2 November 2026 settled how Railway behaves (templates, volumes that appear a few seconds late, the admin's address, custom domains and their records, variables that apply at once with no **Deploy** banner), Cloudflare's DNS and Turnstile updates, OpenAI's project and key, Twilio's subaccount and trunk, Resend's domain, `connect`, `pnpm billing` against Polar's sandbox, and a phone call answered through the trunk and the webhook. A fresh run on 5 November 2026 settled names taken from `APP_BASE_URL`, including the first Railway project with a dot in its name, and creating a Turnstile widget through Cloudflare's API. On 7 November 2026 that environment's number answered 10 scripted calls through the OpenAI project the script made, with the webhook made by hand in that project and no request to OpenAI support. Not yet run against a real service:

- **The PostHog steps,** new on 13 November 2026. They follow PostHog's published API schema and its code, as read that day: finding the organization and its projects, making a project with screen recordings on, the plan's and the admin's refusals, taking over a full organization's unused project (its `ingested_event`, and a rename that needs only membership of the project), and `recording_domains`. `doctor` has met PostHog's cloud once, the same day: it read a free-plan organization, its one project and the plan's limit of one as written, and said **FIX**, which is why `up` now takes such a project over. Still to see on a real run: making, taking over and changing a project, and the admin's first build taking the project's values.
- **`connect`'s Polar billing,** new on 12 November 2026. Its first real run, on Windows on 13 November 2026 against Polar's sandbox and a real admin, set the plans up with the worker's own token (it asked for no setup token), showed the plan, applied it after `yes`, and set the admin's `POLAR_WEBHOOK_SECRET`, whose deployment took about 3 minutes (a redeploy with unchanged variables about 5). It then stopped at `connect.billing.secret`: that step read the admin's answer without the `data` envelope every `/api/v1` answer has, so it never saw the secret's hash, and the stand-in of `scripts/bootstrap.test.ts` had answered without the envelope too. Fork PR #160 reads the envelope, and the stand-in now answers in it. Still to see on a real run: `connect.billing.secret` and `connect.billing.verify` finishing, the sign-up `connect` asks for while the operator's account is inactive, and a setup token, including one from Polar's command line ([step 8](#8-cloud-mode-sell-plans-through-polar)).
- **The checks added on 2 November 2026,** against the real services rather than stand-ins: the deployment-trigger warning (Railway's `deploymentTriggers` query was read once against a real project), the lock, the deleted-project stop, and the full names given to DNS records that Railway names relative to the zone.
- **The variables step on a running deployment,** which sets only what differs and deploys the worker again for the admin's values. It uses the same two Railway calls as the one-off move of that environment to another OpenAI project on 2 November 2026, where the admin and the worker deployed again with the new key.
- **Resend's field that limits a key to one domain** (`domain_id`). The environment set up so far took its sending key from its secrets file. If Resend refuses it, the run stops at `resend.key` with the workaround.
- **Buying the toll-free number.**
- **`fullName`,** which turns Resend's record names into names in the zone. Check the email records in Cloudflare after the first run.
