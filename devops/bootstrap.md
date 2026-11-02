# Setting up an environment with `devops/bootstrap.mjs`

`bootstrap.mjs` sets up one LobbyStack environment on Railway, such as RealInfoBot's test environment, together with its OpenAI project, Twilio subaccount and trunk, Resend domain, Turnstile widget and DNS records. It replaces most of sections 3 to 12 of the Railway deployment guide with three commands. Where only a person can do a step, it stops, says exactly what to do, and waits.

**Status:** tested on 1 November 2026 against stand-ins for every API it calls, including a second full run with its state file deleted, with the requests checked against each provider's documentation. Since 2 November 2026 it has set up RealInfoBot's test environment against the real services several times, from a private template. Run it on a test environment first, and read [What isn't confirmed](#what-isnt-confirmed).

**Which guide:** the section numbers here and in the script's messages, such as "guide 3.6" or "Appendix A.1", are those of the single-deployment Railway guide that ships with a white-label fork's deployment kit. That guide isn't in this repository. In this repository's [deployment guide](../docs/deployment/guide/README.md), the same ground is [Part 3](../docs/deployment/guide/part-3-outside-services.md) (outside services), [Part 4](../docs/deployment/guide/part-4-test-environment.md) (the test environment), [Part 5](../docs/deployment/guide/part-5-production.md) (production) and [Appendix A](../docs/deployment/guide/appendix-a-variables.md) (variables).

## What it does, and what stays with you

| Step | The script | You |
| --- | --- | --- |
| GitHub | Checks that the fork's CI, Runtime images and Replacement Platform workflows are on, and turns on any that are off (that needs admin rights on the fork); checks that the branch has the brand folder | Enable the workflows on the fork's Actions tab if `gh` isn't signed in as its owner; click **Sync fork** if the brand is missing |
| OpenAI | Creates the project and its API key, owned by a service account | Make sure GPT-Live SIP works for the project, set the spending limit, and later create the incoming-call webhook (OpenAI's API can't make that one yet) |
| Twilio | Creates the subaccount, the SIP trunk (Secure Trunking, transfers) and its origination URI to the OpenAI project. In cloud mode, it buys or reuses the toll-free number and sets its texting address | Geo permissions, business profile, texting registration and toll-free verification, which Twilio reviews |
| Email | Creates the Resend domain, its DNS records in Cloudflare (or prints them for you), and a key that can only send from that domain | Nothing, unless your DNS isn't at Cloudflare |
| Polar (cloud mode) | Asks for the two tokens | Create the tokens: Polar makes them only in its dashboard |
| Railway | Creates the project, the five services, both volumes, the bucket, every setting of guide section 9, the admin's address, the 13 secrets and all about 90 variables, then connects the code: migrate first, then the admin and the worker | Nothing: it deploys Postgres and Redis and waits for migrate to pass. If Railway's API won't deploy them, it asks you to click **Deploy** |
| Its own address (`APP_BASE_URL`) | Adds it to Railway as the admin's custom domain, writes its CNAME (and Railway's `railway-verify` TXT check) in Cloudflare, DNS only, and makes it the admin's `APP_BASE_URL`, with sign-in trusting both it and the Railway address. After the deploy, it checks the records and the admin's and the worker's addresses again, and fixes what differs | Nothing, unless your DNS isn't at Cloudflare |
| Turnstile | Creates the widget for the admin's addresses. For a widget whose keys you gave, it adds this deployment's addresses to it after the deploy | Nothing, if the Cloudflare token has **Account > Turnstile > Edit** |
| After the address works | Checks `/api/health/ready`, makes the platform key, sets the webhook secret and the key on the admin | Create the webhook, sign up with the email code, sign the command line in, run `pnpm billing` (cloud mode) and the smoke test |

## Before you start

