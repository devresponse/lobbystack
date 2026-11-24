# Move a Railway deployment to PostgreSQL 18 with `devops/redeploy.mjs`

A deployment set up before fork PR #223 runs PostgreSQL 16, which is supported until November 9, 2028. PostgreSQL 18 won't start on the files 16 wrote, so the move is a copy ([guide 7.22](../docs/deployment/guide/part-7-operations.md#722-upgrade-pinned-versions)). For a deployment that `devops/bootstrap.mjs` set up, the copy goes into a new Railway project: bootstrap builds it beside the old one from a copy of the deployment's settings files, the database and the bucket's files are copied into it at a quiet hour, and the address moves to it. The old project stays for a week, stopped and frozen, so going back means moving the address back.

`redeploy.mjs` follows that move step by step, under the same numbers: 0 to 40, then G1 to G9 for going back and R1 and R2 for a run that stopped. `status` reads both projects and changes nothing. Six commands do the steps in order: `prepare` (steps 1 to 17), `trial` (18 to 20), `cutover` (22 to 33), `check` (34), `finish` (35 to 39) and `retire` (40). `back` goes back (G1 to G9) from wherever the cutover got to, and `recover` puts back the new project's settings files if they're lost (R1). Only picking the hour (step 21) and the checks only a person can make are left to you, as [the steps](#the-steps) describe.

**Status:** written on 24 November 2026 for fork PRs #234, #235 and #236, on `develop/r2` at `0649c9f`. `scripts/redeploy.test.ts` runs every command against stand-ins for Railway's and Cloudflare's APIs, bootstrap, the scale script, Docker and the AWS CLI, and every query and change the script sends to Railway was checked that day against Railway's live API schema. None has run against a real project yet ([what isn't confirmed](#what-isnt-confirmed)). The move itself has run once, on dev2 on 22 and 23 November 2026, with every step done by hand.

## The whole move

| Stage | Steps | Production | What happens | How |
| --- | --- | --- | --- | --- |
| Before the day | 0 to 7 | Runs on the old project | The tools, backups of the files, the database and the bucket, and the notes that going back needs | `prepare` |
| Build the new project | 8 to 17 | Runs | A copy of the settings files with a temporary address, the old project renamed, the new one built by `up` on PostgreSQL 18, and the variables the files don't know copied across | `prepare` |
| Before the cutover | 18 to 21 | Runs | The bucket copied into the new one, the address move rehearsed with a throwaway name, a trial copy of the database a day ahead, and the hour picked | `trial`, then the hour by hand |
| The cutover | 22 to 34 | Offline from step 24 to step 33, about 30 to 60 minutes | Both databases opened to your computer, the services stopped, the database frozen, copied and compared, the bucket's newest files copied, the address moved, `connect` run, then the checks | `cutover`, then `check` |
| After the checks | 35 to 40 | Runs on the new project | The copies set again, the old services disconnected, backups turned on, the temporary address and the TCP proxies removed, and a week later the old project deleted | `finish`, and a week later `retire` |
| Going back | G1 to G9 | Back on the old project | Before step 30, in a few minutes (G1 to G3); after it, with the address moved back (G4 to G9) | `back` |

Run `status` before each stage and after it ([see where the move stands](#see-where-the-move-stands)), and the commands as [run the steps](#run-the-steps) describes.

What carries over: the OpenAI project and its webhook, Twilio's subaccount, numbers and trunk, Resend's domain, Polar's organization, products and webhook, the 13 platform secrets and the database roles' passwords, Turnstile, PostHog, and the control panel's tunnel and address, all from the state file, and the data, with the copy. What's new: the Railway project, its services, volumes and Railway addresses, PostgreSQL 18, an empty Redis, so everyone signs in again once, and Railway's backups, which are turned on again by hand.

## Before you start

- **The tools:** Node.js 18 or later; Docker, running, with PostgreSQL 18's image (`docker pull postgres:18`, which `prepare` does), whose `psql`, `pg_dump` and `pg_restore` copy the database from your computer (Docker Desktop on Windows and Mac); and the AWS CLI, which copies the bucket ([guide 7.7](../docs/deployment/guide/part-7-operations.md#77-back-up-the-database-and-files)). Also what bootstrap needs: `pnpm install` done, and optionally the Railway CLI, which makes the bucket ([bootstrap's "Before you start"](bootstrap.md#before-you-start)).
- **The checkout:** `develop/r2`, or `releases/r2` with fork PR #223, whose `devops/bootstrap.mjs` makes `Postgres` from `pgvector/pgvector:pg18-trixie`. The new database's version is decided by the script on your computer alone: the services keep building from the branch they follow.
- **The files:** the deployment's settings file, its `.secrets` file and its `.state.json`, in the checkout's folder, as `up` left them.
- **A Railway token that reaches both projects:** an account token, or a token of their workspace, from `railway.com/account/tokens`. A project token reaches one project only. The script reads `RAILWAY_API_TOKEN` from the environment, then from the settings file's `.secrets` file, then from the copy's, and otherwise asks, with typing hidden. It never saves or prints it.
- **Cloudflare's token, if you have it:** `CLOUDFLARE_API_TOKEN`, read the same way but never asked for. With it, and the zone in the settings file's `CLOUDFLARE_ZONE`, `status` reads the address's DNS records from Cloudflare, `trial` writes and then deletes the records of the throwaway name it rehearses the address move with (step 19), `back` points the address's records at the old project again (G5), and `finish` deletes the temporary address's records (step 38). Bootstrap's token will do: it has **Zone > DNS > Edit**, and bootstrap's `up` uses it at the cutover's address move (step 30). Without it, rehearse by hand and run `trial --no-rehearsal`, and `back` and `finish` say which records to change.
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

`prepare` does what the table says at step 16 ([prepare](#prepare-steps-1-to-17)).

## Run the steps

```sh
node devops/redeploy.mjs prepare .env.bootstrap-<name>
node devops/redeploy.mjs trial .env.bootstrap-<name>
node devops/redeploy.mjs cutover .env.bootstrap-<name>
node devops/redeploy.mjs check .env.bootstrap-<name>
node devops/redeploy.mjs finish .env.bootstrap-<name>
node devops/redeploy.mjs retire .env.bootstrap-<name>
```

And when something goes wrong:

```sh
node devops/redeploy.mjs back .env.bootstrap-<name>
node devops/redeploy.mjs recover .env.bootstrap-<name>
```

Each takes the settings file or the address, and `--backup <folder>`, as `status` does. Once `prepare` has made the backup folder (step 4), the notes file remembers it, so later runs find it without `--backup`.

Each run:

1. Takes the notes file's lock and holds it to the end, so two runs never change the move at once: a second run stops and names the command and the process that hold it. A lock left by a run that's gone is taken over.
2. Checks Railway's API, as `status` does, and stops before it changes anything if a call it makes is gone.
3. Reads both projects, and stops if the command doesn't fit where the move stands, saying what comes first.
4. Lists its steps, marking those done already, and says what it will change.
5. Asks before it changes anything: type `yes`. `cutover` asks it as whether it's the hour you picked, `back` says what going back leaves behind, `finish` asks whether all of step 34's checks have passed, and `retire` wants the old project's name typed in full instead. `check` changes nothing, so it asks only its own questions.
6. Runs the steps in order, and records each in the notes file when it finishes, with the time and how long it took. A step whose work it finds done already says so with `=`, and is recorded like the others. At the first check that fails, it stops and says what to do; then run the same command again, and it carries on from the step that stopped.
7. Says what comes next.

With `--dry-run`, it does 2 to 4, says what it would change, and changes nothing, without taking the lock. `recover` reads only files, so it does none of 2 to 4. Everything a run prints, secrets hidden, also goes into `.env.bootstrap-<name>.redeploy.log`, with each command it ran and its exit code; what bootstrap and the scale script print stays in the terminal.

### `prepare`: steps 1 to 17

Any day before the cutover, while production runs. Most of its time goes on waiting for Railway: up to an hour for the backup, then `up` and up to 20 minutes for the new services. It stops before it starts if the settings name no address, if the old database runs PostgreSQL 18 already, or if the new project has the address, which means the cutover has run. `--same-version` allows an old database on 18, to rehearse the whole move on a deployment set up for the purpose.

- **Steps 1 to 3:** Docker running, and the AWS CLI if the old project has a bucket; `docker pull postgres:18` unless the image is there, whose `pg_dump` must say 18; and this checkout's `devops/bootstrap.mjs` making `Postgres` on 18. It prints the checkout's last commit, and says if `pnpm install` hasn't run, which `connect` needs at step 32.
- **Step 4:** The backup folder, refused inside the checkout and kept to your account with `chmod`, or on Windows `icacls`. The three files are copied in, never over a different copy, which gets the time in its name instead, and the four [SQL files](#the-sql-the-copy-runs) are written.
- **Step 5:** A Railway backup of the old database's volume, named `before-pg18-<date>`, then locked. If Railway still gives it an end date, it says to lock it by hand.
- **Step 6:** `aws s3 sync` from the old bucket into `<the address's first part>-files` in the backup folder, with the bucket's keys from Railway's API, which reach the AWS CLI through its environment only. Nothing is deleted on either side.
- **Step 7:** The notes, as `status` keeps them.
- **Steps 8 and 9:** The copy, only where none exists, then its temporary address: `APP_BASE_URL=https://<first part>-new.<rest>`, such as `https://app-new.example.com`, unless `--temporary <host>` names another, which must be in `CLOUDFLARE_ZONE`. It takes `CUSTOM_HOST` out and leaves every other line as it is.
- **Step 10:** The old project renamed, such as to `app.example.com (old, PostgreSQL 16)`. Then it checks, in the settings' workspace and the old project's, that no project but the new one has the name `up` looks for, as it does again before steps 11 to 13.
- **Step 11:** `bootstrap.mjs redo <copy> railway.project`, once, only while the copy still names the old project, with what redo prints. It then checks that the copy's state file still marks done every OpenAI, Twilio, Resend and Polar step the original's does, as it does again before steps 12 and 13, since `up` would otherwise do one again outside Railway.
- **Steps 12 and 13:** `doctor` and `up --dry-run` on the copy, then `up`, which prints as it goes and asks its own questions. The copy's state file must then name a new project.
- **Step 14:** The three `-pg18` files copied to `after-stage-1` in the backup folder.
- **Step 15:** It waits up to 20 minutes for every new service to run and migrate to succeed, the control panel's only where the old project has it; checks the new `Postgres`'s image, and its log, for PostgreSQL 18; then waits up to 15 minutes for `https://<temporary address>/api/health/ready` to answer `"ok":true`. Don't sign up there: the cutover replaces its data.
- **Step 16:** [The comparison](#read-the-variables), then what its table says to do. Production's `OPENAI_WEBHOOK_SECRET` goes into the copy's `.secrets` file, if the two differ. If a key, token, secret or password differs, it asks whether the new project should keep the files' values: to give it production's, answer no, bring the files up to date as the table says, and run `prepare` again. Then the variables only the old services have, of both kinds, are copied to the new services, which Railway deploys again, and it checks that Railway shows them. A sealed variable is named, for comparing by hand.
- **Step 17:** The new `cloudflared`'s deployment removed, where the deployment has the control panel.

Of the old project, it changes the name and adds the backup, nothing else, and it changes nothing at OpenAI, Twilio, Resend or Polar.

### `trial`: steps 18 to 20

A day or so before the cutover, while production runs. It waits for `prepare` to finish, and stops if the new project has the address.

- **Step 18:** The old bucket into the backup folder again, which copies only what changed, then the folder into the new bucket. It stops if the new project has no bucket, or if its bucket is the old one.
- **Step 19:** The throwaway name is `move-test.<zone>`, unless `--rehearse <host>` names another in `CLOUDFLARE_ZONE`, which mustn't be one of the deployment's own addresses. It adds the name to the old admin, writes the records Railway asks for in Cloudflare, DNS only and with the comment `redeploy.mjs step 19, a throwaway name`, and times how long Railway takes to verify it. Then it removes the name, times how long until Railway lets the new project have it, and does the same on the new admin. Whatever happens, it then removes the name from both admins and deletes the records it made. It never writes over a record it didn't make, and the deployment's address isn't touched. `--no-rehearsal` leaves the step out, for a zone that isn't on Cloudflare; rehearse by hand then.
- **Step 20:** A TCP proxy on each `Postgres`, added through Railway's API without a deploy, unless one is there already. It checks that the two reach different servers, the new one on PostgreSQL 18 and the old one not, unless `--same-version`; counts production with `count.sql`; dumps it with `pg_dump -Fc` into `trial.dump` in the backup folder while it runs; restores the dump with `pg_restore -O -1 -e` into `lobbystack_trial` on the new server, once it has checked that the proxy still reaches the server it checked first; and counts that. It says `SAME`, or the same tables with some rows apart, since production kept writing during the dump; if the tables differ, it lists the lines that differ and stops. It prints how long the dump and the restore took, which is about how long the cutover's copy takes while production is offline, and the calls in each hour of the last four weeks, in your computer's time zone, for step 21. Whatever happens, it then drops `lobbystack_trial`, deletes the dump and closes the proxies it opened. A proxy someone else opened stays, for step 39. If a run stops halfway, the notes name the proxies it opened, and the next run closes them.

The database's password is `POSTGRES_PASSWORD` from both state files, which must agree, and reaches Docker through its environment only. PostgreSQL 18's tools run in Docker as `postgres`, in the backup folder.

### `cutover`: steps 22 to 33

At the hour picked (step 21), with the customers who need notice told. It waits for `trial` to finish, and asks whether it's the hour you picked: production is offline from step 24 to step 33, about as long as the trial's dump and restore took, which it says, plus the address move and `connect`. If a run stops, run `cutover` again: it carries on from the step that stopped, and asks only whether to go on. To give up instead, run `back`. `--same-version`, as with `prepare` and `trial`, allows an old database on 18.

- **Step 22:** A TCP proxy on each `Postgres`, as at step 20, and the same checks: two different servers, the new one on PostgreSQL 18 and the old one not. It notes each server's identity, and every later step that touches a database first checks that its proxy still reaches the same server.
- **Step 23:** The new admin, worker and control panel stopped: their deployments removed.
- **Step 24:** It waits, up to 20 minutes, until no call is in progress. The old workers say how many calls they hold through the old admin's fleet status address, where the old admin has a `FLEET_STATUS_TOKEN`; otherwise it counts the calls in the old database that started in the last half hour and haven't ended. If calls remain after 20 minutes, it asks whether to cut them off. Then it notes the release the old admin runs, and stops the old admin, which takes production offline; two minutes later the old worker, which has finished the jobs already handed to the old Redis by then; then the old `cloudflared`.
- **Step 25:** `freeze.sql` on the old database, which stops at its first error, so nothing is dumped from a database it didn't freeze, and says how many sessions it ended and the database's own settings, where it notes the reset-protection mark; `count.sql`, kept in `count-old.txt` in the backup folder; then `pg_dump -Fc` into `<the address's first part>.dump` in the backup folder, written as a `.part` file and renamed once it's whole.
- **Step 26:** The new admin, worker and control panel stopped again, if a sync of the branch started them. Then, on the new server only, `lobbystack` dropped with its sessions ended and made again, the dump restored with `pg_restore -O -1 -e`, and `vacuumdb --analyze-only`, since a restore brings no statistics. If the dump isn't there, it records step 25 as not done and stops, so the next run dumps again.
- **Step 27:** `count.sql` on the new database, against the old one's count: `SAME`, or `DIFFERENT` with the lines of `tables.sql` that differ, after which it records step 26 as not done and stops, so the next run restores again. If the old database had the reset-protection mark, it sets it on the new one.
- **Step 28:** The bucket's newest files, as at step 18.
- **Step 29:** The new migrate deployed again, as Railway's **Redeploy** does, so its pre-deploy runs on the copied data: the migrations, the roles' passwords and the row-level security check. It waits up to 20 minutes for it to succeed.
- **Step 30:** The address taken off the old admin, and `APP_BASE_URL` put back in the copy, without `CUSTOM_HOST`. Once Railway lets the new project have the address, `bootstrap.mjs redo <copy> railway.domain railway.custom turnstile variables "post.*"`, once, then `up` on the copy, which puts the address on the new admin, asks before it points the address's CNAME at the new project, and sets the address's variables, so Railway deploys the new admin and worker again. Any new service still stopped then, such as the control panel and `cloudflared`, starts again on the image it ran. If `up` stops, do what it says and run `cutover` again: it runs `up` again, not `redo`.
- **Step 31:** The three `-pg18` files copied to `after-cutover` in the backup folder.
- **Step 32:** The copy's `OPENAI_WEBHOOK_SECRET`, if it has one, made the old admin's again if they differ; `redo <copy> connect.webhook connect.platformKey`, once, then `connect`, which prints what `pnpm billing plan` would make in Polar and asks: it should make nothing, so read it before you type yes.
- **Step 33:** It waits up to 15 minutes for `https://<address>/api/health/ready` to answer `"ok":true` while Railway gives the address its certificate, then names the release the new project runs, says if it isn't the one the old project ran, and how long production was offline.

The TCP proxies stay open, for going back; `finish` deletes them (step 39).

### `check`: step 34

Right after the cutover. It changes nothing, so it doesn't ask first. It reads:

- `https://<address>/api/health/ready`;
- the copies, as `devops/scale.mjs --bootstrap <copy>` lists them;
- the new worker's log since it started, with its newest errors;
- with the control panel, its address, which must answer through the new `cloudflared`;
- whether `pnpm billing verify` passed at the end of `connect`.

Then it asks about what only a person can check, each answered yes or no: a sign-in with the emailed code, a knowledge document or a call recording opened and a small file uploaded, a call to a business's number, a text to it, where the deployment takes payments Polar's one webhook to the address answering 200 and a billing portal opening, the worker's log, and the control panel. If any answer is no, it stops and names them: fix it if it's quick and run `check` again, or go back within the first hour, before real traffic builds up on the new database. Once `cutover` has run, `finish` waits for `check` to pass.

### `finish`: steps 35 to 39

Once all of step 34's checks have passed, which it asks you to confirm. It stops unless the new admin has the address and the old one doesn't.

- **Step 35:** If step 7 noted more than one copy of the admin or the worker, `scale.mjs admin=<n> worker=<n> --max-connections 200 --bootstrap <copy>`, first with `--dry-run`. The scale script asks its own yes.
- **Step 36:** The old migrate, admin, worker and control panel disconnected from the repository.
- **Step 37:** The new `Postgres`'s backups, on the old one's schedule: daily, weekly or monthly. If the old project has services of its own, such as the nightly copy, it names them: set that up in the new project with `PG_VERSION=18` ([guide 5.2](../docs/deployment/guide/part-5-production.md#52-production-on-railway), steps 17 to 22), and stop the old one.
- **Step 38:** The temporary address removed from the new admin, and, with Cloudflare's token and `CLOUDFLARE_ZONE`, its CNAME and `_railway-verify` records deleted from Cloudflare; without them, it says which to delete by hand.
- **Step 39:** Both databases' TCP proxies deleted.

### `retire`: step 40

A week after the cutover. It waits for `finish`, and for the new admin to have the address, says if `finish` ran less than a week ago, and asks you to type the old project's name. Railway then deletes the old project and its backups after 48 hours, during which the old project's **Settings** can cancel that. The original settings file, its `.secrets`, `.state.json`, `.vars` and `.log`, and the script's notes and log go into `old-project-files` in the backup folder. From then on, bootstrap and the scale script run with the `-pg18` files.

### `back`: G1 to G9

Production back on the old project, from wherever the cutover got to: G1 to G3 while the old admin still has the address and step 30 hasn't begun, G4 to G9 after. It says which and what that leaves behind, and asks first. If it stops, run it again: it finishes the same way, and `cutover` and `finish` wait until it has.

- **G1 and G6:** `grant connect on database lobbystack to public` on the old database, through its TCP proxy, which it opens again if it's gone.
- **G2 and G7:** The old admin, worker and `cloudflared` started again: the deployments step 24 removed, deployed again on the image they ran, or where Railway won't, new ones from their source. It waits for each to succeed and, once the old admin has the address, for `https://<address>/api/health/ready` to answer `"ok":true`.
- **G3:** The new admin, worker and control panel stopped, if a sync started them; `lobbystack` on the new server dropped and made again, on PostgreSQL 18 only; and the new migrate deployed again.
- **G4:** The address taken off the new admin, and the new admin, worker, control panel and `cloudflared` stopped.
- **G5:** The address given back to the old admin, once Railway lets it have it, and the records Railway asks for written in Cloudflare, DNS only. It asks before it points the CNAME back at the old project, and says where Railway's records differ from the notes of step 7. Without Cloudflare's token or `CLOUDFLARE_ZONE`, it prints them for you to set, and asks whether they're set.
- **G8:** The new admin, worker and control panel stopped, if a sync started them; the new `lobbystack` renamed `lobbystack_after_switch`, or that name with the time after it if it's taken, once its sessions have ended, which keeps what customers wrote after the switch; an empty `lobbystack` made; and the new migrate deployed again.
- **G9:** Polar's webhook for the temporary address, which only a `connect` run on the copy before step 30 would have made, to delete by hand.

Once every step is done, it closes the TCP proxies the script opened, records when it went back and which way, and clears the cutover's steps, so the next try runs `cutover` from step 22 at another quiet hour. The new project stays as it is for that try, and `status` shows each time the move went back.

### `recover`: R1

If the `-pg18` files are lost or broken, it puts back the newest copies the backup folder has: `after-cutover` if step 31 made it, else `after-stage-1` (step 14), after moving the ones there now into `replaced-<time>` in the backup folder. What the copy's state file learned after that backup runs again: from `after-cutover`, steps 32 and 33; from `after-stage-1`, steps 30 to 33, bootstrap's `redo` included. It asks first, and reads and writes files only; `--dry-run` says what it would do. Then run `status`, and the command whose step is next.

## The steps

The numbers are those of the maintainer's step-by-step guides for dev2 and for RealInfoBot's production, which give each command and click. In the "How" column, a command's name means that command does the step ([run the steps](#run-the-steps)), and "By hand" means in Railway's or Cloudflare's dashboard, or a command you type.

### Before the day (steps 0 to 7)

| Step | What | How | What `status` shows |
| --- | --- | --- | --- |
| 0 | Find the deployment's settings file by its address, and name the backup folder | Each command, given the file or the address | The file it found, and the backup folder |
| 1 | Check the tools | `prepare` | Node.js, Docker, the AWS CLI, and the token's access to both projects |
| 2 | Get PostgreSQL 18's tools: `docker pull postgres:18` | `prepare` | Whether the image is there |
| 3 | Update the checkout: `git pull --ff-only` and `pnpm install`, and check that `devops/bootstrap.mjs` has `pg18-trixie` | By hand; `prepare` checks it | The new database's version, once it's built |
| 4 | Make the backup folder, readable only by your account; copy the three files into it, and write the SQL files the copy runs ([the SQL](#the-sql-the-copy-runs)) | `prepare` | Whether the folder exists |
| 5 | Make a Railway backup of the old `Postgres`, and lock it so the schedule keeps it: **Postgres** > **Backups** | `prepare` | The backups, the newest, how many are locked, and the schedule |
| 6 | Copy the old bucket into the backup folder, with the AWS CLI and the keys on the bucket's **Credentials** tab ([guide 7.7](../docs/deployment/guide/part-7-operations.md#77-back-up-the-database-and-files)) | `prepare` | Each bucket's files and size |
| 7 | Note the address's DNS records, and how many copies of the admin and the worker run | `prepare`, or `status` | Prints them, and keeps them in the notes file |

### Build the new project (steps 8 to 17)

Production keeps running. Don't run `connect` on the copy before step 32: with the temporary address it would make a second webhook in Polar, so Polar would send every event twice, and it would ask you to point OpenAI's webhook away from production.

| Step | What | How | What `status` shows |
| --- | --- | --- | --- |
| 8 | Copy the three files to `.env.bootstrap-<name>-pg18`, with its `.secrets` and `.state.json`, only where no copy exists yet, and keep the copies to your account | `prepare` | The copy |
| 9 | In the copy, make `APP_BASE_URL` a temporary address, such as `https://app-new.example.com`, and delete any `CUSTOM_HOST` line. Leave the rest as it is | `prepare` | The copy's address |
| 10 | Rename the old Railway project, such as to `app.example.com (old, PostgreSQL 16)`: bootstrap finds a project by its name, and would otherwise build into production | `prepare` (by hand: the old project's **Settings** > **General**) | Whether the old project still has the name |
| 11 | Make the copy forget the old project, once: `node devops/bootstrap.mjs redo .env.bootstrap-<name>-pg18 railway.project`. The list it prints mustn't hold `twilio.tollfree`. Never again after step 13, which would redeploy every new service | `prepare` | Whether the copy still names the old project |
| 12 | `doctor` and `up --dry-run` on the copy: a new project under the old name, its services, the bucket and the temporary address, and no OpenAI, Twilio, Resend or Polar step | `prepare` | |
| 13 | `up` on the copy: the new project, with `Postgres` on PostgreSQL 18, made with production's passwords | `prepare` | The new project, from then on |
| 14 | Copy the three `-pg18` files to `after-stage-1` in the backup folder | `prepare` | |
| 15 | Check the new services: active, migrate succeeded, and `Postgres` on 18 | `prepare` | Each service's state, and the database's version |
| 16 | Compare each service's variables, old against new, and copy across what the files don't know | `prepare` | [The comparison](#read-the-variables) |
| 17 | With the control panel, remove the new `cloudflared`'s deployment, so the panel's address answers only from the old project until the switch | `prepare` (by hand: its **Deployments** tab, the newest deployment's menu, **Remove**) | `cloudflared` stopped |

### Before the cutover (steps 18 to 21)

| Step | What | How | What `status` shows |
| --- | --- | --- | --- |
| 18 | Copy the bucket into the new bucket too, so that the day's copy is short | `trial` (by hand: as step 6, then from the backup folder into the new bucket) | Both buckets' files and size |
| 19 | Rehearse the address move with a throwaway name, such as `move-test.example.com`: add it to the old admin, move it to the new one, time how long Railway takes to verify it, then remove it and its records | `trial` | The admins' addresses |
| 20 | A trial copy, a day or so before, with nothing stopped: a TCP proxy on each `Postgres`, production dumped and restored into a scratch database, `lobbystack_trial`, on the new server, both counted, then the scratch database and both proxies deleted. Note how long each part takes | `trial` | Any TCP proxy still there |
| 21 | Pick the hour with the fewest calls and texts, and tell customers who need notice | By hand, from the calls by hour that `trial` prints | |

### The cutover (steps 22 to 34)

Production is offline from step 24 to step 33. From step 23 until the checks, don't sync the branch both projects build from: a sync would start the services you stopped.

| Step | What | How | What `status` shows |
| --- | --- | --- | --- |
| 22 | Add a TCP proxy to each `Postgres`, and open both databases to your computer, checking that the old one isn't on 18 and the new one is | `cutover` | Both proxies |
| 23 | Stop the new admin, worker and control panel: remove each one's deployment | `cutover` (by hand: each one's **Deployments** tab, the newest deployment's menu, **Remove**) | Them stopped |
| 24 | When no call is in progress, stop the old admin; two minutes later the old worker, so it finishes the jobs already handed to the old Redis; then the old `cloudflared`. Production is offline from here | `cutover` | Them stopped |
| 25 | Freeze the old database, count it, and dump it with PostgreSQL 18's `pg_dump -Fc` into the backup folder ([the SQL](#the-sql-the-copy-runs)) | `cutover` | |
| 26 | Restore into the new database: only on PostgreSQL 18, drop and make `lobbystack` again, `pg_restore -O -1 -e`, then `vacuumdb --analyze-only` | `cutover` | |
| 27 | Count the new database and compare: `SAME` or `DIFFERENT`. If the old database had the reset-protection mark, set it again ([guide 7.28](../docs/deployment/guide/part-7-operations.md#728-reset-a-test-environment)) | `cutover` | |
| 28 | Copy the bucket's newest files | `cutover`, as step 18 | Both buckets' files and size |
| 29 | Redeploy the new migrate, and wait for it to succeed | `cutover` | migrate's state |
| 30 | Move the address: remove it from the old admin, put `APP_BASE_URL` back in the copy, `redo … railway.domain railway.custom turnstile variables "post.*"`, then `up`, which asks before pointing the CNAME at the new project. Redeploy any new service still stopped | `cutover`, which runs bootstrap's `redo` and `up` | Which admin has the address |
| 31 | Copy the three `-pg18` files to `after-cutover` in the backup folder | `cutover` | |
| 32 | Once the new admin is active, `redo … connect.webhook connect.platformKey`, then `connect`. Read what `pnpm billing plan` prints before you type yes: it should make nothing | `cutover`, which runs bootstrap's `redo` and `connect` | |
| 33 | `/api/health/ready` answers `"ok":true`, and `/api/health/live` names the commit the old project ran | `cutover` | The new services' release |
| 34 | Check: a sign-in and its emailed code, a file opened and one uploaded, a phone call, a text, Polar's one webhook answering 200 and a billing portal, the worker's log, the control panel, and the copies (`node devops/scale.mjs --bootstrap .env.bootstrap-<name>-pg18`) | `check` reads what it can, then asks you about the rest | |

If a check fails within the first hour and can't be fixed quickly, go back before real traffic builds up on the new database: `back`.

### After the checks (steps 35 to 40)

| Step | What | How | What `status` shows |
| --- | --- | --- | --- |
| 35 | Set the copies again, if step 7 noted more than one: `node devops/scale.mjs admin=<n> worker=<n> --max-connections 200 --bootstrap .env.bootstrap-<name>-pg18`, first with `--dry-run` | `finish` | The copies |
| 36 | Disconnect the old migrate, admin, worker and control panel from the repository, so a sync doesn't start them | `finish` (by hand: each one's **Settings** > **Source** > **Disconnect**) | |
| 37 | Turn on the new `Postgres`'s backups ([guide 5.2](../docs/deployment/guide/part-5-production.md#52-production-on-railway), step 16), and, if production has the nightly copy, set it up in the new project with `PG_VERSION=18` (steps 17 to 22) and stop the old one | `finish` for the backups; the nightly copy by hand | The schedule |
| 38 | Remove the temporary address from the new admin, and its records from Cloudflare | `finish` | The admin's addresses |
| 39 | Delete both TCP proxies | `finish` (by hand: **Postgres** > **Settings** > **Networking**) | None |
| 40 | A week later, if nothing needed going back, delete the old project, which deletes its backups too, and move the old three files into the backup folder. From then on, bootstrap and the scale script run with the `-pg18` files | `retire` | |

### Going back

`back` does these steps, and finds which way to go ([back](#back-g1-to-g9)).

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

Every step can run again. Bootstrap marks a step done only when it finishes, and finds what it made by ID or name rather than making it twice. `redeploy.mjs`'s commands record a step the same way, and carry on from the first one not recorded. If you have to stop for the day anywhere from step 24 to step 29, go back rather than leave production offline: `back` does G1 to G3, and the next attempt runs `cutover` from step 22 again.

- **R1.** If the `-pg18` files are lost or broken, put the newest backed-up copies back: `after-cutover` if step 31 made it, else `after-stage-1`, from which step 30 runs again in full. `recover` does this ([recover](#recover-r1)).
- **R2.** A lock left behind by a closed window is taken over by the next run, as bootstrap does, and so is one of `redeploy.mjs`'s. If bootstrap or `redeploy.mjs` says another run is using a file and none is, delete the `.lock` file it names.

## The SQL the copy runs

Four files in the backup folder, which `prepare` writes at step 4 and psql reads with `-f`: pasted into psql's prompt, a block can arrive as one line, and a leading command then swallows the rest.

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

`hours.sql` counts production's calls in each hour of the day over the last four weeks, in the time zone psql is given as `tz`, such as `psql -v tz=America/Vancouver -f hours.sql`, to pick the hour (step 21). `trial` runs it with your computer's time zone.

```sql
select to_char(started_at at time zone :'tz', 'HH24') || ' ' || count(*)
from calls
where started_at > now() - interval '28 days'
group by 1
order by 1;
```

The dump runs as `postgres`, through the old database's TCP proxy, with the password from bootstrap's state file, which is the same in both projects since the copy's state file came from the original. The restore's flags: `-O` gives every object to `postgres`, which owns them in production too; `-1` restores in one transaction and `-e` stops at the first error, so a restore finishes whole or leaves the database empty. The roles are already in the new database, with production's passwords: migrate made them in step 13.

## Files and secrets

| File | What | Who writes it |
| --- | --- | --- |
| `.env.bootstrap-<name>`, `.secrets`, `.state.json` | The deployment's settings, keys and state, which keep describing the old project until step 40 | Bootstrap. `redeploy.mjs` only reads them, and `retire` moves them into the backup folder |
| `.env.bootstrap-<name>-pg18`, and its `.secrets` and `.state.json` | The new project's, made by copying the three (step 8) | `prepare` or you, then bootstrap. `prepare` also sets the copy's address (step 9) and, if production's differs, its `OPENAI_WEBHOOK_SECRET` (step 16, and `cutover` again before step 32); `cutover` puts the address back (step 30), and `recover` the backed-up copies (R1) |
| `.env.bootstrap-<name>.redeploy.json` | The notes: the address's DNS records, the copies of the admin and the worker, the old project's ID and when they were noted; the backup folder; and each step the commands finished, when, and how long it took, with what later steps need, such as the Railway backup's ID, the temporary address, the rehearsal's and the trial's times, the TCP proxies the script opened, and the cutover's: the two servers' identities, the deployments it removed, when production went offline and the release it ran, the dump, and the checks' answers; and each time the move went back. No key | `status` and the commands, readable only by your account where the system allows |
| `.env.bootstrap-<name>.redeploy.json.lock` | Held while the notes are written, and by every command but `status` and `schema` for its whole run; taken over from a run that's gone | `redeploy.mjs` |
| `.env.bootstrap-<name>.redeploy.log` | What each run of the commands printed, secrets hidden, and the commands it ran with their exit codes | The commands, readable only by your account where the system allows |
| The backup folder | The three files; the SQL files; `<the address's first part>-files`, the bucket's files; `after-stage-1`, and from step 31 `after-cutover`; the cutover's dump, `<the address's first part>.dump`, and `count-old.txt` (step 25); after `recover`, `replaced-<time>`, the copy's files it replaced; and after step 40, `old-project-files`. `trial`'s dump is deleted when it's done. It holds every key and production's data, so keep it to your account and out of the checkout | `prepare`, `trial`, `cutover`, `recover`, `retire` and you |

`status` and `prepare` read the variables of migrate, the admin, the worker and the control panel, which hold keys, to compare them, and print none of them: they hide any value of a variable whose name ends like a key's, such as `_KEY`, `_SECRET`, `_TOKEN`, `_PASSWORD`, `DATABASE_URL` and `REDIS_URL`, and any text shaped like a key, as bootstrap does. `prepare` copies a value from an old service to a new one through Railway's API (step 16), and writes one key into a file: production's `OPENAI_WEBHOOK_SECRET`, into the copy's `.secrets` file. `cutover` reads the old admin's `FLEET_STATUS_TOKEN` to ask the old workers about calls in progress (step 24), and sends it only to the old admin's address. The Railway token reaches bootstrap and the scale script, the bucket's keys the AWS CLI, and the database's password Docker, each through its environment only, and none of them is saved.

## Railway's API

The script calls Railway's public API, `backboard.railway.com/graphql/v2`, as bootstrap and the scale script do. Each run first checks every query and change it sends against Railway's schema, which Railway gives without a token: each field, argument and input it uses must still be there, and each argument Railway requires must be given. `status` names a change it finds and carries on, since it only reads; the commands that change something stop before they do, unless run with `--dry-run`.

```sh
node devops/redeploy.mjs schema
node devops/redeploy.mjs schema --save scripts/fixtures/railway-redeploy-schema.json
```

The first runs only that check, and exits with 1 if something changed. The second also writes the part of the schema the script uses into the file `scripts/redeploy.test.ts` checks the script's queries against, so CI checks them without the network. Run it after changing a query, and commit the file with the change.

## What isn't confirmed

None of this has met Railway or Cloudflare yet; the stand-ins answer as Railway's schema and Cloudflare's API describe. Before production, run the whole move on a deployment set up for the purpose. One that bootstrap builds today runs PostgreSQL 18 already, so run `prepare`, `trial` and `cutover` on it with `--same-version`, then `check`, and `back` once, `cutover` again and `finish`. Check, with `status` and in Railway's dashboard:

- **That an account or workspace token reads both projects,** their variables and their buckets.
- **The copies,** read as `devops/scale.mjs` reads them, from the latest deployment's settings, which hasn't met Railway either.
- **The backup (step 5):** made through the API and followed through Railway's workflow, then locked, taken to be one with no end date: Railway's lock removes it, so the schedule never deletes the backup.
- **The buckets:** the keys Railway's API gives (`bucketS3Credentials`), `aws s3 sync` with them, the files and sizes Railway shows (`bucketInstanceDetails`), and how soon they show a copy just made.
- **The rename (step 10),** and that `up` then makes a new project rather than finding the old one.
- **The new `Postgres`'s log line** that names its version (step 15).
- **The variables copied (step 16),** and that Railway deploys each service again with them.
- **A deployment removed (step 17):** the new `cloudflared` stops, and stays stopped.
- **The rehearsal (step 19):** an address added to an admin and removed, the records Railway asks for, how soon it verifies them, and how soon a name taken off one project is free for another.
- **The TCP proxies (steps 20 and 39):** opened and closed through the environment's settings without a deploy, and whether `Postgres` restarts when one opens. If one never opens, add it by hand: **Postgres** > **Settings** > **Networking** > **TCP Proxy**, port 5432.
- **Stopping and starting services (steps 23, 24, 30, G2, G4 and G7):** a deployment removed, and deployed again on the image it ran (`deploymentRedeploy` with `usePreviousImageTag`), or where Railway won't, a new one from the service's source (`serviceInstanceDeployV2`). Also whether the variables `up` sets at step 30 deploy the stopped new admin and worker by themselves: the script starts whichever is still stopped afterwards.
- **Railway's Redeploy (steps 29, G3 and G8),** through `serviceInstanceRedeploy`, and that it runs migrate's pre-deploy again.
- **The calls in progress (step 24):** the old workers' count through the fleet status address, which needs the old admin's `FLEET_STATUS_TOKEN` (fork PR #185), else the old database's count of calls not ended.
- **The address move (step 30) and going back (G5):** how soon Railway lets one project have an address the other just gave up, which step 19 times, and the check record Railway asks for when the address returns to the old admin.
- **The worker's log (step 34):** each line's severity, as Railway gives it.
- **The disconnect (step 36)** and **the backup schedule (step 37).**
- **The project's deletion (step 40),** with Railway's 48 hours' grace.
- **The sealed variables,** taken from the environment's list of variables, which gives each one's name and whether it's sealed.
- **The release,** from the latest deployment's commit and branch.
- **Cloudflare's records,** read and written with bootstrap's token.
- **On Windows:** `icacls` on the backup folder, and Docker given the folder's Windows path.
