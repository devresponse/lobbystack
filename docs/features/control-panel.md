# See every business and account in the control panel

The control panel is a small read-only website for a deployment's operator. It shows every business and every account on the deployment, what each business did month by month, what billing counted and took, what serving the businesses cost, and how the deployment's services are doing. It runs as a Railway service of its own, `control`, with no public address of its own: a Cloudflare Tunnel carries the panel's address to it, Cloudflare Access signs the operator in before any request gets through, and the panel checks Access's sign-in again itself. It reads the database as `lobbystack_control`, a role that may read the columns it shows and nothing else. Since fork PR #215 on `develop/r2`, `devops/bootstrap.mjs` sets it up when the settings file says `CONTROL=yes`, which `init` writes for every new deployment. This page covers what it shows, the System health page, how it's kept private, setting it up with the script or by hand, running it on your computer, who can open it, changing what it shows, and its limits. Checked against the code of fork PR #215, and the System health page against fork PR #216's.

**It changes nothing.** Version 1 only reads: no button in it writes anything, and its database role couldn't if one did. The System health page also asks the admin two read-only questions over Railway's private network. Changing a business still happens in the admin, as its team, or in the database.

## Know what it shows

The panel has eight pages, in English, with a menu along the top. Months and dates are UTC, and "this month" means the current UTC month so far.