1. **Accounts** (guide 3.1): Railway on Pro, OpenAI with credit, Twilio upgraded from trial, Resend, Cloudflare, and Polar for cloud mode.
2. **Your computer:** Node.js 18 or later, and `pnpm install` done in the repository folder. Two tools are optional, and the script asks you to do their step by hand without them:
   - the Railway CLI (`npm install --global @railway/cli`), used only to make the bucket;
   - the GitHub CLI (`gh`, signed in), used to check the fork's workflows and brand folder. Turning workflows on needs `gh` signed in as the fork's owner; reading them doesn't.
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
| `RAILWAY_WORKSPACE_ID` | the workspace's ID | Needed to make the project: Railway refuses a new project without a workspace. Find it in Railway under the workspace's **Settings**, **General** tab (Workspace ID, with a copy button), or run `doctor`, which lists the workspaces your token reaches. Can stay empty only if the project already exists |
| `BUCKET_REGION` | `iad` | `sjc`, `iad`, `ams` or `sin`. It never changes |
| `APP_BASE_URL` | `demo.realinfobot.com` | Optional: the dashboard's own address, with or without `https://`, and inside `CLOUDFLARE_ZONE`. The script adds it to Railway, writes its CNAME in Cloudflare, adds it to the Turnstile widget, and sets the admin's `APP_BASE_URL`, `SITE_URL` and `AUTH_TRUSTED_ORIGINS`, and the worker's `APP_BASE_URL`, from it. The brand then comes from the address's domain, so it must be one the brand owns (`realinfobot.com` covers `demo.realinfobot.com`). Empty: Railway's free address, with `BRAND_PRESET`. `CUSTOM_HOST`, its older name, still works |
| `EMAIL_DOMAIN`, `EMAIL_FROM` | `notifications.realinfobot.com`, `no-reply@notifications.realinfobot.com` | The subdomain kept for email, and the sender on it |
| `RESEND_REGION` | `us-east-1` | It can't change later |
| `CLOUDFLARE_ZONE`, `CLOUDFLARE_ACCOUNT_ID` | `realinfobot.com`, the account ID | The domain name of the zone that holds both domains, not the Zone ID Cloudflare shows beside it; and the Account ID from the zone's Overview page (right-hand column, under API). Empty zone: the script prints the DNS records for you to add. Empty account: you make the Turnstile widget by hand |
| `TWILIO_TOLLFREE` | `buy` | Cloud mode only: `buy`, a number you already have in the subaccount, or empty |
| `POLAR_ORGANIZATION_ID`, `POLAR` | the ID, `sandbox` | Cloud mode only |
| `STEP_GITHUB` ... `STEP_TURNSTILE` | `yes` | `no` skips that service's API. The script then takes its values from the secrets file, or asks you for them |
| `RAILWAY_TEMPLATE` | the code `template` printed | Optional. With it, `up` makes the services, volumes and settings from your private template in one call; empty, it makes them one by one. See [A private Railway template](#optional-a-private-railway-template) |
| `TEMPLATE_PROJECT` | `lobbystack-template` | Optional, used only by `template`: the Railway project the template is made from. It must differ from `NAME` |
| `TEMPLATE_REPO` | `devresponse/lobbystack` | Optional, used only by `template`: the repository the template project's code services point at, if not `REPO`. Railway's GitHub access must reach it. `up` connects each deployment to its own `REPO` either way |

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

## 3. Check before you start

```sh
node devops/bootstrap.mjs doctor .env.bootstrap-realinfobot-test
node devops/bootstrap.mjs up .env.bootstrap-realinfobot-test --dry-run
```

`doctor` changes nothing and asks nothing. It checks Node.js, pnpm, the Railway and GitHub CLIs, that Git ignores the files holding secrets, and each token it can find with a read-only call: for example, that the OpenAI key is an admin key, that the Twilio account isn't a trial, and that the Cloudflare token can see the zone. It also says what already exists and will be reused, such as an OpenAI project with the same name. Each problem is marked **FIX** with what to do.

The dry run lists every step in order and calls nothing. Both refuse a settings file with a mistake in it, and say which line.

## 4. Set it up

```sh
node devops/bootstrap.mjs up .env.bootstrap-realinfobot-test
```

1. It asks you to type `yes`, since the services it creates bill your accounts. Before buying a toll-free number, it asks again.
2. It works through the steps, one line each. At a **BY HAND** step, it says what to do and waits for Enter.
3. Two waits come near the end, and the script does both. It deploys Postgres and Redis with their passwords and waits until Railway reports them running. Then it connects migrate and waits until its deployment succeeds, which means its pre-deploy passed (its log ends with `RLS enabled and forced on <n> tables`); a failed deployment stops the run, and guide 10.3 lists the usual causes. Only then do the admin and the worker connect, and Railway builds them. If Railway's API won't deploy or report a service, the script falls back to telling you what to click and waits for Enter.
4. After the deploy, three steps settle the admin's addresses. Each reads what's there and changes only what differs:
   - `post.dns`, with `APP_BASE_URL` set: makes sure the custom domain is on the admin and its CNAME (and Railway's check) is in Cloudflare, DNS only, asking Railway again if it hadn't sent the records yet. An A or AAAA record already at that name is replaced after asking. It prints whether Railway has verified the domain and issued its certificate.
   - `post.urls`: checks the admin's `APP_BASE_URL`, `SITE_URL` and `AUTH_TRUSTED_ORIGINS`, and the worker's `APP_BASE_URL`, against the settings, and sets any that differ, which redeploys that service. With `APP_BASE_URL`, `AUTH_TRUSTED_ORIGINS` lists both it and the Railway address, so signing in works on either.
   - `post.turnstile`: adds the Railway address and `APP_BASE_URL` to the Turnstile widget, found by its site key, so a widget whose keys you gave works too. It keeps the widget's name, mode, other addresses and settings. Without **Account > Turnstile > Edit** on the token, it says what to add by hand.
5. It ends with the address. When `https://<address>/api/health/ready` shows `"ok":true`, go on. With `APP_BASE_URL`, the Railway address answers first, while DNS spreads and Railway issues the certificate.

`--yes` skips the questions and the waits, so use it only to finish a run whose waits are already behind you. `--verbose` also shows each API call as it happens.

## Optional: a private Railway template

Instead of making the Railway services one by one, `up` can make them from a private template of your own in one call. You make the template once, from a clean project that holds only the layout:

```sh
node devops/bootstrap.mjs template .env.bootstrap-realinfobot-test
```

1. It makes a Railway project named `TEMPLATE_PROJECT` (default `lobbystack-template`) in `RAILWAY_WORKSPACE_ID`, with the same Railway steps as `up`: the five services, both volumes, the bucket, the settings and migrate's pre-deploy command. It never touches the project named in `NAME`.
2. It gives migrate, admin and worker `TEMPLATE_REPO` (or `REPO`) as their source, because Railway makes a template only of services that have one (an image or a repository). It sets the source as a setting, which doesn't start a build. The first real run showed that Railway also wants each one linked to a repository and branch, so if Railway still refuses the template, the script links them to that repository's `BRANCH` (a deployment trigger, which shouldn't build either) and asks again. Linking needs Railway's GitHub app to reach the repository; if it can't, the script stops and says so. If that isn't enough, it connects them, which starts builds there that fail without the secrets; that's expected in this project.
3. It sets only the variables that are the same in every deployment: references between services such as `${{Postgres.LOBBYSTACK_APP_PASSWORD}}`, ports and file paths. No key, password, address, brand, sender or Polar value goes in.
4. It asks Railway to make a template of that project (`templateGenerate`), saves what Railway put in it to `.env.bootstrap-<name>.template.json`, and lists it: each service's source and variables, and whether it holds the volumes, the bucket, the pre-deploy command and start commands.
5. It prints `RAILWAY_TEMPLATE=<code>`. Put that line in each settings file that should use the template.

With `RAILWAY_TEMPLATE` set, `up` deploys the template into the new project right after making it (`templateDeployV2`), then carries on as before. Railway keeps only references in a template and drops plain values such as `PORT`, so `up` fills those in from this deployment's own variables first. It leaves out the repository the template names, so migrate, admin and worker wait for the connect steps at the end (migrate first, once the secrets are set), just as without a template, and one template serves any fork. Railway's deploy fails without a source (seen on the first real `up` from a template), and then they get `REPO@BRANCH` and start building at once; those first builds fail until the secrets are set, and the connect steps deploy them again. Every later step finds what the template made by name and adds anything it left out, so a template that misses the bucket or the pre-deploy command still ends in a full setup. If the project already has any of the five services, the template isn't deployed again.

Good to know:

- The template project's Postgres and Redis start without passwords and stop after a few retries. That's expected: nothing in it is meant to run, and the repository services have no source, so they never build. Leave the project in place while you use the template, or delete it once the template exists.
- Making the template links the template project's code services to `TEMPLATE_REPO`'s branch, so each push there builds them in that project, and those builds fail. Once you have the code, disconnect the three services there (each service's **Settings**, **Disconnect**) or delete the project.
- Only your workspace lists the template, but anyone who has its code can read it. That's why it holds no secrets. Don't publish it.
- When the layout changes (a new service, setting or shared variable), delete `.env.bootstrap-<name>.template.state.json` and run `template` again. It finds the template project and its services by name, brings them up to date, and makes a new template: put its code in `RAILWAY_TEMPLATE`.

## 5. Connect the providers

```sh
node devops/bootstrap.mjs connect .env.bootstrap-realinfobot-test
```

It checks that the admin is ready and shows the right brand. It then tells you how to create OpenAI's incoming-call webhook and asks for its `whsec_` secret, unless `OPENAI_WEBHOOK_SECRET` is in the secrets file. Next it runs `pnpm platform-key:create`, which leaves the key in `.platform-keys/`: move the key to the password manager, then delete that file. Finally it sets both values on the admin, which redeploys it. It ends by printing the last steps, which need you:

1. Sign up at `https://<address>/en/signup` with `OPERATOR_EMAIL`, using the 6-digit code from the email.
2. `pnpm lobbystack login --url https://<address> --key-stdin --profile <name>`, then paste the platform key.
3. In cloud mode, `pnpm billing plan` and `pnpm billing apply` with that profile and a Polar setup token (guide 12.4).
4. `pnpm smoke:production`, then a test call (guide 13).

## Running it again is safe

Run `up` or `connect` as often as you like: every step can run again without making anything twice.

- **Finished steps are skipped.** Each one is recorded in `.env.bootstrap-<name>.state.json` as soon as it succeeds, and shows `=` next time. If a run stops, fix what it names and run the same command again.
- **What exists is found, not made again,** even if the state file is lost or you made it by hand: the Railway project (by name), its services, volumes, bucket, address and custom domain; the OpenAI project; the Twilio subaccount, trunk and toll-free number (by name, so a second number is never bought); the Resend domain; the DNS records; and the Turnstile widget.
- **What's found is updated to match the guide.** The trunk's settings and its origination URI to the OpenAI project are set again, the Turnstile widget gets any missing address, and an outdated DKIM, SPF or Railway check record is updated rather than doubled. Changing where an existing CNAME points asks you first.
- **Values are never made twice by mistake.** The 13 platform secrets come from the state file, then the secrets file, then the values already on Railway, and only then are new ones made, so a lost state file can't change the database's passwords. OpenAI and Resend show a key only once: if an earlier run made one, the script takes it back from Railway; if it never got there, the script asks before replacing it. `connect` reuses the webhook secret already on the admin, and keeps the admin's other platform keys, adding the operator key only if there isn't one.
- **Variables are upserted:** each run sets the values it knows and leaves other variables alone.
- **A Railway project with the same name is used, not duplicated.** So pick a `NAME` no other project has, unless you mean to finish that project, such as one you started by hand: `up` then sets its services and variables as the guide wants them.

To make a finished step run again, for example after changing something by hand:

```sh
node devops/bootstrap.mjs status .env.bootstrap-realinfobot-test      # lists the steps
node devops/bootstrap.mjs redo .env.bootstrap-realinfobot-test twilio.trunk
node devops/bootstrap.mjs up .env.bootstrap-realinfobot-test
```

`redo` takes several names, or a group such as `twilio.*`. Steps named `connect.*` run again with `connect`.

To move an environment to a new Railway project, for example after deleting its project in Railway to rebuild it from a template, redo the Railway part and keep the rest (the OpenAI project, Twilio, Resend, Polar and the 13 secrets):

```sh
node devops/bootstrap.mjs redo .env.bootstrap-realinfobot-test "railway.*" turnstile variables "deploy.*" "connect.*"
node devops/bootstrap.mjs up .env.bootstrap-realinfobot-test
```

Redoing `railway.project` also forgets the old project's IDs and address, and runs the steps after the deploy (`post.*`) again. A project you deleted stays listed in Railway for a few days, but the script never reuses one that's being deleted. `railway.*` includes the custom domain step; add `twilio.tollfree` to the list if you use the toll-free number's texting address.

To give an environment another `APP_BASE_URL`, change it in the settings file, then:

```sh
node devops/bootstrap.mjs redo .env.bootstrap-realinfobot-test railway.domain railway.custom "post.*"
node devops/bootstrap.mjs up .env.bootstrap-realinfobot-test
```

`up` adds the new domain and its CNAME, sets the admin's and the worker's addresses and redeploys them, and adds the new address to the Turnstile widget. The old custom domain stays on the admin, and its CNAME in Cloudflare: remove them by hand once you no longer want them. OpenAI's incoming-call webhook still points at the old address, so change it in OpenAI's dashboard. Each new Railway project also leaves its old Railway address on the Turnstile widget; Cloudflare caps how many a widget lists, so remove old ones there now and then.

## When something goes wrong

When a step fails, the script stops, names the step, and lists **What to try** for that failure: for example, which token was refused and what kind it must be, a network or proxy problem, a provider's status page, or a workaround for that step. Finished steps stay recorded, so fix the problem and run the same command again.

Each run of `up`, `connect`, `doctor` or `redo` is also written to `.env.bootstrap-<name>.log` (`status` only reads, so it writes nothing): everything the script printed, with the time, plus each API call (service, method, path, answer and time taken). Headers and bodies are never written, and known secrets and anything shaped like a provider key show as `‹hidden›`, so the log can be shared when asking for help. Read it, or run again with `--verbose` to see the calls as they happen.

| You see | Do this |
| --- | --- |
| `You must specify a workspaceId to create a project`, or `RAILWAY_WORKSPACE_ID is empty` | Put the workspace's ID in `RAILWAY_WORKSPACE_ID` (the error lists the ones your token reaches, and so does `doctor`), then run `up` again. It carries on at `railway.project` |
| `didn't accept RAILWAY_API_TOKEN` (or another token) | Run `doctor`. Copy the token again in full. Railway needs an account or workspace token, not a project token; OpenAI an admin key; Resend a Full access key; Twilio the main account's Auth Token |
| `isn't allowed to do this` | The token works but lacks a permission: Cloudflare needs **DNS Edit** on the zone and **Turnstile Edit** on the account; Twilio must be upgraded from trial |
| `can't see a zone named ...` | Check that `CLOUDFLARE_ZONE` is the domain name, such as `realinfobot.com`, and not the Zone ID. If it is, edit the token in Cloudflare (My Profile, API Tokens) so its Zone Resources include that zone |
| `couldn't be reached` | Check the internet connection, VPN or firewall. Behind a proxy, set `HTTPS_PROXY` and `NODE_USE_ENV_PROXY=1` |
| `Railway has 2 projects named ...` | Delete or rename the extra project in Railway, then run again |
| `already has a volume, mounted at ...` | Change that volume's mount path in Railway to the one named, then run again |
| `This service already has a volume attached`, or spare volumes such as `postgres-volume-xxxx` attached to nothing | An older script made volumes while Railway was still applying the template's own. Delete the spare ones in the canvas; the services keep the template's |
| `ServiceInstance not found` after a template deploy | Railway hadn't finished applying the template. Run `up` again; the current script waits for it |
| `migrate's deployment ended failed` | Open migrate's deployment logs in Railway; guide 10.3 lists the usual causes. Fix it, then run `up` again, which connects and waits again |
| migrate's log ends `Connection terminated due to connection timeout`, and Postgres's log says `data directory lock file is invalid` | Two Postgres deployments overlapped on the volume (an older script let the template start Postgres without its password). Redeploy Postgres in Railway, check it stays up for a couple of minutes, then run `up` again |
| Sign-up or sign-in fails its Turnstile check | The widget doesn't list the address you're on. `post.turnstile` adds the deployment's addresses; if it couldn't (next row), add them in Cloudflare, Turnstile, the widget, Hostname management |
| `Cloudflare didn't let the script read or change the widget` | The Cloudflare token lacks **Account > Turnstile > Edit**, or the widget is in another account than `CLOUDFLARE_ACCOUNT_ID`. Add the addresses it lists by hand, or give the token that permission and run `redo post.turnstile`, then `up` |
| `<name> has A ... now. Replace it with a CNAME to ...?` | `APP_BASE_URL`'s name already has an address record in Cloudflare. Type `yes` to replace it with Railway's CNAME (`--yes` replaces it without asking), or choose another `APP_BASE_URL` |
| `Railway: not verified yet` after `post.dns` | DNS hasn't spread yet. Keep the CNAME **DNS only** (grey cloud) in Cloudflare: Railway checks again by itself and issues the certificate, usually within minutes, and the Railway address works meanwhile |
| `APP_BASE_URL must be in CLOUDFLARE_ZONE` | The script writes the CNAME only in that zone. Use an address inside it, or empty `CLOUDFLARE_ZONE` and add the records Railway shows by hand |
| `has 2 origination URIs` | In Twilio, keep only the one to `sip:<project>@sip.api.openai.com;transport=tls`, then run again |
| Stopped at `resend.key` | Make a Sending access key for the domain at resend.com/api-keys, put it as `SMTP_PASSWORD` in the secrets file, and run again |
| Stopped at `railway.domain` | Railway may not give an address before the admin's first deploy: run `up` again after it has deployed once |
| Stopped at `connect.health` | The admin isn't ready yet. Check its deployment logs in Railway, then run `connect` again |
| `Service admin does not have a source that can be used to generate a template` | The script predates the steps that link the code services to the repository: pull the latest script and run `template` again. It carries on from the steps already done |
| `Railway's GitHub access can't reach <repo>` | Railway links a service only to a repository its GitHub app reaches for someone in your workspace. Add the repository to Railway's GitHub app (GitHub: Settings, Applications, Railway, Configure), or set `TEMPLATE_REPO` to one it reaches, such as your own fork, then run `template` again |
| `no valid value given` | The script needed a value and got none: put it in the secrets file, or run in a terminal where you can type |

Ctrl+C stops at once; the finished steps stay recorded.

## Files it writes, and secrets

| File | Holds |
| --- | --- |
| `.env.bootstrap-<name>` | Your settings. Nothing secret |
| `.env.bootstrap-<name>.secrets` | Your keys, as you typed them in. `init` writes it, and the script only reads it |
| `.env.bootstrap-<name>.state.json` | Every step's result: the 13 generated secrets, the provider keys it made or was given, and the IDs |
| `.env.bootstrap-<name>.vars` | Every service's variables in guide Appendix A's format, so `node devops/railway-vars.mjs` can set them again |
| `.env.bootstrap-<name>.log` | What each run printed and each API call it made, with secrets hidden |
| `.env.bootstrap-<name>.template.state.json`, `.template.json` | Only after `template`: its own progress, and what Railway put in the template. Nothing secret |

Git ignores all of them. The secrets, state and variable files hold secrets. Once the environment works, delete the tokens from the secrets file, or the whole file once its keys are in the password manager. For the state and variable files: copy them into the password manager entry for the environment, keep a second copy of `ENCRYPTION_KEY` and `OTP_HASH_SECRET` (guide decision 10), and never commit or send these files. The script never prints a secret. Production gets its own settings file and new secrets; never copy test's.

## What isn't confirmed

- **Nothing has run against the real services yet.** The requests follow each provider's documentation as read on 1 November 2026. Every Railway query and mutation was checked against the GraphQL schema the Railway CLI ships (its `master` branch on 1 November 2026), including `preDeployCommand` as a list of strings and the custom domain's DNS records. The first real run settles what a schema can't show:
  - Whether Railway can generate the admin's address before its first deploy (guide Appendix D). If it refuses, the run stops at that step: run `up` again after the first deploy.
  - The custom domain's records: the script makes the CNAME and the `railway-verify` TXT record from what Railway's API returns, the way the Railway CLI prints them.
- Resend's documentation doesn't name the field that limits a key to one domain. The script sends `domain_id`; if Resend refuses it, the run stops at that step with the workaround.
- The lookups that make reruns safe (OpenAI's service accounts, Resend's key list, Cloudflare's Turnstile widgets, Twilio's numbers by name) follow each provider's documentation and were tested only against stand-ins, including a full second run with the state file deleted, which made nothing new and kept every value.
- The template: the first real one (2 November 2026, from `devresponse/lobbystack`) kept the five services, both volumes, the bucket (without its region), the pre-deploy command, start commands, health check paths, restart policies and every `${{...}}` reference. Railway needs each code service linked to the repository (a deployment trigger) to make it. It dropped every plain value, such as `PORT` and `NODE_ENV`, while still marking them required, and it kept no Dockerfile paths or health check timeouts. `up` fills the plain values in from this deployment's own variables before it deploys the template, and its settings steps set the rest. The first real `up` from it showed that Railway accepts a deploy of the code services without their source, then fails it, so the script deploys again with `REPO` as their source. The first whole `up` from a template (realinfobot-test1, 2 November 2026) ended healthy and showed three more things the script now handles: Railway reports the template deploy finished a few seconds before the project shows its volumes and service instances, so `up` waits for them (the run had stopped at the address step with `ServiceInstance not found`, and the volume steps had made two spare, unattached volumes); the template deploys Postgres and Redis before their passwords are set, so `deploy.databases` deploys them again through the API; and variables set with deploys skipped were applied at once, with no **Deploy** banner. The second whole run (same day) showed that the template's Postgres, started without a password, kept restarting, and one restart overlapped the next deployment on the same volume and shut it down (migrate then timed out). So with a template, `up` settles the 13 secrets first and puts the Postgres and Redis passwords into the template deploy, and `deploy.databases` removes a deployment that isn't running before it deploys again. The new waits and deploys were tested only against stand-ins.
- `fullName` turns Resend's record names into host names in the zone. Check the records in Cloudflare after the first run.
