# See every business and account in the control panel

The control panel is a small read-only website for a deployment's operator. It shows every business and every account on the deployment, what each business did month by month, what billing counted and took, and what serving the businesses cost. It runs as a Railway service of its own, `control`, with no public address of its own: a Cloudflare Tunnel carries the panel's address to it, Cloudflare Access signs the operator in before any request gets through, and the panel checks Access's sign-in again itself. It reads the database as `lobbystack_control`, a role that may read the columns it shows and nothing else. Since fork PR #215 on `develop/r2`, `devops/bootstrap.mjs` sets it up when the settings file says `CONTROL=yes`, which `init` writes for every new deployment. This page covers what it shows, how it's kept private, setting it up with the script or by hand, running it on your computer, who can open it, changing what it shows, and its limits. Checked against the code of fork PR #215.

**It changes nothing.** Version 1 only reads: no button in it writes anything, and its database role couldn't if one did. Changing a business still happens in the admin, as its team, or in the database.

## Know what it shows

The panel has seven pages, in English, with a menu along the top. Months and dates are UTC, and "this month" means the current UTC month so far.

| Page | Address | What's on it |
| --- | --- | --- |
| Overview | `/` | Counts of businesses (active, new in 30 days), accounts (seen in 30 days, new), calls and call minutes this month with the change from the same days last month, active subscriptions, phone numbers and receptionists; call minutes for each of the last 12 months as a chart and a table, with new businesses, new accounts, calls, texts, website chats and bookings; the newest accounts |
| Businesses | `/businesses` | Every business, newest first, 50 a page: its owner, status, plan, team, numbers, calls and minutes this month, last call and when it was made. Search by name, address slug, ID, or a team member's name, email or phone number, and filter by status |
| A business | `/businesses/<id>` | Its details (legal name, type, mode, website, time zone, language, setup step, where it came from, its public page, public email and address, and when it was canceled); its billing (plan, subscription, provider, this period, overage cap, end dates, the next plan, the provider's customer and subscription IDs); its team with each person's email, phone, role and when they were last seen, and its open invitations; its phone numbers and receptionists; 12 months of activity beside what billing counted, what was stopped and what it cost to serve; its 25 newest calls; its payments and prepaid packs |
| Accounts | `/accounts` | Everyone who can sign in, newest first, 50 a page: email, phone, the businesses they own and belong to, how they sign in, when they were last seen and when they signed up. Search by name, email, phone number or ID |
| An account | `/accounts/<id>` | The account's name, email and phone and whether each is verified, its platform role, language and the partner that made it if any; how it signs in (a password, Google and so on), its sign-ins still on file, the first and the latest, and when it was last seen; every business it belongs to, with its role there |
| Usage | `/usage?month=YYYY-MM` | One month of the last 12: the deployment's calls, call minutes, texts, website chats and bookings, then the 100 busiest businesses with what each did beside what billing counted (billed voice minutes, alert texts, transfers, chat units, overage) and what it stopped |
| Billing | `/billing` | Active subscriptions, businesses that never subscribed, what was taken this month less refunds, the cost to serve this month, overage, and the plans ending in the next 30 days; what was taken each month (a chart when every payment is in one currency), the businesses on each plan, the cost to serve each month, the 50 newest payments and the 20 newest prepaid packs |

- **Where the numbers come from.** Calls, texts, chats and bookings are counted from the calls, messages, conversations and appointments tables. A call's minutes are the phone provider's duration, else the time from its start to its end. "Billed" columns are billing's own meters (`billing_usage_months`). Payments are what Polar or Stripe reported (`billing_transactions`). The cost to serve is the worker's hourly estimate in US dollars (`unit_economics_rollups`), so the current month fills in as the day goes on.
- **What it never shows,** because its role can't read it: what callers and visitors said (message bodies, transcripts, recordings, summaries, AI traces), callers' and contacts' phone numbers, knowledge, password hashes, sign-in and provider tokens, and the IP address and browser of a sign-in. It shows the email and phone number of every account, which is what it is for, so treat it as a list of personal data.
- **Each page reads the database afresh** when it opens. Nothing is kept between requests, so a refresh shows the latest numbers.

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
3. **Check the settings file:** `CONTROL=yes`, `CLOUDFLARE_ZONE` and `CLOUDFLARE_ACCOUNT_ID` filled in. `CONTROL_HOST` and `CONTROL_ADMIN_EMAILS` can stay empty: the address is then `control.<zone>` in production and `control-<the first part of APP_BASE_URL's address>.<zone>` otherwise, such as `control-test1.example.com` beside `test1.example.com`, and the only person let in is `OPERATOR_EMAIL`.
4. **Run `node devops/bootstrap.mjs up .env.bootstrap-<name>`.** It adds the `control` and `cloudflared` services, the panel's database password, the tunnel and its route to the panel, the address's DNS record and the Access application with its policy, then sets the variables and deploys both services. The panel answers once its build is done, several minutes later, and `up` prints its address.
5. **Open the address** and sign in with the one-time code Cloudflare emails you.

- **The address stays one level under the zone,** because Cloudflare's free certificate covers no deeper: `control.test1.example.com` would be refused by browsers unless the zone has a certificate for it.
- **A settings file without a `CONTROL` line counts as no,** so a deployment set up before the panel existed gets one only when its file says `CONTROL=yes` and `up` runs again. The branch it builds must have `Dockerfile.control`: `up` checks with `gh` and stops before making anything if it hasn't.
- **Turning it off later** with `CONTROL=no` deletes nothing: `up` and `status` say the panel still runs, and what to delete in Railway and Cloudflare to remove it.

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

   Set its health check path to `/api/health/live`.
3. **Make the tunnel:** in Zero Trust, **Networks > Tunnels > Create a tunnel**, type **Cloudflared**, named after the deployment. Copy its token, and add a public hostname: the panel's address, service type **HTTP**, URL `control.railway.internal:3000`. Then add a service named `cloudflared` from the Docker image `cloudflare/cloudflared:latest`, with the start command `cloudflared tunnel --no-autoupdate run` and the variable `TUNNEL_TOKEN=<the token>`.
4. **Put Access in front:** in Zero Trust, **Access > Applications > Add an application > Self-hosted**, for the panel's address, with a policy that allows the same emails. Copy the application's **Audience (AUD) tag** into `CONTROL_ACCESS_AUD`, and the team domain (`<team name>.cloudflareaccess.com`, under **Settings**) into `CONTROL_ACCESS_TEAM_DOMAIN`. Deploy `control`.
5. **Check it:** the address asks for Cloudflare's sign-in in a private window, and lets you in after it.

## Run it on your computer

1. In `.env` (`pnpm env:generate` writes one), keep `LOBBYSTACK_CONTROL_PASSWORD`, and set `CONTROL_DEV_ADMIN_EMAIL` to your own email.
2. Run `pnpm db:migrate`, then `pnpm --filter @lobbystack/db exec tsx src/cli.ts bootstrap`, which gives `lobbystack_control` its login.
3. Run `pnpm dev:control`, and open `http://localhost:13003` (`CONTROL_PORT`).

The panel builds its connection from `DATABASE_URL` with `lobbystack_control`'s name and `LOBBYSTACK_CONTROL_PASSWORD`, as the admin and the worker build theirs; `LOBBYSTACK_CONTROL_DATABASE_URL` overrides it. `CONTROL_DEV_ADMIN_EMAIL` stands in for Cloudflare Access on your computer only: a production build never reads it. `pnpm dev` doesn't start the panel, and the Docker stack has no service for it.

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
- **A slow page fails rather than waits.** A statement stops after 15 seconds, so on a very large deployment a page that counts 12 months may show an error until its query is made cheaper.
- **Next.js 16.4.2,** as the admin. The moderate advisories reported for that version are fixed in 16.4.5, and Dependabot raises both apps together.

## Know how it's built

- **`apps/control/`:** a Next.js app whose pages are server components that read the database when they open; the menu and the error page are its only code that runs in the browser. `proxy.ts` checks Access on every request; `src/lib/access.ts` verifies the token; `src/lib/config.ts` reads the settings; `src/lib/db.ts` holds the pool (3 connections, `LOBBYSTACK_CONTROL_POOL_MAX` up to 6) and the role check; `src/lib/queries.ts` every query; `src/lib/format.ts` how numbers, money and dates are written; `src/components/` the tiles, tables and the chart.
- **`packages/db/migrations/0153_control_panel_role.sql`:** the role, its settings, its column grants and policies. `packages/db/src/control-role.ts` lists what `db verify-rls` checks, and `db bootstrap` gives the role its login when `LOBBYSTACK_CONTROL_PASSWORD` is set.
- **`Dockerfile.control`:** builds only the panel's own dependencies from the shared lockfile, and runs it as an unprivileged user with a health check. The Runtime images workflow builds it beside the others.
- **`devops/bootstrap.mjs`:** the `control.*` steps, `deploy.control` and `deploy.cloudflared`, and the panel's lines in `status`, `connect` and `doctor`.
