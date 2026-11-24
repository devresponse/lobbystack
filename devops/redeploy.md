# Move a Railway deployment to PostgreSQL 18 with `devops/redeploy.mjs`

A deployment set up before fork PR #223 runs PostgreSQL 16, which is supported until November 9, 2028. PostgreSQL 18 won't start on the files 16 wrote, so the move is a copy ([guide 7.22](../docs/deployment/guide/part-7-operations.md#722-upgrade-pinned-versions)). For a deployment that `devops/bootstrap.mjs` set up, the copy goes into a new Railway project: bootstrap builds it beside the old one from a copy of the deployment's settings files, the database and the bucket's files are copied into it at a quiet hour, and the address moves to it. The old project stays for a week, stopped and frozen, so going back means moving the address back.

`redeploy.mjs` follows that move step by step, under the same numbers: 0 to 40, then G1 to G9 for going back and R1 and R2 for a run that stopped. So far it has one command for the move, `status`, which reads both projects and changes nothing. The other steps are done by hand, as [the steps](#the-steps) describe.

**Status:** written on 24 November 2026 for fork PR #234, on `develop/r2` at `96bb5fe`. `scripts/redeploy.test.ts` runs `status` and `schema` against stand-ins for Railway's and Cloudflare's APIs, and every Railway query the script sends was checked that day against Railway's live API schema. Neither command has run against a real project yet ([what isn't confirmed](#what-isnt-confirmed)). The move itself has run once, on dev2 on 22 and 23 November 2026, with every step done by hand.

## The whole move

| Stage | Steps | Production | What happens |
| --- | --- | --- | --- |
| Before the day | 0 to 7 | Runs on the old project | The tools, backups of the files, the database and the bucket, and the notes that going back needs |
| Build the new project | 8 to 17 | Runs | A copy of the settings files with a temporary address, the old project renamed, the new one built by `up` on PostgreSQL 18, and the variables the files don't know copied across |
| Before the cutover | 18 to 21 | Runs | The bucket copied into the new one, the address move rehearsed with a throwaway name, a trial copy of the database a day ahead, and the hour picked |
| The cutover | 22 to 34 | Offline from step 24 to step 33, about 30 to 60 minutes | Both databases opened to your computer, the services stopped, the database frozen, copied and compared, the bucket's newest files copied, the address moved, `connect` run, then the checks |
| After the checks | 35 to 40 | Runs on the new project | The copies set again, the old services disconnected, backups turned on, the temporary address and the TCP proxies removed, and a week later the old project deleted |
| Going back | G1 to G9 | Back on the old project | Before step 30, in a few minutes (G1 to G3); after it, with the address moved back (G4 to G9) |

Run `status` before each stage and after it ([see where the move stands](#see-where-the-move-stands)).

What carries over: the OpenAI project and its webhook, Twilio's subaccount, numbers and trunk, Resend's domain, Polar's organization, products and webhook, the 13 platform secrets and the database roles' passwords, Turnstile, PostHog, and the control panel's tunnel and address, all from the state file, and the data, with the copy. What's new: the Railway project, its services, volumes and Railway addresses, PostgreSQL 18, an empty Redis, so everyone signs in again once, and Railway's backups, which are turned on again by hand.

## Before you start

- **The tools:** Node.js 18 or later; Docker, with PostgreSQL 18's image (`docker pull postgres:18`), whose `psql`, `pg_dump` and `pg_restore` copy the database from your computer (Docker Desktop on Windows and Mac); and the AWS CLI, which copies the bucket ([guide 7.7](../docs/deployment/guide/part-7-operations.md#77-back-up-the-database-and-files)). Also what bootstrap needs: `pnpm install` done, and optionally the Railway CLI, which makes the bucket ([bootstrap's "Before you start"](bootstrap.md#before-you-start)).
- **The checkout:** `develop/r2`, or `releases/r2` with fork PR #223, whose `devops/bootstrap.mjs` makes `Postgres` from `pgvector/pgvector:pg18-trixie`. The new database's version is decided by the script on your computer alone: the services keep building from the branch they follow.
- **The files:** the deployment's settings file, its `.secrets` file and its `.state.json`, in the checkout's folder, as `up` left them.
- **A Railway token that reaches both projects:** an account token, or a token of their workspace, from `railway.com/account/tokens`. A project token reaches one project only. The script reads `RAILWAY_API_TOKEN` from the environment, then from the settings file's `.secrets` file, then from the copy's, and otherwise asks, with typing hidden. It never saves or prints it.
- **Cloudflare's token, if you have it:** `CLOUDFLARE_API_TOKEN`, read the same way but never asked for. With it, and the zone in the settings file's `CLOUDFLARE_ZONE`, `status` reads the address's DNS records from Cloudflare. Bootstrap's token will do; reading needs only **Zone > DNS > Read**.
- **On Windows,** run it in PowerShell or Windows Terminal, as bootstrap, so that a token you type stays hidden.

## See where the move stands

```sh
node devops/redeploy.mjs status .env.bootstrap-<name>
node devops/redeploy.mjs status app.example.com
```

Give it the deployment's own settings file, the one `up` set it up with, or its address: it then takes the `.env.bootstrap-<name>` file in the current folder whose `APP_BASE_URL` names that address, and stops if none or several do. Given the new project's copy, `.env.bootstrap-<name>-pg18`, it uses the original beside it.

It prints, in this order:

1. **The files:** the settings file, the new project's copy and its address, the backup folder, and the notes file. The backup folder is `lobbystack-backups/<the address's first part>-before-pg18` beside the checkout, unless `--backup <folder>` names another.
2. **Railway's API:** whether it still has every field and argument the script uses ([Railway's API](#railways-api)).
3. **This computer:** Node.js; Docker, whether it's running, and whether it has `postgres:18`; and the AWS CLI. `FIX` marks what the move can't go without.
4. **The old project, then the new one:** each service's copies, its latest deployment (active, succeeded, stopped, deploying or failed) and the release it runs. For `Postgres`, its PostgreSQL version, from its image's tag; its volume; its Railway backups, with the newest and how many are locked; their schedule; and any TCP proxy, which opens the database to anyone on the internet who has the password. For the admin, its addresses, and for each bucket, its files and size. Until the new project exists, it says which step comes next instead: the copy (step 8), forgetting the old project (step 11), or `up` (step 13).
5. **The project's name:** whether the old project still has the name that `up` gives the new one (step 10), or two projects share it.
6. **The buckets,** old against new: the same files and size, or a copy still to make (steps 18 and 28).
7. **The variables,** old against new, of migrate, the admin, the worker and the control panel, by name only ([read the variables](#read-the-variables)).
8. **The notes for going back (step 7):** the address's CNAME and Railway's `_railway-verify` TXT record, from Cloudflare when the settings name `CLOUDFLARE_ZONE` and the token can read it, else the records Railway asks for; and how many copies of the admin and the worker the old project runs. While the old admin still has the address and the new one doesn't, it keeps both in the notes file. Once the address has moved, it shows what it kept and leaves it as it is.

It changes nothing in Railway or Cloudflare, never reads the database's or Redis's variables, and never signs in to a database. It writes no file but the notes file, and that file's lock while it saves, so it's safe to run on production at any hour.

### Read the variables

By hand, step 16 means pasting each service's variables from Railway's **Raw Editor** into files and comparing them. `status` compares them through Railway's API instead. It compares the values as they're written, so a reference such as `${{Postgres.RAILWAY_PRIVATE_DOMAIN}}` is equal in both projects, and leaves out Railway's own `RAILWAY_*` variables, except the few a person sets, such as `RAILWAY_DEPLOYMENT_DRAINING_SECONDS`. It prints names, never a value.

| It says | Why | What to do |
| --- | --- | --- |
| the same in both | | Nothing |
| only in the old project, set by connect | `OPENAI_WEBHOOK_SECRET`, `PLATFORM_API_KEYS` and `POLAR_WEBHOOK_SECRET` on the admin, which only `connect` sets, and `connect` runs on the new project after the switch (step 32) | Copy them to the new admin now, so it answers calls and Polar from the first minute |
| only in the old project, so added in Railway by hand | Such as Google Calendar's variables or `WIDGET_KEY_ISSUANCE_ENABLED`. The files don't know them, and bootstrap leaves such variables alone | Copy them to the new service |
| different: `APP_BASE_URL`, `SITE_URL`, `AUTH_TRUSTED_ORIGINS` | The new project has the temporary address | Nothing: step 30 sets them |
| different: a key, token, secret or password | It was changed in Railway after the files were written | Put production's in the copy's `.secrets` file, then `redo` its step and `up`, as [running it again is safe](bootstrap.md#running-it-again-is-safe) says for that key. Setting it in Railway alone doesn't last: each `variables` run puts the files' value back |
| different: another setting | The script's own value, such as a pool size, against production's | Keep the new one, unless production's was set by hand on purpose |
| only in the new project | A newer bootstrap adds it, such as `FLEET_STATUS_TOKEN` | Nothing |
| sealed | Railway shows a sealed variable's value to no one, its API included | Compare it by hand |

The last line compares `OPENAI_WEBHOOK_SECRET` in the copy's `.secrets` file, if it has one, with the old admin's: `connect` puts that line on the admin, so it must be production's. The copies aren't variables: step 35 sets them, from the notes.

## The steps

The numbers are those of the maintainer's step-by-step guides for dev2 and for RealInfoBot's production, which give each command and click. "By hand" means in Railway's or Cloudflare's dashboard, or a command you type.

### Before the day (steps 0 to 7)

| Step | What | How | What `status` shows |
| --- | --- | --- | --- |
| 0 | Find the deployment's settings file by its address, and name the backup folder | By hand | The file it found, and the backup folder |
| 1 | Check the tools | By hand | Node.js, Docker, the AWS CLI, and the token's access to both projects |
| 2 | Get PostgreSQL 18's tools: `docker pull postgres:18` | By hand | Whether the image is there |
| 3 | Update the checkout: `git pull --ff-only` and `pnpm install`, and check that `devops/bootstrap.mjs` has `pg18-trixie` | By hand | The new database's version, once it's built |
| 4 | Make the backup folder, readable only by your account; copy the three files into it, and write the three SQL files the copy runs ([the SQL](#the-sql-the-copy-runs)) | By hand | Whether the folder exists |
| 5 | Make a Railway backup of the old `Postgres`, and lock it so the schedule keeps it: **Postgres** > **Backups** | By hand | The backups, the newest, how many are locked, and the schedule |
| 6 | Copy the old bucket into the backup folder, with the AWS CLI and the keys on the bucket's **Credentials** tab ([guide 7.7](../docs/deployment/guide/part-7-operations.md#77-back-up-the-database-and-files)) | By hand | Each bucket's files and size |
| 7 | Note the address's DNS records, and how many copies of the admin and the worker run | `status` | Prints them, and keeps them in the notes file |

### Build the new project (steps 8 to 17)

Production keeps running. Don't run `connect` on the copy before step 32: with the temporary address it would make a second webhook in Polar, so Polar would send every event twice, and it would ask you to point OpenAI's webhook away from production.

| Step | What | How | What `status` shows |
| --- | --- | --- | --- |
| 8 | Copy the three files to `.env.bootstrap-<name>-pg18`, with its `.secrets` and `.state.json`, only where no copy exists yet, and keep the copies to your account | By hand | The copy |
| 9 | In the copy, make `APP_BASE_URL` a temporary address, such as `https://app-new.example.com`, and delete any `CUSTOM_HOST` line. Leave the rest as it is | By hand | The copy's address |
| 10 | Rename the old Railway project, such as to `app.example.com (old, PostgreSQL 16)`: bootstrap finds a project by its name, and would otherwise build into production | By hand: the old project's **Settings** > **General** | Whether the old project still has the name |
| 11 | Make the copy forget the old project, once: `node devops/bootstrap.mjs redo .env.bootstrap-<name>-pg18 railway.project`. The list it prints mustn't hold `twilio.tollfree`. Never again after step 13, which would redeploy every new service | By hand | Whether the copy still names the old project |
| 12 | `doctor` and `up --dry-run` on the copy: a new project under the old name, its services, the bucket and the temporary address, and no OpenAI, Twilio, Resend or Polar step | By hand | |
| 13 | `up` on the copy: the new project, with `Postgres` on PostgreSQL 18, made with production's passwords | By hand | The new project, from then on |
| 14 | Copy the three `-pg18` files to `after-stage-1` in the backup folder | By hand | |
| 15 | Check the new services: active, migrate succeeded, and `Postgres` on 18 | By hand | Each service's state, and the database's version |
| 16 | Compare each service's variables, old against new, and copy across what the files don't know | By hand, from what `status` lists | [The comparison](#read-the-variables) |
| 17 | With the control panel, remove the new `cloudflared`'s deployment, so the panel's address answers only from the old project until the switch | By hand: its **Deployments** tab, the newest deployment's menu, **Remove** | `cloudflared` stopped |

### Before the cutover (steps 18 to 21)

| Step | What | How | What `status` shows |
| --- | --- | --- | --- |
| 18 | Copy the bucket into the new bucket too, so that the day's copy is short | By hand, as step 6, then from the backup folder into the new bucket | Both buckets' files and size |
| 19 | Rehearse the address move with a throwaway name, such as `move-test.example.com`: add it to the old admin, move it to the new one, time how long Railway takes to verify it, then remove it and its records | By hand | The admins' addresses |
| 20 | A trial copy, a day or so before, with nothing stopped: a TCP proxy on each `Postgres`, production dumped and restored into a scratch database, `lobbystack_trial`, on the new server, both counted, then the scratch database and both proxies deleted. Note how long each part takes | By hand | Any TCP proxy still there |
| 21 | Pick the hour with the fewest calls and texts, and tell customers who need notice | By hand | |

### The cutover (steps 22 to 34)

Production is offline from step 24 to step 33. From step 23 until the checks, don't sync the branch both projects build from: a sync would start the services you stopped.

| Step | What | How | What `status` shows |
| --- | --- | --- | --- |
| 22 | Add a TCP proxy to each `Postgres`, and open both databases to your computer, checking that the old one isn't on 18 and the new one is | By hand | Both proxies |
| 23 | Stop the new admin, worker and control panel: remove each one's deployment | By hand | Them stopped |
| 24 | When no call is in progress, stop the old admin; two minutes later the old worker, so it finishes the jobs already handed to the old Redis; then the old `cloudflared`. Production is offline from here | By hand | Them stopped |
| 25 | Freeze the old database, count it, and dump it with PostgreSQL 18's `pg_dump -Fc` into the backup folder ([the SQL](#the-sql-the-copy-runs)) | By hand | |
| 26 | Restore into the new database: only on PostgreSQL 18, drop and make `lobbystack` again, `pg_restore -O -1 -e`, then `vacuumdb --analyze-only` | By hand | |
| 27 | Count the new database and compare: `SAME` or `DIFFERENT`. If the old database had the reset-protection mark, set it again ([guide 7.28](../docs/deployment/guide/part-7-operations.md#728-reset-a-test-environment)) | By hand | |
| 28 | Copy the bucket's newest files | By hand, as step 18 | Both buckets' files and size |
| 29 | Redeploy the new migrate, and wait for it to succeed | By hand | migrate's state |
| 30 | Move the address: remove it from the old admin, put `APP_BASE_URL` back in the copy, `redo … railway.domain railway.custom turnstile variables "post.*"`, then `up`, which asks before pointing the CNAME at the new project. Redeploy any new service still stopped | By hand | Which admin has the address |
| 31 | Copy the three `-pg18` files to `after-cutover` in the backup folder | By hand | |
| 32 | Once the new admin is active, `redo … connect.webhook connect.platformKey`, then `connect`. Read what `pnpm billing plan` prints before you type yes: it should make nothing | By hand | |
| 33 | `/api/health/ready` answers `"ok":true`, and `/api/health/live` names the commit the old project ran | By hand | The new services' release |
| 34 | Check: a sign-in and its emailed code, a file opened and one uploaded, a phone call, a text, Polar's one webhook answering 200 and a billing portal, the worker's log, the control panel, and the copies (`node devops/scale.mjs --bootstrap .env.bootstrap-<name>-pg18`) | By hand | |

If a check fails within the first hour and can't be fixed quickly, go back before real traffic builds up on the new database.

### After the checks (steps 35 to 40)

| Step | What | How | What `status` shows |
| --- | --- | --- | --- |
| 35 | Set the copies again, if step 7 noted more than one: `node devops/scale.mjs admin=<n> worker=<n> --max-connections 200 --bootstrap .env.bootstrap-<name>-pg18`, first with `--dry-run` | By hand, from the notes | The copies |
| 36 | Disconnect the old migrate, admin, worker and control panel from the repository, so a sync doesn't start them | By hand: each one's **Settings** > **Source** > **Disconnect** | |
| 37 | Turn on the new `Postgres`'s backups ([guide 5.2](../docs/deployment/guide/part-5-production.md#52-production-on-railway), step 16), and, if production has the nightly copy, set it up in the new project with `PG_VERSION=18` (steps 17 to 22) and stop the old one | By hand | The schedule |
| 38 | Remove the temporary address from the new admin, and its records from Cloudflare | By hand | The admin's addresses |
| 39 | Delete both TCP proxies | By hand: **Postgres** > **Settings** > **Networking** | None |
| 40 | A week later, if nothing needed going back, delete the old project, which deletes its backups too, and move the old three files into the backup folder. From then on, bootstrap and the scale script run with the `-pg18` files | By hand | |

### Going back

**Before step 30,** while the old admin still has the address, nothing outside Railway has changed:

- **G1.** Open the old database again: `grant connect on database lobbystack to public;`, through its TCP proxy, which you add again if step 39 removed it.
- **G2.** Start the old services: redeploy the removed deployments of the old admin, worker and `cloudflared`. They come back with their copies, which stayed in their settings.
- **G3.** Empty the new database, only on PostgreSQL 18: drop `lobbystack` and make it again, then redeploy the new migrate. A sync of the branch would otherwise start a new worker on production's data, which would send the same reminders and texts a second time.

**After step 30:**

- **G4.** Stop the new services: remove the address from the new admin, and the deployments of the new admin, worker, control panel and `cloudflared`.
- **G5.** Give the address back to the old admin, and set its CNAME and `_railway-verify` record in Cloudflare to what Railway shows: the notes from step 7, unless Railway shows new values.
- **G6 and G7.** As G1 and G2.
- **G8.** Set the new database aside, only on PostgreSQL 18: rename `lobbystack` to `lobbystack_after_switch`, which keeps what customers wrote after the switch, make an empty `lobbystack`, and redeploy the new migrate. PostgreSQL 16 can't read a dump made by 18, so that data stays there to look things up in.
- **G9.** If `connect` ever ran with the temporary address, delete Polar's webhook for it. Nothing else changes at Twilio, OpenAI or Polar, and the original files still describe the old project.

### If a run stops

Every step can run again. Bootstrap marks a step done only when it finishes, and finds what it made by ID or name rather than making it twice. If you have to stop for the day anywhere from step 24 to step 29, go back rather than leave production offline: the next attempt runs from step 22 again.

- **R1.** If the `-pg18` files are lost or broken, put the newest backed-up copies back: `after-cutover` if step 31 made it, else `after-stage-1`, from which step 30 runs again in full.
- **R2.** A lock left behind by a closed window is taken over by the next run, as bootstrap does. If bootstrap says another run is using the state file and none is, delete the `.lock` file it names.

## The SQL the copy runs

Three files in the backup folder, which psql reads with `-f`: pasted into psql's prompt, a block can arrive as one line, and a leading command then swallows the rest.

`count.sql` prints one line: the number of tables, the rows in all, and a fingerprint of every table's name and row count, so two databases compare in one line.

```sql
with t as (
  select table_schema || '.' || table_name as tbl,
    (xpath('/row/c/text()', query_to_xml(format(
      'select count(*) as c from %I.%I', table_schema, table_name),
      false, true, '')))[1]::text::bigint as n
  from information_schema.tables
  where table_type = 'BASE TABLE'
    and table_schema not in ('pg_catalog', 'information_schema')
)
select format('tables %s, rows %s, fingerprint %s',
  count(*), sum(n),
  md5(string_agg(tbl || '=' || n, ',' order by tbl collate "C")))
from t;
```

`freeze.sql` stops the app's roles from connecting again, ends the sessions still open, and shows the database's own settings, where `lobbystack.reset_protection=on` is the mark step 27 sets again. `postgres` can still connect, for the copy.

```sql
revoke connect on database lobbystack from public;
select count(pg_terminate_backend(pid)) as sessions_ended
from pg_stat_activity
where datname = 'lobbystack' and pid <> pg_backend_pid();
select coalesce(string_agg(s, ', '), 'none') as database_settings
from pg_db_role_setting, unnest(setconfig) as s
where setrole = 0 and setdatabase =
  (select oid from pg_database where datname = 'lobbystack');
```

`tables.sql` lists every table with its rows, to find where two counts differ.

```sql
select table_schema || '.' || table_name || ' ' ||
  (xpath('/row/c/text()', query_to_xml(format(
    'select count(*) as c from %I.%I', table_schema, table_name),
    false, true, '')))[1]::text
from information_schema.tables
where table_type = 'BASE TABLE'
  and table_schema not in ('pg_catalog', 'information_schema')
order by (table_schema || '.' || table_name) collate "C";
```

The dump runs as `postgres`, through the old database's TCP proxy, with the password from bootstrap's state file, which is the same in both projects since the copy's state file came from the original. The restore's flags: `-O` gives every object to `postgres`, which owns them in production too; `-1` restores in one transaction and `-e` stops at the first error, so a restore finishes whole or leaves the database empty. The roles are already in the new database, with production's passwords: migrate made them in step 13.

## Files and secrets

| File | What | Who writes it |
| --- | --- | --- |
| `.env.bootstrap-<name>`, `.secrets`, `.state.json` | The deployment's settings, keys and state, which keep describing the old project until step 40 | Bootstrap. `status` only reads them |
| `.env.bootstrap-<name>-pg18`, and its `.secrets` and `.state.json` | The new project's, made by copying the three (step 8) | You, then bootstrap |
| `.env.bootstrap-<name>.redeploy.json` | `status`'s notes: the address's DNS records, the copies of the admin and the worker, the old project's ID and when it noted them. No key | `status`, readable only by your account where the system allows |
| `.env.bootstrap-<name>.redeploy.json.lock` | Held while the notes are written, and taken over from a run that's gone | `status` |
| The backup folder | Copies of the files, the SQL files, the dump and the bucket's files. It holds every key and production's data, so keep it to your account and out of the checkout | You |

`status` reads the variables of migrate, the admin, the worker and the control panel, which hold keys, to compare them, and prints none of them: it hides any value of a variable whose name ends like a key's, such as `_KEY`, `_SECRET`, `_TOKEN`, `_PASSWORD`, `DATABASE_URL` and `REDIS_URL`, and any text shaped like a key, as bootstrap does.

## Railway's API

The script calls Railway's public API, `backboard.railway.com/graphql/v2`, as bootstrap and the scale script do. Each run first checks every query it sends against Railway's schema, which Railway gives without a token: each field, argument and input it uses must still be there, and each argument Railway requires must be given. `status` names a change it finds and carries on, since it only reads.

```sh
node devops/redeploy.mjs schema
node devops/redeploy.mjs schema --save scripts/fixtures/railway-redeploy-schema.json
```

The first runs only that check, and exits with 1 if something changed. The second also writes the part of the schema the script uses into the file `scripts/redeploy.test.ts` checks the script's queries against, so CI checks them without the network. Run it after changing a query, and commit the file with the change.

## What isn't confirmed

None of this has met Railway or Cloudflare yet; the stand-ins answer as Railway's schema and Cloudflare's API describe. On the first run against dev2's old and new projects, check:

- **That an account or workspace token reads both projects,** their variables and their buckets.
- **The copies,** read as `devops/scale.mjs` reads them, from the latest deployment's settings, which hasn't met Railway either.
- **A locked backup,** taken to be one with no end date: Railway's lock removes it, so the schedule never deletes the backup.
- **The buckets' files and sizes** (`bucketInstanceDetails`), and how soon they show a copy just made.
- **The sealed variables,** taken from the environment's list of variables, which gives each one's name and whether it's sealed.
- **The release,** from the latest deployment's commit and branch.
- **Cloudflare's records,** read with bootstrap's token.