| Page | Address | What's on it |
| --- | --- | --- |
| Overview | `/` | Counts of businesses (active, new in 30 days), accounts (seen in 30 days, new), calls and call minutes this month with the change from the same days last month, active subscriptions, phone numbers and receptionists; the System health page's verdict, with a link to it; call minutes for each of the last 12 months as a chart and a table, with new businesses, new accounts, calls, texts, website chats and bookings; the newest accounts |
| Businesses | `/businesses` | Every business, newest first, 50 a page: its owner, status, plan, team, numbers, calls and minutes this month, last call and when it was made. Search by name, address slug, ID, or a team member's name, email or phone number, and filter by status |
| A business | `/businesses/<id>` | Its details (legal name, type, mode, website, time zone, language, setup step, where it came from, its public page, public email and address, and when it was canceled); its billing (plan, subscription, provider, this period, overage cap, end dates, the next plan, the provider's customer and subscription IDs); its team with each person's email, phone, role and when they were last seen, and its open invitations; its phone numbers and receptionists; 12 months of activity beside what billing counted, what was stopped and what it cost to serve; its 25 newest calls; its payments and prepaid packs |
| Accounts | `/accounts` | Everyone who can sign in, newest first, 50 a page: email, phone, the businesses they own and belong to, how they sign in, when they were last seen and when they signed up. Search by name, email, phone number or ID |
| An account | `/accounts/<id>` | The account's name, email and phone and whether each is verified, its platform role, language and the partner that made it if any; how it signs in (a password, Google and so on), its sign-ins still on file, the first and the latest, and when it was last seen; every business it belongs to, with its role there |
| Usage | `/usage?month=YYYY-MM` | One month of the last 12: the deployment's calls, call minutes, texts, website chats and bookings, then the 100 busiest businesses with what each did beside what billing counted (billed voice minutes, alert texts, transfers, chat units, overage) and what it stopped |
| Billing | `/billing` | Active subscriptions, businesses that never subscribed, what was taken this month less refunds, the cost to serve this month, overage, and the plans ending in the next 30 days; what was taken each month (a chart when every payment is in one currency), the businesses on each plan, the cost to serve each month, the 50 newest payments and the 20 newest prepaid packs |
| System health | `/system` | A verdict on the deployment, All good, Needs a look or Problem, with what to look at; every copy of the admin and the worker with its state, release, last heartbeat, how busy it was, its memory and database connections, and a worker's calls and jobs; each queue's jobs; whether the admin reaches the database, the file storage and Redis; PostgreSQL's size, connections, cache and restarts; the last 24 hours' calls, texts and website chats with the ones that failed or got stuck; the copies that died in the last 24 hours ([watch the system's health](#watch-the-systems-health)) |

- **Where the numbers come from.** Calls, texts, chats and bookings are counted from the calls, messages, conversations and appointments tables. A call's minutes are the phone provider's duration, else the time from its start to its end. "Billed" columns are billing's own meters (`billing_usage_months`). Payments are what Polar or Stripe reported (`billing_transactions`). The cost to serve is the worker's hourly estimate in US dollars (`unit_economics_rollups`), so the current month fills in as the day goes on.
- **What it never shows,** because its role can't read it: what callers and visitors said (message bodies, transcripts, recordings, summaries, AI traces), callers' and contacts' phone numbers, knowledge, password hashes, sign-in and provider tokens, and the IP address and browser of a sign-in. It shows the email and phone number of every account, which is what it is for, so treat it as a list of personal data.
- **Each page reads the database afresh** when it opens. Nothing is kept between requests, so a refresh shows the latest numbers.

## Read the System health page

The System health page, `/system`, puts what the deployment's services say about themselves on one page, under a verdict. Since fork PR #216 it reads four sources each time it opens, side by side, and shows what it got from each even when another doesn't answer:

| Source | What it gives | How the panel asks |
| --- | --- | --- |
| The admin's fleet status address, `GET /api/internal/fleet` | Every copy of the admin and the worker heard from in the last 10 minutes, from the heartbeat each writes to Redis every 10 seconds: its state, release, region, when it started, its last beat, how busy its one thread was, its memory, its database connections, and a worker's calls and jobs. Then each queue's jobs, the copies that died in the last 24 hours with their last beat, and the address's own problems ([observability](observability.md#watch-every-copy)) | At `CONTROL_ADMIN_URL`, with the admin's `FLEET_STATUS_TOKEN` as `Authorization: Bearer <token>` |
| The admin's health checks, `/api/health/ready` and `/api/health/live` | Whether the admin reaches the database, the file storage and Redis, and the commit it runs | At the same address, with no token |
| PostgreSQL's own statistics | The database's size, its connections by role beside the most the services may open (`max_connections` less `superuser_reserved_connections`), the share of reads served from memory, rolled back transactions, deadlocks, temporary files, when it started, and its version | As `lobbystack_control`, which may read `pg_stat_database` and the settings. Other roles' connections show it only their role, so it counts them by role |
| The calls, messages and conversations tables | The last 24 hours' calls and failed calls, the calls open now and those open for more than 2 hours, the texts sent and those that failed or weren't delivered, the texts queued or sending for more than 15 minutes, and the website chats started. Calls and texts stuck for more than 7 days aren't counted | As `lobbystack_control`, from columns it already reads |

**The verdict** is All good, Needs a look when there's a warning, or Problem when there's anything critical, with a line for each thing to look at, the critical ones first. The Overview shows the same verdict in a tile, and waits at most 2 seconds for the admin where the System health page waits 5.

| Line | Severity | When |
| --- | --- | --- |
| The panel can't read the database | Critical | The panel's own connection fails |
| The admin didn't answer, can't reach the database, the file storage or Redis, or says it isn't ready | Critical | From its ready check |
| The fleet status address's own problems | Critical | A copy went silent, a worker isn't ready, or no copy of a service runs ([observability](observability.md#ask-the-status-address)) |
| The fleet status address didn't answer | Critical | Only when the admin's ready check did answer; otherwise the admin's line says it |
| The fleet status address isn't set up, is off, or refused the token | Warning | `CONTROL_ADMIN_URL` or `FLEET_STATUS_TOKEN` is missing on the panel, the admin has no `FLEET_STATUS_TOKEN`, or the panel's isn't the admin's |
| A copy was busy 85% of the time or more since its last beat | Warning | It may be falling behind |
| A copy has queries waiting for a database connection | Warning | All of its connections are in use |
| A queue has 100 jobs or more waiting | Warning | |
| A copy died in the last 24 hours | Warning | It stopped beating without shutting down: a crash, a kill or running out of memory |
| The services hold 80% or more of the connections they may open | Warning | |
| PostgreSQL started less than an hour ago | Warning | It restarted |
| 20% or more of the last 24 hours' calls failed, or of their texts failed or weren't delivered | Warning | Once there are 10 or more |
| A call has been open for more than 2 hours, or a text has waited more than 15 minutes to go out | Warning | At once |

The limits are `LIMITS` in `apps/control/src/lib/health.ts`: starting points, not measured on a real deployment.

- **The panel sees the worker through the admin.** The worker has no address the panel could ask, so its copies, its calls and the queues come from the heartbeats the admin's fleet status address reads from Redis. When the admin doesn't answer, the page says so, and still shows PostgreSQL's numbers and the last 24 hours.
- **It expects one copy of each service.** The panel doesn't know how many copies Railway runs, so it asks the address without `admin` and `worker`, and the address counts a missing copy as a problem only when no copy of a service runs. A second copy that stops shows as silent, then as one that died. `devops/scale.mjs`, which reads Railway's numbers, and an uptime check with `?admin=2&worker=2` check the exact number.
- **The token stays on the server.** The page is drawn on the server, so `FLEET_STATUS_TOKEN` never reaches the browser. The panel sends it only to `CONTROL_ADMIN_URL`, never follows a redirect, and says why an answer failed, such as "the connection was refused" or "no answer within 5 seconds", without the token.
- **The queues are as the worker last counted them,** about every 10 seconds, and the page says how long ago. "Failed kept" is the failed jobs a queue keeps, not the last day's failures.
- **There's no history.** Each opening reads afresh; the numbers over time are in the metrics ([observability](observability.md#chart-the-copies-load)).

**Where the panel finds the admin.** The bootstrap script gives the control service `CONTROL_ADMIN_URL=http://${{admin.RAILWAY_PRIVATE_DOMAIN}}:3000`, the admin's address on Railway's private network, and `FLEET_STATUS_TOKEN=${{admin.FLEET_STATUS_TOKEN}}`, which Railway fills in with the admin's own token when the control service deploys. A panel set up before these two variables existed gets them at the next `up`, which then deploys it again. When the admin's token changes, `up` deploys the panel again too; after a change by hand, deploy `control` yourself. The page explains what's missing when one of them is.

## Know how it's kept private

Six things stand between a stranger and the data, and each holds without the others:

1. **No address of its own.** The `control` service has no Railway domain. Only `cloudflared`, a second service in the same project, reaches it, at `http://control.railway.internal:3000` on Railway's private network. The panel listens on IPv6 as well as IPv4 (`HOSTNAME=::`), since that network is IPv6.
2. **Cloudflare Access in front.** The panel's address points at the tunnel, and an Access application covers it: Cloudflare asks for a sign-in, by default a one-time code sent to the email, and lets only the emails in its policy through, for 24 hours at a time as the script sets it up.
3. **The panel checks Access's sign-in itself.** Every request but the health check needs Access's token, the `Cf-Access-Jwt-Assertion` header: signed with RS256 by one of the team's keys (fetched from `https://<team domain>/cdn-cgi/access/certs` and kept for an hour), for the application's audience tag, from the team's domain, not expired, and for an email in `CONTROL_ADMIN_EMAILS`. A request without one, such as from another service on Railway's private network, gets `403 Forbidden`. Each page checks again before it reads anything.
4. **Closed until it's set up.** Until `CONTROL_ACCESS_TEAM_DOMAIN`, `CONTROL_ACCESS_AUD` and `CONTROL_ADMIN_EMAILS` all hold something valid, every request but the health check gets `503` and "The control panel isn't set up yet.", so a missing variable shuts the panel rather than opening it.
5. **A role that can only read.** `lobbystack_control` (migration 0153) has `SELECT` on the columns the panel shows and `USAGE` on schema `public`, nothing else: no write on any table, no other schema, so none of the `SECURITY DEFINER` functions can run as it. Its sessions start read-only, a statement stops after 15 seconds, a lock wait after 2, an idle transaction after 60, and it holds at most 6 connections. Before its first query the panel checks that it signed in as that role, with no superuser, `BYPASSRLS`, `CREATEROLE`, `CREATEDB` or `REPLICATION`, and read-only, and shows nothing otherwise. `db verify-rls` checks the grants on every deploy, and with `VERIFY_RLS_BEHAVIOR=true` that the role reads every business and is refused a write.
6. **Nothing kept, framed or indexed.** Every answer says `Cache-Control: private, no-store` (the build's files under `/_next/static/` excepted), `X-Robots-Tag: noindex, nofollow`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, and a Content-Security-Policy that loads nothing from another site and lets no page frame it.

`/api/health/live` is the one address that answers without Access, for Railway's health check: `{ "ok": true, "service": "control", "version": "<commit>" }`, and nothing from the database.

## Set it up with the bootstrap script

1. **Set up Cloudflare Zero Trust once for the account,** if it isn't already: in Cloudflare's dashboard open **Zero Trust**, pick a team name, which becomes `<team name>.cloudflareaccess.com`, and the **Free** plan, which covers up to 50 people. The script can't do this part, and stops to ask for it, leaving the rest of `up` to carry on.
2. **Give `CLOUDFLARE_API_TOKEN` three more permissions** on the account: **Cloudflare Tunnel > Edit**, **Access: Apps and Policies > Edit**, and **Access: Organizations, Identity Providers, and Groups > Read** ([devops/bootstrap.md](../../devops/bootstrap.md#the-control-panel)).
3. **Fill in the five lines the panel needs in the settings file,** `.env.bootstrap-<name>`, in the root folder of your copy of the repository: `CONTROL=yes`, and `CLOUDFLARE_ZONE` and `CLOUDFLARE_ACCOUNT_ID` filled in. `CONTROL_HOST`, the panel's address, and `CONTROL_ADMIN_EMAILS`, who may open it, can stay empty, and the script then picks them. [Fill in the settings file](#fill-in-the-settings-file), below, says what goes in each line and what the script picks.
4. **Run `node devops/bootstrap.mjs up .env.bootstrap-<name>`** from that folder, with the repository brought up to date first: a `bootstrap.mjs` from before fork PR #215 warns that it doesn't read `CONTROL` and sets up no panel. It adds the `control` and `cloudflared` services, the panel's database password, the tunnel and its route to the panel, the address's DNS record and the Access application with its policy, then sets the variables, the admin's private address and fleet token for the System health page among them, and deploys both services. The panel answers once its build is done, several minutes later, and `up` prints its address.
5. **Open the address** and sign in with the one-time code Cloudflare emails you.

- **A settings file without a `CONTROL` line counts as no,** so a deployment set up before the panel existed gets one only when its file says `CONTROL=yes` and `up` runs again. The branch it builds must have `Dockerfile.control`: `up` checks with `gh` and stops before making anything if it hasn't.
- **Turning it off later** with `CONTROL=no` deletes nothing: `up` and `status` say the panel still runs, and what to delete in Railway and Cloudflare to remove it.

### Fill in the settings file

**Where the file is.** `node devops/bootstrap.mjs init <name>` wrote the settings file, `.env.bootstrap-<name>`, into the folder it ran from: the root folder of your copy of the repository, the one that holds `package.json` and the `devops` folder, where every bootstrap command runs. Beside it are `.env.bootstrap-<name>.secrets`, with the providers' keys, and the files `up` keeps, `.env.bootstrap-<name>.state.json` and `.env.bootstrap-<name>.log`. Git ignores all of them, so they're only on the computer that ran `init`, never on GitHub: to run the script on another computer, copy all of them into the root of the repository there. The file is plain text; open it in any text editor.

**The panel's lines** are below the Cloudflare lines, under the comment that starts `# The control panel`. One must say yes, two must be filled in, and two can stay empty:

| Line | What goes there | Where to find it | If it's empty |
| --- | --- | --- | --- |
| `CONTROL` | `yes` | `init` writes `yes`. A file written before the panel existed has no line, which counts as `no`. | No panel |
| `CLOUDFLARE_ZONE` | The domain name of the Cloudflare zone the deployment's addresses are in, such as `example.com` | The domain's name in Cloudflare's list of domains. Not the 32-character Zone ID shown beside it. | The script stops before it does anything, and says the panel needs it |
| `CLOUDFLARE_ACCOUNT_ID` | The 32-character Account ID | The zone's **Overview** page in Cloudflare, right-hand column, under **API** | The script stops before it does anything, and says the panel needs it |
| `CONTROL_HOST` | The panel's own address, such as `control.example.com` | Your choice, one level under the zone | The script picks the address, as the next table shows |
| `CONTROL_ADMIN_EMAILS` | The emails of the people who may open the panel, separated by commas | Your choice | Only `OPERATOR_EMAIL` may open it |

A deployment whose DNS records the script writes has `CLOUDFLARE_ZONE` filled in already, and one whose Turnstile widget it makes has `CLOUDFLARE_ACCOUNT_ID`: the panel uses the same two lines.

**The address the script picks** when `CONTROL_HOST` is empty depends on `ENVIRONMENT` and `APP_BASE_URL`, with `CLOUDFLARE_ZONE=example.com`:

| The settings file says | The panel's address |
| --- | --- |
| `ENVIRONMENT=production` | `control.example.com` |
| `ENVIRONMENT=test` and `APP_BASE_URL=test1.example.com` | `control-test1.example.com` |
| `ENVIRONMENT=test` and `APP_BASE_URL=app.test1.example.com` | `control-app-test1.example.com`: the dots before the zone become dashes |
| `ENVIRONMENT=test`, with `APP_BASE_URL` empty or the zone itself, and `NAME=acme-test` | `control-acme-test.example.com` |

So production's panel is at `control.<zone>`, and a test deployment's sits beside its dashboard, with `control-` in front of the dashboard's address, so test deployments in the same zone each get their own. The address the script picks always stays one level under the zone, `control-dev2` rather than `control.dev2`, because Cloudflare's free certificate covers `*.example.com` but not `*.dev2.example.com`. An address of your own in `CONTROL_HOST` must be under `CLOUDFLARE_ZONE` and differ from the dashboard's, and the script warns when it's more than one level down.

**Who may open it.** With `CONTROL_ADMIN_EMAILS` empty, only `OPERATOR_EMAIL` may: the operator's email, which the settings file has already. To let more people in, list everyone, the operator too if they should keep access, such as `CONTROL_ADMIN_EMAILS=ops@example.com, finance@example.com`. Capital letters don't matter. Each person signs in with a one-time code that Cloudflare emails to their address, so each address must be an inbox that person reads; nobody needs a Cloudflare account. Cloudflare Access lets only these emails through, and the panel checks the email against the same list again, so anyone else can't get past Cloudflare's sign-in page.

**An example: DEV2,** a test deployment of the RealInfoBot brand whose dashboard is at `dev2.realinfobot.com`. Its settings file is `.env.bootstrap-realinfobot-dev2`, in the root folder of the copy of the repository it was made from. These are the lines that decide its panel, wherever they are in the file; the rest of the file stays as it is:

```sh
NAME=dev2-realinfobot-com
ENVIRONMENT=test
APP_BASE_URL=dev2.realinfobot.com
OPERATOR_EMAIL=support@realinfobot.com
CLOUDFLARE_ZONE=realinfobot.com
CLOUDFLARE_ACCOUNT_ID=<the zone's 32-character Account ID>
CONTROL=yes
CONTROL_HOST=control-dev2.realinfobot.com
CONTROL_ADMIN_EMAILS=
```

With them, `node devops/bootstrap.mjs up .env.bootstrap-realinfobot-dev2` sets the panel up at `https://control-dev2.realinfobot.com`, the address `CONTROL_HOST` names. Left empty, `CONTROL_HOST` would give the same address: with `ENVIRONMENT=test`, the script takes the dashboard's address without the zone, `dev2`, puts `control-` in front of it, and adds the zone, `realinfobot.com`. With `CONTROL_ADMIN_EMAILS` empty, only `support@realinfobot.com`, the `OPERATOR_EMAIL`, can open the panel. To open it from your own inbox as well, list both: `CONTROL_ADMIN_EMAILS=support@realinfobot.com, you@example.com`. `node devops/bootstrap.mjs status .env.bootstrap-realinfobot-dev2` shows the address before `up` makes anything.

**Changing them later:** a new `CONTROL_ADMIN_EMAILS` takes effect at the next `up`, which updates both Cloudflare Access and the panel's own list. The address is fixed once `up` has made the tunnel: to move the panel, set `CONTROL_HOST`, then run `node devops/bootstrap.mjs redo .env.bootstrap-<name> control.tunnel` and `up`, and delete the old address's DNS record in Cloudflare yourself ([devops/bootstrap.md](../../devops/bootstrap.md#the-control-panel)).

## Set it up by hand

For a deployment the script didn't make, on Railway. The dashboard labels below come from Cloudflare's and Railway's documentation and haven't been checked on a real setup.

1. **Give the role a login.** Pick a password of 32 or more letters and digits, set it on the `migrate` service as `LOBBYSTACK_CONTROL_PASSWORD`, and deploy `migrate`: `db bootstrap` gives `lobbystack_control` a login with it. The deploy must include migration 0153.
2. **Add the panel's service,** named `control`, from the repository and branch the admin builds, with these variables, and no public domain (**Settings > Networking** stays empty):

   | Variable | Value |
   | --- | --- |
   | `RAILWAY_DOCKERFILE_PATH` | `Dockerfile.control` |
   | `DATABASE_URL` | `postgresql://lobbystack_control:<the password>@${{Postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/lobbystack` |
   | `NODE_ENV`, `PORT`, `HOSTNAME` | `production`, `3000`, `::` |
   | `CONTROL_ADMIN_EMAILS` | The emails that may open it, separated by commas |
   | `CONTROL_ACCESS_TEAM_DOMAIN`, `CONTROL_ACCESS_AUD` | From step 4 |
   | `CONTROL_ADMIN_URL` | `http://${{admin.RAILWAY_PRIVATE_DOMAIN}}:3000`, the admin's address on the private network, for the System health page |
   | `FLEET_STATUS_TOKEN` | `${{admin.FLEET_STATUS_TOKEN}}`, the admin's own token. Give the admin one of 32 characters or more first ([guide 7.10](../deployment/guide/part-7-operations.md#710-health-checks-and-uptime-monitoring)); without it the page lists no copies |

   Set its health check path to `/api/health/live`.
3. **Make the tunnel:** in Zero Trust, **Networks > Tunnels > Create a tunnel**, type **Cloudflared**, named after the deployment. Copy its token, and add a public hostname: the panel's address, service type **HTTP**, URL `control.railway.internal:3000`. Then add a service named `cloudflared` from the Docker image `cloudflare/cloudflared:latest`, with the start command `cloudflared tunnel --no-autoupdate run` and the variable `TUNNEL_TOKEN=<the token>`.
4. **Put Access in front:** in Zero Trust, **Access > Applications > Add an application > Self-hosted**, for the panel's address, with a policy that allows the same emails. Copy the application's **Audience (AUD) tag** into `CONTROL_ACCESS_AUD`, and the team domain (`<team name>.cloudflareaccess.com`, under **Settings**) into `CONTROL_ACCESS_TEAM_DOMAIN`. Deploy `control`.
5. **Check it:** the address asks for Cloudflare's sign-in in a private window, and lets you in after it.

## Run it on your computer

1. In `.env` (`pnpm env:generate` writes one), keep `LOBBYSTACK_CONTROL_PASSWORD`, and set `CONTROL_DEV_ADMIN_EMAIL` to your own email.
2. Run `pnpm db:migrate`, then `pnpm --filter @lobbystack/db exec tsx src/cli.ts bootstrap`, which gives `lobbystack_control` its login.
3. Run `pnpm dev:control`, and open `http://localhost:13003` (`CONTROL_PORT`).

The panel builds its connection from `DATABASE_URL` with `lobbystack_control`'s name and `LOBBYSTACK_CONTROL_PASSWORD`, as the admin and the worker build theirs; `LOBBYSTACK_CONTROL_DATABASE_URL` overrides it. `CONTROL_DEV_ADMIN_EMAIL` stands in for Cloudflare Access on your computer only: a production build never reads it. `pnpm dev` doesn't start the panel, and the Docker stack has no service for it.

The System health page asks the admin at `CONTROL_ADMIN_URL`, else at `APP_BASE_URL`, which `.env` already sets to the admin on your computer, `http://localhost:13000`. Run the admin (`pnpm dev`) for it to answer. To list the copies too, set `FLEET_STATUS_TOKEN` in `.env` to 32 characters or more: the admin and the panel both read it there, and the worker writes its heartbeats once `REDIS_URL` is set.

## Decide who can open it

Both lists must hold an email: Access's policy lets the person reach the panel, and `CONTROL_ADMIN_EMAILS` lets the panel answer them. With the script, change `CONTROL_ADMIN_EMAILS` in the settings file and run `up`: it updates the policy and the panel's variable together, and redeploys the panel. By hand, change both.

- **Taking someone off** stops them at the next request, since the panel checks every one, even while Access's 24 hours last.
- **Signing out** is the link at the top right, Access's own `/cdn-cgi/access/logout`.
- **Another way to sign in,** such as Google, is a login method added in Zero Trust under **Settings > Authentication**; the policy still decides which emails get in. `up` says when Zero Trust has no one-time code login, which suits any email.

## Show something more

1. Write the query in `apps/control/src/lib/queries.ts`, as plain SQL with `$1` parameters, and the page in `apps/control/app/`.
2. Grant `lobbystack_control` `SELECT` on each new column in a new migration, listing the columns, as 0153 does, with a `<table>_control_select` policy for a new table, and add the columns to `CONTROL_READABLE_COLUMNS` in `packages/db/src/control-role.ts`, which `db verify-rls` compares the database with on every deploy. Don't grant a table whole: a column added later, such as a token, would come with it.
3. Run `apps/control/src/lib/queries.integration.test.ts` against a local test database (`LOBBYSTACK_RELIABILITY_TEST_DATABASE_URL`): it runs every query as the role, and fails on a column the role can't read. With `LOBBYSTACK_CONTROL_PASSWORD` set as `db bootstrap` used it, it also signs in as the role. CI's database job runs it too.

A write, such as suspending a business, needs a second role and an audit trail, and isn't part of version 1.

## Watch it in the logs

| Line | Written when |
| --- | --- |
| `control: refused <method> <path> (<reason>)` | A warning: a request without a good Access sign-in got 403. The reason is `missing`, `malformed`, `unknown_key`, `bad_signature`, `audience`, `issuer`, `expired`, `not_yet_valid`, `no_email` (a service token) or `not_allowed` (an email not in `CONTROL_ADMIN_EMAILS`) |
| `control: closed until it's set up: <what's wrong>` | An error: a request got 503 because one of the three Access variables is missing or wrong |
| `The control panel won't read the database: …` | An error, while the page says "This page couldn't be shown": the connection signed in as another role, one with a privilege it mustn't have, or one whose sessions don't start read-only (run the migrations). It's checked again on the next request |

## Know the limits

- **Read-only, one deployment, English.** Each deployment has its own panel, which sees only its own database.
- **Not yet run for real.** The panel was tried on a computer against a local database, and `scripts/bootstrap.test.ts` runs the script's steps against stand-ins for Railway's and Cloudflare's APIs. No deployment on Railway behind a real tunnel and Access application has run it yet.
- **Anyone in the Railway project can read its secrets:** the database password on `control` and `migrate`, and the tunnel's token on `cloudflared`. Whoever has the token can run a connector for the tunnel, which is one more reason the panel checks Access's token itself.
- **The System health page hasn't met a real fleet yet.** Its tests feed it the admin's answers as the admin writes them, and `queries.integration.test.ts` reads PostgreSQL's numbers as the role; no panel on Railway has asked a real admin yet ([open items](../project/open-items.md#test-these)).
- **A slow page fails rather than waits.** A statement stops after 15 seconds, so on a very large deployment a page that counts 12 months may show an error until its query is made cheaper.
- **Next.js 16.4.2,** as the admin. The moderate advisories reported for that version are fixed in 16.4.5, and Dependabot raises both apps together.

## Know how it's built

- **`apps/control/`:** a Next.js app whose pages are server components that read the database when they open; the menu and the error page are its only code that runs in the browser. `proxy.ts` checks Access on every request; `src/lib/access.ts` verifies the token; `src/lib/config.ts` reads the settings; `src/lib/db.ts` holds the pool (3 connections, `LOBBYSTACK_CONTROL_POOL_MAX` up to 6) and the role check; `src/lib/queries.ts` every query; `src/lib/format.ts` how numbers, money and dates are written; `src/components/` the tiles, tables and the chart. For the System health page, `src/lib/admin-service.ts` asks the admin and reads its answers warily, `src/lib/health.ts` makes the verdict, and `src/lib/system-health.ts` gathers both with the database's numbers for `app/system/page.tsx` and the Overview.
- **`packages/db/migrations/0153_control_panel_role.sql`:** the role, its settings, its column grants and policies. `packages/db/src/control-role.ts` lists what `db verify-rls` checks, and `db bootstrap` gives the role its login when `LOBBYSTACK_CONTROL_PASSWORD` is set.
- **`Dockerfile.control`:** builds only the panel's own dependencies from the shared lockfile, and runs it as an unprivileged user with a health check. The Runtime images workflow builds it beside the others.
- **`devops/bootstrap.mjs`:** the `control.*` steps, `deploy.control` and `deploy.cloudflared`, and the panel's lines in `status`, `connect` and `doctor`.
