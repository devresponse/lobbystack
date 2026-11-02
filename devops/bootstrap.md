# Set up a LobbyStack environment with `devops/bootstrap.mjs`

`bootstrap.mjs` sets up one LobbyStack environment on Railway, with the outside services it needs: an OpenAI project and key, a Twilio subaccount and SIP trunk, a Resend sending domain, Cloudflare DNS records and a Turnstile widget, and the Polar tokens in cloud mode. You describe the environment in one small settings file. The script does the rest through each provider's API, records every finished step, and stops with exact instructions where only a person can act.

**Status:** checked on 2 November 2026 against `main` at `a771db6` plus this change. A test harness ran every command against stand-ins for each API: 45 checks covering a fresh run, reruns, `--yes`, `redo`, a deleted project, the lock and the state-file guard. Before that, on 1 and 2 November 2026, the script set up a real test environment several times, from a private template and with its own address, and on 2 November that environment answered a phone call. The parts not yet run against a real service are listed in [What isn't confirmed](#what-isnt-confirmed). Set up a test environment first.

Section numbers such as "guide 3.2" in this page and in the script's messages are those of the [deployment guide](../docs/deployment/guide/README.md): mainly [Part 3](../docs/deployment/guide/part-3-outside-services.md) (outside services), [Part 4](../docs/deployment/guide/part-4-test-environment.md) (a test environment), [Part 5](../docs/deployment/guide/part-5-production.md) (production) and [Appendix A](../docs/deployment/guide/appendix-a-variables.md) (variables). The script does most of Parts 3 and 4.

## The whole process

| # | What | Command or place |
| --- | --- | --- |
| 1 | Accounts, tools and tokens | [Before you start](#before-you-start) |
| 2 | Write the settings and secrets files | `node devops/bootstrap.mjs init <name>` |
| 3 | Check them | `doctor`, then `up --dry-run` |
| 4 | Set everything up and deploy | `up` |
| 5 | The steps only a person can do | the OpenAI, Twilio and Cloudflare dashboards |
| 6 | Connect the incoming-call webhook, and make the platform key | `connect` |
| 7 | Sign up, and sign the command line in | the dashboard, `pnpm lobbystack login` |
| 8 | Cloud mode only: sell plans through Polar | `pnpm billing plan`, `apply`, `verify` |
| 9 | Check that it all works | health check, a test call, `pnpm smoke:production` |

`<name>` is the environment's name, such as `acme-test`, and the settings file is `.env.bootstrap-<name>`. Run every command from the repository folder.

## What the script does, and what stays with you

| Part | The script | You |
| --- | --- | --- |
| GitHub | Checks that the fork's CI, Runtime images and Replacement Platform workflows are on, turning on any that are off, and that `BRANCH` has the brand's folder | Turn the workflows on by hand if `gh` isn't signed in as the fork's owner. Sync the fork if the brand is missing |
| OpenAI | Creates the project and its API key, owned by a service account | Make sure the project takes GPT-Live SIP calls, set its spending limit, and create the incoming-call webhook |
| Twilio | Creates the subaccount, the SIP trunk (Secure Trunking, transfers) and its one origination URI, to the OpenAI project. In cloud mode it buys or reuses the shared toll-free number | Geo permissions, the business profile, texting registration and toll-free verification |
| Email | Creates the Resend domain, its DNS records, a DMARC record if there's none, and a key that can only send from that domain | Nothing, if the domain's DNS is at Cloudflare |
| Railway | Creates the project, the five services, both volumes, the bucket, each service's settings, the admin's address, the 13 platform secrets and about 90 variables. It deploys Postgres and Redis, waits for migrate to pass, then connects the admin and the worker, which Railway builds | Nothing |
| The admin's own address (`APP_BASE_URL`) | Adds it to the admin as a custom domain, writes its CNAME and Railway's TXT check in Cloudflare, and makes it the admin's `APP_BASE_URL`. It checks all of it again after the deploy | Nothing, if the domain's DNS is at Cloudflare |
| Turnstile | Creates the widget, or adds this deployment's addresses to the widget whose keys you gave | Nothing, if the Cloudflare token can edit Turnstile |
| `connect` | Checks the admin's health, takes the webhook's secret, makes the operator's platform key, and sets both on the admin | Create the webhook in OpenAI first |
| Polar, in cloud mode | Takes the admin's and the worker's tokens | Make those tokens, and later run `pnpm billing` ([step 8](#8-cloud-mode-sell-plans-through-polar)) |

## Before you start

**Accounts:** Railway on a paid plan, OpenAI with prepaid credit, Twilio upgraded from trial (a trial account has no SIP trunking), Resend, Cloudflare holding the domain's DNS, and Polar for cloud mode ([guide 1.1](../docs/deployment/guide/part-1-prepare.md#11-accounts-youll-need)).

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

Two more come later, and the script never sees them: a **Polar setup token** for `pnpm billing` ([step 8](#8-cloud-mode-sell-plans-through-polar)), and a **Railway project token** for `node devops/railway-vars.mjs`.

## 2. Write the settings and secrets files

```sh
node devops/bootstrap.mjs init <name>
```

This writes `.env.bootstrap-<name>` for the settings and `.env.bootstrap-<name>.secrets` for the keys. Git ignores both, like every `.env.*` file. Write each setting on its own line as `KEY=value`, with no comment after the value. Quotes around a value are allowed and dropped.

| Setting | Example | What it is |
| --- | --- | --- |
| `NAME` | `acme-test` | Names the Railway project, the OpenAI project, the Twilio subaccount and the Turnstile widget. Lower-case letters, digits and dashes |
| `BRAND` | `acme` | A folder under `brands/` on `BRANCH`. In cloud mode it also needs a `billing.json` ([guide 3.6](../docs/deployment/guide/part-3-outside-services.md#36-your-brand)) |
| `ENVIRONMENT` | `test` | `test` or `production`. Production adds `REQUIRE_EMAIL_VERIFICATION=true`, sets no `BRAND_PRESET`, and so needs `APP_BASE_URL` on one of the brand's domains |
| `REPO`, `BRANCH` | `your-org/lobbystack`, `main` | The fork and the branch Railway builds. Railway's GitHub app must reach the repository: Railway can build a public repository it can't reach, but then never redeploys on a push, and `up` warns about it |
| `DEPLOYMENT_MODE` | `self_hosted_standard` | `self_hosted_standard` (every business unlimited) or `cloud` (businesses buy plans through Polar). Hard to change once businesses exist ([guide 1.3](../docs/deployment/guide/part-1-prepare.md#13-decide-these-before-any-data-exists), decision 1) |
| `OPERATOR_EMAIL` | `ops@example.com` | Owns the platform key, signs up first, and receives DMARC reports |
| `RAILWAY_WORKSPACE_ID` | the workspace's ID | Railway won't create a project without it. It's in the workspace's **Settings**, **General** tab, and `doctor` lists the workspaces the token reaches |
| `BUCKET_REGION` | `iad` | `sjc`, `iad`, `ams` or `sin`. It can't change later |
| `APP_BASE_URL` | `demo.example.com` | Optional: the dashboard's own address, with or without `https://`, inside `CLOUDFLARE_ZONE`. Empty: the admin keeps Railway's free address. See [the address and the brand](#the-address-and-the-brand). `CUSTOM_HOST`, its older name, still works |
| `EMAIL_DOMAIN`, `EMAIL_FROM` | `mail.example.com`, `Acme <no-reply@mail.example.com>` | The subdomain kept for sending email, inside `CLOUDFLARE_ZONE`, and the sender on it |
| `RESEND_REGION` | `us-east-1` | `us-east-1`, `eu-west-1`, `sa-east-1` or `ap-northeast-1`. It can't change later |
| `CLOUDFLARE_ZONE` | `example.com` | The zone's domain name, not its 32-character Zone ID. Empty: the script prints every DNS record for you to add |
| `CLOUDFLARE_ACCOUNT_ID` | 32 characters | From the zone's **Overview** page. Empty: you make the Turnstile widget by hand |
| `TWILIO_TOLLFREE` | `buy` | Cloud mode only: `buy`, a number already in the subaccount such as `+18445550123`, or empty for none |
| `POLAR_ORGANIZATION_ID`, `POLAR` | the ID, `sandbox` | Cloud mode only. `POLAR` is `sandbox` or `live` |
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

### The secrets file

It holds keys, one `KEY=value` per line. Fill in only what you have: an empty line means the script asks, or creates that thing.

- **The tokens above.** An environment variable of the same name wins over the file.
- **Things you already have,** used instead of creating new ones:
  - `OPENAI_PROJECT_ID` with `OPENAI_API_KEY`, both or neither;
  - `TWILIO_ACCOUNT_SID` with `TWILIO_AUTH_TOKEN`, and optionally `TWILIO_SIP_TRUNK_SID`;
  - `SMTP_PASSWORD`, Resend's sending key;
  - `TURNSTILE_SITE_KEY` with `TURNSTILE_SECRET_KEY`;
  - `POLAR_ADMIN_TOKEN` with `POLAR_WORKER_TOKEN`, in cloud mode;
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
- every token it finds, with a read-only call, saying what already exists and will be reused.

Each problem is marked **FIX**. The dry run lists every step in order and calls nothing.

## 4. Set it up

```sh
node devops/bootstrap.mjs up .env.bootstrap-<name>
```

It asks you to type `yes`, since the services bill your accounts. Then it works through the steps, one line each: `+` runs a step, and `=` skips one that's already done.

1. **GitHub, OpenAI, Twilio, email, Polar:** the outside services, in that order.
2. **Railway:** the project, found by name or made in `RAILWAY_WORKSPACE_ID`. Then the services, volumes and bucket, from your template or one by one, and each service's settings and migrate's pre-deploy command.
3. **Address:** the admin's Railway address; with `APP_BASE_URL`, the custom domain and its DNS records; then the Turnstile widget.
4. **Variables:** the 13 platform secrets (kept, given, read back from Railway, or new), then every service's variables, without deploying yet. They're also written to `.env.bootstrap-<name>.vars`.
5. **Deploy:**
   1. Postgres and Redis, with their passwords, until Railway reports them running.
   2. migrate, until its deployment succeeds. Its pre-deploy runs the migrations, sets the database roles' passwords and checks RLS.
   3. The admin and the worker, which Railway then builds.

   After connecting each code service, the script checks that Railway made a deployment trigger for `REPO` and `BRANCH`. Without one, pushes don't redeploy, and it prints a **WARNING** with the fix.
6. **After the deploy:**
   - `post.dns`, with `APP_BASE_URL`: the custom domain is on the admin and its records are in Cloudflare, DNS only. It says whether Railway has verified the domain and issued its certificate.
   - `post.urls`: the admin's `APP_BASE_URL`, `SITE_URL` and `AUTH_TRUSTED_ORIGINS`, and the worker's `APP_BASE_URL`, match the settings. With `APP_BASE_URL`, `AUTH_TRUSTED_ORIGINS` lists both addresses, so signing in works on either.
   - `post.turnstile`: the widget lists the Railway address and `APP_BASE_URL`.

It ends with the address, and with any step still waiting for you. A **BY HAND** step says exactly what to do and waits for Enter. The admin answers at `https://<address>/api/health/ready` once its build finishes. With `APP_BASE_URL`, the Railway address answers first, while DNS spreads and Railway issues the certificate.

**Options:**

- `--yes` doesn't stop at questions or at **BY HAND** steps. A step it didn't wait at isn't recorded as done: `up` lists it at the end, `status` shows it as `OPEN`, and it runs again, and waits, the next time you run without `--yes`. A value the script needs, such as a token, is still asked for.
- `--verbose` shows each API call.
- `--dry-run` shows the steps and calls nothing.

**One run at a time.** While `up`, `connect`, `redo` or `template` runs, it holds a lock beside the state file, and a second run on the same file stops at once, naming the first. A run that was killed leaves its lock behind, and the next run takes it over. As well, a run never saves over a state file that something else changed after it started: it stops instead, saving nothing.

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

`connect` stops before changing anything if the Railway project is being deleted, or if `APP_BASE_URL` changed after `up` ran, and prints what to run first. With `--yes`, it doesn't wait for the webhook: the webhook stays open, and step 4 waits for it. If the admin's address changed since the webhook was made, such as after a move to a new project without `APP_BASE_URL`, `connect` asks you to change the webhook's URL in OpenAI. The secret stays the same.

## 7. Sign up, and sign the command line in

1. Once the admin's new deployment is active, sign up at `https://<address>/en/signup` as `OPERATOR_EMAIL`, with the 6-digit code from the email ([guide 6.1](../docs/deployment/guide/part-6-first-run.md#61-create-your-account)).
2. Sign the command line in with the platform key. In PowerShell, this reads the key from its file without showing it:

   ```powershell
   (Get-Content .platform-keys\<prefix>.json -Raw | ConvertFrom-Json).key | pnpm lobbystack login --url https://<address> --key-stdin --profile <name>
   ```

   Elsewhere, run `pnpm lobbystack login --url https://<address> --key-stdin --profile <name>`, paste the key, press Enter, then press Ctrl+D.
3. Move the key to your password manager, then delete `.platform-keys/<prefix>.json`.

`connect` prints these commands with your address, profile and file filled in.

## 8. Cloud mode: sell plans through Polar

Until this step, the plan dialog shows the brand's prices from `brands/<brand>/billing.json` but can't sell them: **Start Starter** and **Upgrade to Pro** stay greyed out, because no Polar product sells those prices yet. The full steps are in [guide 3.7](../docs/deployment/guide/part-3-outside-services.md#selling-plans-polar), "Selling plans (Polar)", steps 6 to 8.

1. **A setup token.** In Polar's organization (`POLAR` picks sandbox or live), open **Settings > Developers** and click **New Token**. Give it the shortest end date offered and five scopes: `organizations:write`, `meters:write`, `products:write`, `discounts:write` and `webhooks:write`.
2. **Preview, then apply.** Paste the setup token when each command asks; typing is hidden.

   ```sh
   pnpm billing plan  --brand <brand> --polar sandbox --profile <name>
   pnpm billing apply --brand <brand> --polar sandbox --profile <name> --railway-file .env.polar-<name>
   ```

   `apply` creates the products, prices and meters in Polar, records which product sells each price, creates Polar's webhook to `https://<address>/api/webhooks/polar`, and writes three Railway values to `.env.polar-<name>`: `POLAR_API_BASE_URL` and `POLAR_ORGANIZATION_ID` for the admin and the worker, and `POLAR_WEBHOOK_SECRET` for the admin. The script set the first two already.
3. **Put the webhook's secret on the admin.** The file names the admin `lobbystack-admin`, and this script names it `admin`, so change the name first. `railway-vars.mjs` needs a project token for this project and environment (in Railway: the project, **Settings > Tokens**).

   ```powershell
   (Get-Content .env.polar-<name>) -replace 'lobbystack-admin', 'admin' | Set-Content .env.polar-<name>
   $env:RAILWAY_TOKEN = Read-Host -MaskInput "Railway project token"
   node devops/railway-vars.mjs .env.polar-<name>
   Remove-Item Env:RAILWAY_TOKEN; Remove-Item .env.polar-<name>
   ```

   The admin redeploys with the secret.
4. **Check:**

   ```sh
   pnpm billing verify --brand <brand> --polar sandbox --profile <name>
   ```

   It should end `Result: in sync (exit 0)`. `DRIFT webhook_secret` means the admin doesn't have `POLAR_WEBHOOK_SECRET` yet (step 3). `exit 2` means Polar refused the token: give it the setup token, with all five scopes. Then delete the setup token in Polar.

**Start Starter** and **Upgrade to Pro** now open Polar's checkout. In the sandbox, pay with Polar's test card. Polar's webhook then moves the business onto the plan, and a plan that includes a number lets the business buy one.

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

Every command can run again: finished steps show `=`, and every step finds what an earlier run made, by name, and reuses or updates it.

- **What exists is found, not made twice:**
  - the Railway project (by name, never one that's being deleted), its services, volumes, bucket, addresses and custom domain;
  - the OpenAI project, the Twilio subaccount, trunk and toll-free number, and the Resend domain;
  - the DNS records, by their full names, so a record Railway names relative to the zone is found again;
  - the Turnstile widget.
- **Values are never replaced by mistake.** The 13 platform secrets come from the state file, then the secrets file, then the values already on Railway, and only then are new ones made, so a lost state file can't change the database's passwords. Keys a provider shows once (OpenAI's, Resend's) are read back from Railway; if they never got there, the script asks before replacing them. `connect` keeps the admin's other platform keys. A failed read from Railway stops the run, rather than counting as "not set".
- **Variables are upserted:** each run sets the values it knows and leaves the others alone.

| To | Run |
| --- | --- |
| See what's done, and what's waiting for you by hand | `node devops/bootstrap.mjs status .env.bootstrap-<name>` |
| Run a finished step again | `node devops/bootstrap.mjs redo .env.bootstrap-<name> <step>` (several names, or a group such as `"twilio.*"`), then `up`, or `connect` for `connect.*` steps |
| Rebuild in a new Railway project, such as after deleting the old one | Delete the old project in Railway, then `redo … railway.project`, `up` and `connect` |
| Give the admin another `APP_BASE_URL` | Change the setting, then `redo … railway.domain railway.custom turnstile variables "post.*"`, `up` and `connect`. `connect` asks you to change the webhook's URL. Remove the old domain and its CNAME by hand once you no longer want them |
| Recover a state file that names an old project, while the live one has the same name | `redo … railway.project`, then `up --yes`, then `connect`: it finds the live project by name and sets it up again, which redeploys its services once. The data and passwords stay |

**What `redo railway.project` does:** it forgets the old project's IDs and addresses, and every step that made or set something in that project runs again: the `railway.*` steps, `turnstile`, `variables`, `deploy.*`, `post.*`, `connect.health` and `connect.variables`. Without `APP_BASE_URL`, `twilio.tollfree` runs again too, since the texting address changes with the Railway address. The rest stays: the OpenAI project, Twilio, Resend, the Polar tokens, the platform secrets, the webhook's secret and the operator's key, which `connect` puts on the new admin.

## When something goes wrong

The script stops at the failing step, names it, and lists **What to try**. Finished steps stay recorded: fix the problem, and run the same command again. Each run of `up`, `connect`, `doctor`, `redo` and `template` is written to `.env.bootstrap-<name>.log`, with the time and each API call (never headers or bodies) and with secrets shown as `‹hidden›`. `--verbose` shows the calls as they happen. Ctrl+C stops at once, at a question too; finished steps stay recorded.

| You see | Do this |
| --- | --- |
| `<settings file> needs fixing` | Change what it lists. Each line says what the setting must be |
| `Warning: … settings the script doesn't read` | Usually a misspelled setting: check its name against [step 2](#2-write-the-settings-and-secrets-files) |
| `Warning: … more than once, to different values` | Delete the line you don't want: the last one is used |
| `RAILWAY_WORKSPACE_ID is empty`, or `You must specify a workspaceId` | Put the workspace's ID in the settings. The error and `doctor` list the ones the token reaches |
| `didn't accept <TOKEN>` | Run `doctor`, and copy the token again in full. Railway needs an account or workspace token, OpenAI an admin key, Resend a Full access key, and Twilio the main account's Auth Token |
| `isn't allowed to do this` | The token lacks a permission, such as Cloudflare's **DNS Edit** or **Turnstile Edit**, or Twilio is still a trial |
| `can't see a zone named …` | `CLOUDFLARE_ZONE` is the domain name, not the Zone ID, and the token's Zone Resources must include it |
| `couldn't be reached` | Check the internet connection, a VPN or a firewall. Behind a proxy, set `HTTPS_PROXY` and `NODE_USE_ENV_PROXY=1` |
| `another bootstrap.mjs run (…, process …) is using …` | Let that run finish, or close its window. If no such run is left, delete the `.lock` file it names |
| `another run changed <state file> after this one read it` | Something else saved progress since this run started, such as an old window. Close old windows, then run the command again |
| `the Railway project … is being deleted`, or `Railway has no project …` | The state file names a deleted project. Run the `redo` it prints, then `up`, then `connect` |
| `Railway has 2 projects named …` | Delete or rename the extra project |
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
| The upgrade buttons are greyed out (cloud mode) | No Polar product sells the plans yet: [step 8](#8-cloud-mode-sell-plans-through-polar) |
| `DRIFT webhook_secret: POLAR_WEBHOOK_SECRET isn't set` | [Step 8](#8-cloud-mode-sell-plans-through-polar), step 3 |
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
| `.env.bootstrap-<name>.state.json` | Each step's result: the 13 platform secrets, the provider keys made or given, and the IDs |
| `.env.bootstrap-<name>.state.json.lock` | Only while a run is going. Delete it only if no run is left |
| `.env.bootstrap-<name>.vars` | Every service's variables, in the format `node devops/railway-vars.mjs` reads |
| `.env.bootstrap-<name>.log` | What each run printed, and each API call, with secrets hidden |
| `.env.bootstrap-<name>.template.state.json`, `.template.json` | Only after `template`. Nothing secret |
| `.platform-keys/<prefix>.json` | Written by `connect`: the platform key. Move it to the password manager, then delete it |
| `.env.polar-<name>` | Written by `pnpm billing apply`: Polar's webhook secret, until Railway has it. Delete it then |

Git ignores all of them. Once the environment works, copy the state and variable files into the environment's entry in the password manager, keeping a second copy of `ENCRYPTION_KEY` and `OTP_HASH_SECRET` ([guide 1.3](../docs/deployment/guide/part-1-prepare.md#13-decide-these-before-any-data-exists), decision 6). Delete the tokens from the secrets file, and never commit or send these files. Production gets its own settings file and new secrets: never copy test's.

## What it doesn't do, and why

- **OpenAI's webhook, GPT-Live SIP access and spending limit.** OpenAI's API has no endpoint for any of them: its webhook and project-limit settings exist only in the dashboard, and it documents no switch for SIP calls. So the webhook is the one step between `up` and `connect`, and SIP access may need OpenAI support.
- **Twilio's geo permissions, business profile, texting registration and toll-free verification.** Twilio has APIs for these, but each needs a decision or documents the script can't supply. Each country you allow for transfers adds a risk of toll fraud, so you choose them. The business profile and registrations need your business's details and Twilio's review, which takes days.
- **Polar's tokens.** Polar makes organization tokens only in its dashboard. Selling plans is `pnpm billing`, a separate command that works through the running deployment with the operator's key, so it comes after `connect` and signing the command line in.
- **The Polar webhook's secret on Railway.** `pnpm billing apply` writes it to a file that uses the original project's service name, `lobbystack-admin`, and `railway-vars.mjs` needs a project token. It takes one rename and one command ([step 8](#8-cloud-mode-sell-plans-through-polar), step 3).
- **Signing up, the command-line login, and phone numbers.** Signing up needs the code emailed to a person, and each business buys its own number from the dashboard (in cloud mode, once its plan includes one).
- **DNS outside Cloudflare.** The script prints the records for you to add.
- **The optional services:** Google Calendar, the map, website import, PostHog, Zapier and Make ([guide 3.7](../docs/deployment/guide/part-3-outside-services.md#37-optional-services)), and telemetry (`OTEL_EXPORTER_OTLP_*`). Add their variables by hand.
- **What production adds** ([guide 5.2](../docs/deployment/guide/part-5-production.md#52-production-on-railway)): the `production` branch (set `BRANCH`), Postgres backups and a copy outside Railway, Railway's notifications, an outside uptime check, and the workspace's spending alert. Run the script with a separate settings file, `ENVIRONMENT=production` and `POLAR=live`, then do those steps.
- **Cleaning up.** Old custom domains, old Railway addresses on the Turnstile widget, and deleted Railway projects (Railway removes them a couple of days later) stay until you remove them.

## What isn't confirmed

The real runs on 1 and 2 November 2026 settled how Railway behaves (templates, volumes that appear a few seconds late, the admin's address, custom domains and their records, variables that apply at once with no **Deploy** banner), Cloudflare's DNS and Turnstile updates, OpenAI's project and key, Twilio's subaccount and trunk, Resend's domain, `connect`, `pnpm billing` against Polar's sandbox, and a phone call answered through the trunk and the webhook. Not yet run against a real service:

- **Whether a project the script makes takes phone calls with no request to OpenAI.** On 2 November 2026 the first test calls rang unanswered: the webhook had been made in a different OpenAI project from the one the trunk sends calls to. With the deployment moved to the webhook's project, which was made by hand in OpenAI's dashboard, the next call was answered, with no request to OpenAI support. The project the script made never got a webhook, so it's untested.
- **The checks added on 2 November 2026,** against the real services rather than stand-ins: the deployment-trigger warning (Railway's `deploymentTriggers` query was read once against a real project), the lock, the deleted-project stop, and the full names given to DNS records that Railway names relative to the zone.
- **Resend's field that limits a key to one domain** (`domain_id`). The environment set up so far took its sending key from its secrets file. If Resend refuses it, the run stops at `resend.key` with the workaround.
- **Creating a Turnstile widget,** since that environment gave its keys, and **buying the toll-free number.**
- **`fullName`,** which turns Resend's record names into names in the zone. Check the email records in Cloudflare after the first run.
