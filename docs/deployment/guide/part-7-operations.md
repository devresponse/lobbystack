# Part 7. Operational procedures

**Status:** written on 2026-10-19 from the code on `main` at `d18f916`, and from the documentation of Railway, Docker, the server providers and the other services as read that day. [7.4](#74-deploy-without-cutting-off-calls)'s goodbye on a server and [7.13](#713-costs-and-usage-limits)'s browser call length were updated on 2026-10-20 for fork PR #54 (`9b66d01`), and the Polar lines in [7.12](#712-alerts-and-how-to-respond), [7.18](#718-rotate-secrets-and-keys) and [7.23](#723-change-the-domain-or-the-brand) on 2026-10-22 for fork PR #59 (`a44f995`), and [7.12](#712-alerts-and-how-to-respond) and [7.18](#718-rotate-secrets-and-keys) again for fork PR #60 (`a6ff674`), and [7.12](#712-alerts-and-how-to-respond) for fork PRs #61 (`b6ba2aa`) and #66 (`d800141`), and [7.12](#712-alerts-and-how-to-respond) and [7.18](#718-rotate-secrets-and-keys) for fork PR #69 (`91d5c3a`), and [7.3](#73-database-migrations) for fork PR #70 (`fa0aa11`), and [7.11](#711-logs-error-ids-and-following-one-call), [7.12](#712-alerts-and-how-to-respond), [7.16](#716-worker-crash-and-stuck-calls) and [7.18](#718-rotate-secrets-and-keys) on 2026-10-24 for fork PR #71 (`1d4c172`), and [7.11](#711-logs-error-ids-and-following-one-call), [7.12](#712-alerts-and-how-to-respond) and [7.18](#718-rotate-secrets-and-keys) the same day for fork PR #72 (`cc0c65d`), and [7.12](#712-alerts-and-how-to-respond), [7.22](#722-upgrade-pinned-versions) and [7.25](#725-routine-maintenance-calendar) for fork PR #73 (`35af54b`), and [7.12](#712-alerts-and-how-to-respond), [7.14](#714-incident-basics-who-acts-what-to-check-first-how-to-tell-users), [7.18](#718-rotate-secrets-and-keys) and [7.25](#725-routine-maintenance-calendar) for fork PR #74 (`7d20322`), and [7.12](#712-alerts-and-how-to-respond) and [7.16](#716-worker-crash-and-stuck-calls) for fork PR #75 (`24e211d`), and [7.3](#73-database-migrations) for fork PRs #71, #72 and #75 at `24e211d`, and [7.11](#711-logs-error-ids-and-following-one-call) on 2026-10-25 for fork PR #79, and [7.3](#73-database-migrations) and [7.9](#79-data-retention-and-deletion-requests) on 2026-10-26 for fork PR #84, and [7.23](#723-change-the-domain-or-the-brand)'s brand order on 2026-10-27 for fork PR #87, and [7.3](#73-database-migrations) the same day for fork PR #89, and [7.22](#722-upgrade-pinned-versions)'s Node.js version on 2026-10-28 for fork PR #90, and its pnpm version the same day for fork PR #91, and [7.23](#723-change-the-domain-or-the-brand)'s Zapier step the same day for fork PR #94, and its Make step for fork PR #95, and [7.11](#711-logs-error-ids-and-following-one-call)'s `live.incoming` line on 2026-10-29 for fork PR #99, and [7.9](#79-data-retention-and-deletion-requests), [7.18](#718-rotate-secrets-and-keys) and [7.19](#719-manage-operators-api-keys-and-platform-keys) on 2026-10-30 for fork PR #101, which deletes a business, and [7.9](#79-data-retention-and-deletion-requests) and [7.27](#727-reactivate-a-canceled-business) the same day for fork PR #102, which cancels an account. A run of migrate against a throwaway database checked how a failed migration behaves ([7.3](#73-database-migrations)). Nothing else in this part has been run on a deployed instance yet, so where a provider's docs don't name a control, it's marked *(not confirmed)*.

These are the jobs that keep an instance working once it's live. Most steps come in two versions, **On Railway** and **On a server**, for the two ways production runs ([5.2](part-5-production.md#52-production-on-railway), [5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose)).

| When | Go to |
| --- | --- |
| A new version is ready on `main` | [7.1](#71-release-a-new-version) |
| A release went wrong | [7.5](#75-roll-back-a-bad-release) |
| A setting must change | [7.6](#76-change-a-setting-safely) |
| The regular checks: every day, week, month and year | [7.25](#725-routine-maintenance-calendar) |
| Something stopped working | [7.14](#714-incident-basics-who-acts-what-to-check-first-how-to-tell-users) |
| A secret may have leaked | [7.18](#718-rotate-secrets-and-keys) |
| Someone leaves a team, or a key must go | [7.19](#719-manage-operators-api-keys-and-platform-keys) |
| A person asks for their data, or to be deleted | [7.9](#79-data-retention-and-deletion-requests) |
| A business wants another number, or to give one back | [7.21](#721-buy-change-and-release-numbers) |
| The instance moves to another address | [7.23](#723-change-the-domain-or-the-brand) |
| The instance closes | [7.26](#726-shut-down-an-instance) |
| An owner who canceled their account wants it back | [7.27](#727-reactivate-a-canceled-business) |
| A test environment should start again with no data | [7.28](#728-reset-a-test-environment) |

**Signing in to the database**

A few steps read or change the database directly. They're for someone technical, who signs in as `postgres`, the database's administrator:

- **On Railway:** open the `Postgres` service's **Console** tab, a shell in the browser. Or, on a computer with Railway's command-line tool and an SSH key registered with Railway ([7.8](#78-restore-from-a-backup-and-practice-it)), run `railway ssh --service Postgres --environment production`. Then run `psql -U postgres -d lobbystack`.
- **On a server:** in `/root/lobbystack`, run `docker compose exec postgres psql -U postgres -d lobbystack`.

Inside its own service, `postgres` needs no password. Type `\q` to leave. Before a statement that changes or deletes rows, make a backup ([7.7](#77-back-up-the-database-and-files)), and try the statement on the test environment first.

## Releases and changes

### 7.1 Release a new version

A release puts a version that already runs on the test environment into production. Production follows the `production` branch ([5.2](part-5-production.md#52-production-on-railway), step 7), so moving that branch to a newer commit is the release. On Railway, production then deploys by itself; on a server, you update it (step 8).

**Choose and try the version**

1. On GitHub, open `github.com/<owner>/lobbystack/commits/main` and find the commit to release. It must show a green check mark, which means its checks passed ([1.4](part-1-prepare.md#14-get-the-code)). Don't release a commit with a red cross.
2. Check that the test environment runs that commit: `https://<test address>/api/health/live` shows it as `"version"`. Every push to `main` deploys there by itself ([4.10](part-4-test-environment.md#410-keep-the-test-environment-up-to-date)).
3. Try it there. Repeat the steps of the smoke test ([4.9](part-4-test-environment.md#49-smoke-test)) that the change touches, and always these: sign in, a browser call, a call to a test number, and a chat on a public profile page. A change to how calls behave also gets `pnpm voice:call` against the test environment first (`docs/voice/testing.md`).
4. See what the release brings: open `github.com/<owner>/lobbystack/compare/production...<commit ID>`, with the commit's ID. It lists every commit and every changed file since the last release.
   - A changed file under `packages/db/migrations/` means the release changes the database. Read [7.3](#73-database-migrations) before you go on.
   - A changed `.env.example` means the release brings new settings. Read what each new line does, and set the ones production needs before you move the branch. On Railway, set them, then hold **Alt** while you click **Deploy**, which saves them for the release without deploying anything ([7.6](#76-change-a-setting-safely)). On a server, add them to `.env`, and to your override file if `docker-compose.yml` doesn't name them ([7.6](#76-change-a-setting-safely)).
5. Choose the hour.
   - On Railway, calls in progress keep running through a release ([7.4](#74-deploy-without-cutting-off-calls)). If the release changes the database, still choose a time when few people call. Avoid 03:00 UTC, when the nightly copy runs ([5.2](part-5-production.md#52-production-on-railway), step 21).
   - On a server, every release ends the calls in progress and stops the dashboard for a few minutes ([7.4](#74-deploy-without-cutting-off-calls)), so choose an hour when nobody calls. Each business's **Calls** page shows a call that's still going as **In progress**.

**Move the branch**

6. In a terminal, in the copy of the code on your computer ([Part 2](part-2-local-development.md)), run:

   ```sh
   git fetch origin
   git push origin <commit ID>:production
   ```

   - The full commit ID and its first seven characters both work.
   - If git answers `rejected` and `non-fast-forward`, `production` holds a commit that the new one doesn't include, as after a move backwards ([7.5](#75-roll-back-a-bad-release)). Check the compare page from step 4 first, then add `--force` only if that's what you meant: `git push --force origin <commit ID>:production`.
   - Never commit to `production` directly, and don't merge pull requests into it: GitHub's merge buttons all make new commits, which no check ran on ([5.2](part-5-production.md#52-production-on-railway), step 2).

**On Railway: watch the deploy**

7. In the Railway project, switch the environment menu to `production`. Railway deploys migrate, the admin and the worker from the new commit, each on its own.
   - A deployment that waits for approval means Railway doesn't know the GitHub account that pushed ([4.10](part-4-test-environment.md#410-keep-the-test-environment-up-to-date)). Click **Approve** only if that push was yours.
   - migrate's log should end with `RLS enabled and forced on <n> tables.`, as in [4.5](part-4-test-environment.md#45-add-the-migrate-service-and-set-up-the-database), step 6.
   - The admin's and the worker's newest deployments should show **Active**. If the release changes the database and either of them finished before migrate, redeploy it ([7.3](#73-database-migrations)).
   - The old worker keeps running until its calls end, for up to about 31 minutes ([7.4](#74-deploy-without-cutting-off-calls)).

**On a server: update it**

8. Sign in with `ssh root@<the server's IP address>`, and run the update from [5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose), "From now on":

   ```sh
   cd /root/lobbystack
   REPLACEMENT_COMPOSE_PROJECT=lobbystack bash scripts/replacement-backup.sh
   git pull --ff-only
   export SERVICE_VERSION=$(git rev-parse --short HEAD)
   docker compose build
   docker compose run --rm migrator
   docker compose up -d
   ```

   - The backup comes first, so that a release that damages data can go back to it ([7.8](#78-restore-from-a-backup-and-practice-it)). It stops the admin and the worker while it runs.
   - `git pull --ff-only` refuses when `production` moved backwards. Use the commands in [7.5](#75-roll-back-a-bad-release) then.
   - `docker compose build` builds the new version while the old one keeps running. On a server with 4 GB of memory, build one image at a time, as in [5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose), step 19.
   - `docker compose run --rm migrator` applies the release's migrations, if it has any, and should end with `Database migrations applied.` If it fails, stop there: the old version keeps running, and [7.3](#73-database-migrations) says what to do.
   - `docker compose up -d` then replaces the admin and the worker, which ends the calls in progress ([7.4](#74-deploy-without-cutting-off-calls)).
   - Then do the checks in [5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose), steps 20 to 22.

**Check it and write it down**

9. Open `https://app.example.com/api/health/live`: its `"version"` should start with the new commit's ID. `https://app.example.com/api/health/ready` should show `"ok":true`. Then sign in, and make one browser call.
10. Write the release down: the date, the commit ID, and a line on what changed. Keep the list with your worksheet ([1.2](part-1-prepare.md#12-your-worksheet-and-keeping-secrets-safe)). [7.5](#75-roll-back-a-bad-release) uses it to find the version to go back to.

### 7.2 Pause automatic deploys

On Railway, each push to the branch a service follows deploys it at once. Pause that on the test environment while `main` takes several changes that only work together, or while you look into a problem there and don't want a deploy to change what you're looking at. Production deploys only when you move its branch, so it rarely needs a pause.

1. Switch the environment menu to the environment to pause.
2. On migrate, the admin and the worker, open **Settings**, and in the source settings click **Disable** next to automatic deploys *(the section's name not confirmed)*. Pause all three: with migrate paused alone, the admin and the worker would deploy new code onto the old database.
3. To resume, click **Enable** on all three. Railway may not go back for the commits pushed during the pause *(not confirmed)*. On test, open the command palette (Ctrl+K, or Cmd+K on a Mac) on migrate, choose **Deploy Latest Commit**, and once migrate has finished, do the same on the admin and the worker.
   - Don't use **Deploy Latest Commit** on production ([5.2](part-5-production.md#52-production-on-railway), "From now on"), and don't move `production` while its deploys are paused.

On a server, nothing deploys by itself: only the update in [7.1](#71-release-a-new-version), step 8 changes what runs.

### 7.3 Database migrations

A migration is a file of changes to the database's tables, in `packages/db/migrations/`. Releases bring new ones, and migrate applies them: on Railway at each deploy ([4.5](part-4-test-environment.md#45-add-the-migrate-service-and-set-up-the-database)), on a server during the update ([7.1](#71-release-a-new-version), step 8). Each file runs once, in order, and the database records which ones ran, so running migrate again is always safe.

**How migrations behave**

- Each file runs whole or not at all, together with its record, so the database is never left halfway through a file (`packages/db/src/cli.ts:394-405`). The five files that build an index without blocking writes, such as `0123` and `0127` (fork PR #93), run outside a transaction instead: when a build fails, the next run removes the broken index and builds it again (`packages/db/src/cli.ts:373-393`). Two runs never overlap: a second one waits for the first, then finds nothing left to do.
- Nothing undoes a migration. A rollback ([7.5](#75-roll-back-a-bad-release)) puts back the previous version of the code, which keeps working with the new tables only because each migration must keep working with the version before (`.railway/README.md:33`). Nothing checks that, so a release with migrations is the riskiest kind.
- The admin and the worker don't check that the migrations ran, so new code on the old tables can fail while every health check stays green. A release that adds a column the sign-in reads, for example, would probably fail every sign-in until migrate has run.
- Thirteen of the files give up after 5 seconds when the running app holds a lock they need, rather than make the app wait behind them: `0057`, `0070` and `0090`, the billing files `0114`, `0115` and `0116` (fork PRs #71, #72 and #75), `0117` and `0118`, for the email after each call and the notice after a call's greeting (fork PR #84), `0119`, which shows a yearly price's month in whole dollars (fork PR #89), and `0122`, `0124`, `0125` and `0126`, the original project's database fixes (fork PR #93). A busy hour makes that likelier.

**Before a release that changes the database**

1. Try it on the test environment first, as every release ([7.1](#71-release-a-new-version)), and check migrate's log there as in step 5.
2. Back up production: on Railway, a backup made by hand and locked ([7.7](#77-back-up-the-database-and-files), "Before a risky change"); on a server, the update makes one ([7.1](#71-release-a-new-version), step 8).
3. Choose a quiet hour. On Railway, avoid 03:00 UTC, when the nightly copy runs ([5.2](part-5-production.md#52-production-on-railway), step 21).

**On Railway**

4. Move the branch ([7.1](#71-release-a-new-version), step 6). Railway deploys migrate, the admin and the worker each on its own: the admin and the worker don't wait for migrate.
5. Open migrate's newest deployment and read its log *(where it shows the pre-deploy command's lines: not confirmed)*. It should show `Applied migration <file>.` for each new file, then `Database migrations applied.` and the other lines of [4.5](part-4-test-environment.md#45-add-the-migrate-service-and-set-up-the-database), step 6, ending with `RLS enabled and forced on <n> tables.` A file that repairs data adds a line saying what it changed, such as `Promo codes: <n> uses by a business recorded.` from `0113` (fork PR #70), or, from fork PR #93, `Users: <n> unused password hash copies cleared.` (`0121`) and `Expired calls: <n> session and <n> conversation summaries cleared.` (`0126`). A line starting `Skipping the` instead means that repair didn't run, because migrate didn't sign in as `postgres` ([4.5](part-4-test-environment.md#45-add-the-migrate-service-and-set-up-the-database), step 2).
6. If the admin's or the worker's newest deployment went live before migrate finished (compare the times in their **Deployments** tabs), redeploy it: that deployment's menu (the three dots), then **Redeploy**. Since fork PR #93, a worker that started first logs `startup scheduling failed` and skips the summaries and re-embedding it queues at startup until then (`apps/worker/src/index.ts:234-280`).

**On a server**

7. The update applies the migrations before it replaces anything ([7.1](#71-release-a-new-version), step 8). `docker compose run --rm migrator` shows `Applied migration <file>.` for each new file, and should end with `Database migrations applied.`

**If a migration fails**

The log shows `Applied migration <file>.` for each file that ran first, then `Failed query:` followed by the whole text of the failing file, then a line `params: `, and nothing more. On Railway, migrate's deployment shows **Failed**; on a server, the command stops there.

8. Know where the database stands: every file before the failing one is applied, and the failing one isn't, at all.
   - **On a server,** nothing else has changed: the old version keeps running.
   - **On Railway,** the admin and the worker go live anyway, on the partly migrated database *(from Railway's docs; not seen on a real failure)*. If users report problems, roll both back and move the branch back ([7.5](#75-roll-back-a-bad-release)).
9. Find the reason. migrate's log doesn't have it; PostgreSQL's log does. On Railway, open the `Postgres` service's log around that time; on a server, run `docker compose logs --since 30m postgres`. Look for a line with `ERROR:`, just before a line with `STATEMENT:` that starts like the failing file.
10. Act on what the `ERROR:` line says:

    | It says | What to do |
    | --- | --- |
    | `canceling statement due to lock timeout`, or `canceling statement due to statement timeout` | Run it again at a quieter hour: on Railway, **Redeploy** on migrate's failed deployment; on a server, `docker compose run --rm migrator`, then `docker compose up -d` |
    | `password authentication failed`, or another connection error | Fix the password or the address ([4.6](part-4-test-environment.md#46-add-the-admin-and-the-worker), "If the first deploy fails"), then run it again the same way |
    | Anything else, such as data the migration doesn't expect | A developer fixes it in a new commit, which goes through the test environment and [7.1](#71-release-a-new-version) like any release |

11. Afterwards, check migrate's log as in step 5 or 7, then `/api/health/ready`, a sign-in and a test call. On Railway, redeploy the admin and the worker if they went live before migrate (step 6).

A rerun starts with three harmless notices, such as `relation "__lobbystack_migrations" already exists, skipping`. Then it skips each file that already ran, and runs the failed one from the start.

**Never**

- delete rows from `__lobbystack_migrations`, the table that records which files ran;
- edit a migration that already ran: migrate skips it, with a warning that its checksum changed, so the edit never runs;
- run migrate's `reset-test` command, which deletes every table.

### 7.4 Deploy without cutting off calls

**On Railway** nothing needs doing on each release. The worker's `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=1860` ([4.6](part-4-test-environment.md#46-add-the-admin-and-the-worker)) does it:

- Railway starts the new worker, waits until its health check passes, then asks the old one to stop. New calls go to the new worker, and the old one keeps the calls it has until they end. A call can't last more than 30 minutes, so each one ends on its own, and none is cut short (`apps/worker/src/liveCalls.ts:156-162`, `packages/shared/src/index.ts:30-33`). With no call in progress, the old worker stops at once.
- Check that the variable is still on production's worker after any change to its variables. Without it, every worker deploy cuts off the calls in progress, probably before the caller hears a goodbye.
- A deploy of the admin doesn't touch calls in progress: the sound goes between the caller and OpenAI, and the worker holds the call. Only a call that starts at the moment the new admin takes over can fail. OpenAI then sends a phone call to the admin again, and a browser caller tries again.
- A deploy of Postgres or Redis takes it away for up to about 2 minutes ([5.2](part-5-production.md#52-production-on-railway), "From now on"). Do those when few people call.

**On a server** every update and every nightly backup stops the worker, because only one runs. With the override file from [5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose), step 17:

- Each call in progress ends: at the next pause, within 10 seconds, the receptionist apologizes, asks the caller to call back in a minute, and says goodbye (`packages/agent-core/src/live/callController.ts:354`). The worker has 45 seconds for that.
- New calls fail until the new worker has started: a phone caller hears the line drop, and a browser call shows an error.
- So update when nobody calls ([7.1](#71-release-a-new-version), step 5). Don't lengthen the drain with `LIVE_DRAIN_TIMEOUT_MS`: the worker refuses new calls while it drains, so every new call would fail for that long too.

### 7.5 Roll back a bad release

Roll back first, and look for the cause afterwards: the failed version's logs stay available.

**Decide**

1. Check that the release is the cause: the problem started when the release went live, and the logs ([7.11](#711-logs-error-ids-and-following-one-call)) or users' reports point at something it changed. If an outside service is down instead, such as OpenAI or Twilio, a rollback won't help ([7.14](#714-incident-basics-who-acts-what-to-check-first-how-to-tell-users)).
2. If the release changed the database ([7.3](#73-database-migrations)), the database stays as the release left it: nothing undoes a migration. The older version keeps working with it, because each migration must keep working with the version before.

**On Railway**

3. Switch the environment menu to `production`. Open the admin, then its **Deployments** tab, and find the deployment from before the release: its commit is the previous one in your release list ([7.1](#71-release-a-new-version), step 10).
4. Open that deployment's three-dot menu, choose **Rollback**, and confirm. Railway puts back that deployment's image and its variables without building anything, so it takes seconds. Then do the same on the worker, so both run the same version. migrate needs no rollback.
   - Railway keeps an old deployment's image for 120 hours after a newer one replaces it, on the Pro plan. After that, **Rollback** isn't offered: choose **Redeploy** on the old deployment instead, which builds the same code again and takes as long as a release.
   - A rollback also brings back that deployment's variables. If you changed a variable or a key since then ([7.6](#76-change-a-setting-safely), [7.18](#718-rotate-secrets-and-keys)), set it again afterwards.
5. Then move the branch back too, so that the next deploy doesn't bring the bad version back. In a terminal:

   ```sh
   git fetch origin
   git push --force origin <the earlier commit ID>:production
   ```

   Railway then builds and deploys the earlier commit on all three services, which replaces the rolled-back deployments with the same version.

**On a server**

6. Move the branch back on your computer, as in step 5. Then sign in to the server and run:

   ```sh
   cd /root/lobbystack
   git fetch origin
   git reset --hard origin/production
   SERVICE_VERSION=$(git rev-parse --short HEAD) docker compose up -d --build
   ```

   `.env` and your two files from [5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose) stay as they are, because git doesn't track them. Then do the checks in [5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose), steps 20 to 22.
7. If the release damaged data, restoring the backup that [7.1](#71-release-a-new-version), step 8 made just before it is the way back ([7.8](#78-restore-from-a-backup-and-practice-it)). It throws away everything written since the release, so do it only when the data can't be fixed another way.

**Afterwards**

8. Check production as in [7.1](#71-release-a-new-version), step 9: `"version"` now shows the earlier commit. Note the rollback in your release list.
9. Fix the problem on `main`, try the fix on the test environment, and release it as usual ([7.1](#71-release-a-new-version)). The fixed version includes the bad release's commits, so its move is a normal one.

### 7.6 Change a setting safely

A setting is a variable on Railway, or a line in `.env` on a server. Each service reads its settings only when it starts, so a change does nothing until the service starts again with it.

**On Railway**

1. Check the environment menu, then open the service's **Variables** and change the value. Railway stages the change: nothing happens yet.
2. Click **Deploy** on the banner. Railway rebuilds and starts again every service the change affects, including the ones that refer to the value, such as the worker after a change of the admin's `APP_BASE_URL`.
   - To keep a change for the next release instead, hold **Alt** while you click **Deploy**. It's saved, and each service takes it at its next deploy.
   - **Restart** applies nothing: it starts the same build with the same settings.
   - Whether **Redeploy** on a deployment applies new values isn't confirmed: Railway's pages disagree. Use the banner's **Deploy**.
   - A change on `Postgres` or `Redis` takes it away for up to about 2 minutes ([5.2](part-5-production.md#52-production-on-railway), "From now on").
3. Check that each affected service's newest deployment shows **Active**, then `/api/health/ready`, then what you changed.

A rollback ([7.5](#75-roll-back-a-bad-release)) brings back the settings of the deployment you go back to, so set again any value you changed since.

**On a server**

1. `cd /root/lobbystack`, then `nano .env`, and change the line.
2. Run `docker compose up -d`. It recreates each service whose settings changed, within seconds. Recreating the worker ends the calls in progress ([7.4](#74-deploy-without-cutting-off-calls)), so pick a quiet hour.
   - A value built into the dashboard (below) needs `SERVICE_VERSION=$(git rev-parse --short HEAD) docker compose up -d --build` instead.
   - `docker compose restart` applies nothing.
3. Save the changed `.env` in the password manager ([5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose), step 25).

A line in `.env` reaches a service only when `docker-compose.yml` or your override file ([5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose), step 17) names it. To pass another one, add it under that service's `environment:` in the override file, written like the others, such as `FEEDBACK_TO_EMAIL: ${FEEDBACK_TO_EMAIL:-}`. Then run `docker compose up -d`, and check it with `docker compose exec admin printenv <NAME>`, or `worker` in place of `admin`.

**Values built into the dashboard**

`APP_BASE_URL`, `BRAND_PRESET`, `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, `NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN` and `NEXT_PUBLIC_POSTHOG_HOST`, and on Railway `STORAGE_PROVIDER` and the `S3_` values, are built into the admin, so only a rebuild applies them. On Railway, the banner's **Deploy** rebuilds; on a server, use the `--build` command above.

- `NEXT_PUBLIC_POSTHOG_HOST` is also read while the admin runs, so always rebuild after changing it. Otherwise the browser keeps sending to the old address, which the page then blocks unless it ends in `.posthog.com` (`apps/admin/csp.ts:7-20`).
- A change of `APP_BASE_URL` moves the instance to a new address: follow [7.23](#723-change-the-domain-or-the-brand).

**Values that must match on the admin and the worker**

On a server, the admin and the worker read the same line, so they match. On Railway, the worker's lines refer to the admin's ([4.6](part-4-test-environment.md#46-add-the-admin-and-the-worker)), so they match too, unless someone typed a value on the worker, or rolled back only one of the two ([7.5](#75-roll-back-a-bad-release)). During a **Deploy**, though, the two go live minutes apart, so change these at a quiet hour:

| Setting | While they differ |
| --- | --- |
| `LIVE_PROTOTYPE_ENABLED` | Off on the admin, calls are refused. Off on the worker, every call is answered, then hung up |
| `INTERNAL_SERVICE_TOKEN` | Every call is answered, then hung up, and the admin's log shows `Worker attach failed with status 401.` |
| `ENCRYPTION_KEY`, `OTP_HASH_SECRET` | Stored keys, calendar connections, webhook secrets and PINs stop working ([7.18](#718-rotate-secrets-and-keys)) |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | Texts and number purchases fail: both services must use production's subaccount |
| `TWILIO_STATUS_CALLBACK_URL` | The delivery status of texts never updates |
| The admin's `TWILIO_SMS_WEBHOOK_URL` | It must be the worker's `APP_BASE_URL` followed by `/api/webhooks/twilio/sms`, or every incoming text is refused |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` | Calendars stop syncing, so the receptionist takes messages instead of booking, and owners and admins may get the email "Calendar connection needs attention" ([8.9](part-8-troubleshooting.md#89-google-calendar)) |
| `BRAND_PRESET` | Emails and texts name another app than the dashboard |
| `CONTENT_RETENTION_ENABLED`, `CONTENT_RETENTION_POLICY_JSON` | Content is kept for two different periods ([7.9](#79-data-retention-and-deletion-requests)) |
| `REDIS_URL`, `REDIS_PREFIX` | The dashboard stops updating by itself |
| `STORAGE_PROVIDER` and the `S3_` values | One service can't read the files the other stored. Never change these once there are files: nothing moves them |
| `APP_BASE_URL` | Emails link to the worker's address, and a number bought meanwhile gets the worker's texting address: change it as in [7.23](#723-change-the-domain-or-the-brand) |
| Only if the instance sells plans: `TWILIO_ALERT_SMS_FROM` and Polar's values | Texts from the shared number, checkouts and plan changes can fail *(inferred)* |

Leave `LOBBYSTACK_MAINTENANCE_MODE` at `false`. It isn't a way to pause the instance: set to `true`, it refuses every call, text and change, and on Railway the worker's deploy then fails its health check, so the old worker keeps running (`docs/validation/readiness-progress-2026-09-13.md:103`).

**Not yet confirmed:**

- Everything for a server in [7.1](#71-release-a-new-version) and [7.3](#73-database-migrations), which hasn't been run on one, including that `docker compose run --rm migrator` leaves the old version running when a migration fails.
- Where Railway shows migrate's pre-deploy lines, and what a failed migration looks like there.
- Whether **Redeploy** applies changed variables, and whether a deploy after a variable change builds the running commit or the branch's newest.
- PostgreSQL's exact message when one of the three files meets a lock it can't get.
- The name of the automatic deploys setting ([7.2](#72-pause-automatic-deploys)), and whether Railway deploys the commits pushed during a pause.

**[7.1](#71-release-a-new-version) to [7.6](#76-change-a-setting-safely) were checked against:** `packages/db/src/cli.ts`, `packages/db/src/migrations/raw-migrations.ts`, the migrations `0057`, `0070`, `0090`, `0105`, `0113`, `0114`, `0115`, `0116`, `0117`, `0118`, `0119`, `0120` to `0127` and the five index files in `packages/db/migrations/`, `.railway/README.md`, `.github/workflows/ci.yml`, `docker-compose.yml`, `Dockerfile.admin`, `Dockerfile.migrator`, `apps/admin/instrumentation.ts`, `apps/admin/csp.ts`, `apps/admin/src/lib/live-prototype.ts`, `apps/admin/app/api/webhooks/openai/live/route.ts`, `apps/admin/app/api/webhooks/twilio/sms/route.ts`, `apps/worker/src/index.ts`, `apps/worker/src/liveCalls.ts`, `apps/worker/src/handlers.ts`, `packages/agent-core/src/live/callController.ts`, `packages/shared/src/maintenance.ts`, Railway's and Docker Compose's documentation, and Docker Compose's source at v2.40.3 and v5.5.0, as read on 2026-10-19. A run of migrate against a throwaway PostgreSQL 16 showed how a failed migration is reported and run again.

## Data protection

### 7.7 Back up the database and files

LobbyStack keeps its data in three places, and each one needs a copy of its own:

| What | Where it lives | Its copies on Railway | Its copies on a server |
| --- | --- | --- | --- |
| The database: accounts, businesses, contacts, calls, transcripts, messages and settings | `Postgres` | Railway's scheduled backups ([5.2](part-5-production.md#52-production-on-railway), step 16), and the nightly copy at Cloudflare ([5.2](part-5-production.md#52-production-on-railway), steps 17 to 22) | The nightly backup on the server ([5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose), step 27), the provider's backups of the whole server, and your weekly download ([5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose), step 28) |
| Files: the documents uploaded under **Knowledge**, and call recordings | Railway's bucket, or the server's disk | None, until you copy the bucket (below) | The same nightly backup |
| Passwords and secrets | Railway's variables, or `.env` | Production's password manager entry ([5.2](part-5-production.md#52-production-on-railway), step 3) | Production's password manager entry ([5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose), step 25) |

Redis needs no copy. It holds jobs waiting to run, sign-in sessions that PostgreSQL also keeps, and caches. If it's lost, the jobs that were waiting never run; restart the worker then, so that it sets up its schedules again.

On Railway, never use **Wipe Volume** on production's `Postgres` or `Redis`: it deletes the volume's data and its backups together ([4.10](part-4-test-environment.md#410-keep-the-test-environment-up-to-date)).

**Every week, check that the copies happen**

On Railway:

1. Open production's `Postgres` > **Backups**: the newest backup should be from the last day.
2. Open the backup service's **Cron Runs** tab and the newest run's log. It should start with `pg_dump (PostgreSQL) 16.` and end with `Database backup complete, exiting...`, with no `Potential warnings detected`.
3. In Cloudflare, open the backup bucket. Last night's file should be there, about the size of the one before. A much smaller file is a copy that stopped partway.

On a server:

1. `tail -n 3 /var/log/lobbystack-backup.log` should end with `Replacement backup created:` and last night's date.
2. `df -h /` should show room for at least two more backups.
3. Download the newest backup to your computer ([5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose), step 28).

**Before a risky change**

Before a release that changes the database ([7.3](#73-database-migrations)), a restore, or a change of PostgreSQL's version ([7.22](#722-upgrade-pinned-versions)):

- **On Railway:** open `Postgres` > **Backups**, create a backup *(the button's name not confirmed)*, and once it's listed, choose **Lock** from its three-dot menu, so that the schedule doesn't delete it. A backup made by hand can hold at most half the volume's size. Delete it once you no longer need it.
- **On a server:** the update commands already make a backup first ([7.1](#71-release-a-new-version), step 8).

**Copy the files on Railway**

Railway keeps no backups of a bucket and no earlier versions of a file, so a file deleted or replaced there is gone (Railway's bucket docs). Copy the bucket to your computer every week:

1. Install the AWS command-line tool, from AWS's own install page, on the computer that will keep the copy. It works with any bucket that follows Amazon's S3 conventions, Railway's included. Keep the copy on an encrypted disk: it holds every business's recordings and files.
2. In Railway, open production's bucket, then its **Credentials** tab, and note `BUCKET`, `ENDPOINT`, `ACCESS_KEY_ID` and `SECRET_ACCESS_KEY`.
3. In a terminal (on Windows, Git Bash), in the folder that will hold the copy, run these with those values:

   ```sh
   export AWS_ACCESS_KEY_ID='<ACCESS_KEY_ID>'
   export AWS_SECRET_ACCESS_KEY='<SECRET_ACCESS_KEY>'
   export AWS_DEFAULT_REGION=auto
   aws s3 sync s3://<BUCKET> ./lobbystack-files --endpoint-url <ENDPOINT>
   ```

   - The first run copies everything; each later run copies only what's new or changed.
   - Never add `--delete`: it would remove from your copy each file that was deleted on Railway.
   - Downloading from a Railway bucket costs nothing.
   - If it stops with an error about a checksum, run `export AWS_REQUEST_CHECKSUM_CALCULATION=WHEN_REQUIRED` and `export AWS_RESPONSE_CHECKSUM_VALIDATION=WHEN_REQUIRED`, then the `sync` line again.

### 7.8 Restore from a backup, and practice it

A restore puts the data back as it was when the copy was made, and loses everything written since. Restore the database and the files from the same moment, with the same secrets: the database names each file, and the secrets unlock what it stores ([1.3](part-1-prepare.md#13-decide-these-before-any-data-exists)).

| What happened | What to restore |
| --- | --- |
| On Railway, a mistake in the data, such as a bad migration or a deletion | A Railway backup (below) |
| On Railway, the project or the database's volume is gone | The copy at Cloudflare (below) |
| On a server, a mistake in the data | A nightly backup on the server (below) |
| The server is gone | A downloaded backup, on a new server (below) |

Never restore production's data into the test environment or another copy of LobbyStack that's running. Its worker would carry out production's waiting texts, emails and reminders, to real people, with the other copy's accounts *(inferred)*.

**On Railway: restore a Railway backup**

1. Choose a quiet hour. When the restore goes live, the database goes away for up to about 2 minutes, and the dashboard, the chat and calls fail meanwhile.
2. Open production's `Postgres` > **Backups**, find the backup by its date, and click **Restore**. Railway prepares a new volume from it, which takes from a few seconds to a few minutes. Production keeps running meanwhile.
3. Click **Details** on the staged-changes banner, check that the restore is the only change, and discard anything else with its **x**. Then click **Deploy**.
4. Once `Postgres` shows **Active**, redeploy migrate (its newest deployment's three-dot menu, then **Redeploy**). It sets the database roles' passwords back to the current values and checks the database ([4.5](part-4-test-environment.md#45-add-the-migrate-service-and-set-up-the-database)). Then redeploy the admin and the worker the same way.
5. Check production as in [7.1](#71-release-a-new-version), step 9, and look at a few records you know, such as the last calls listed.
6. The volume you restored over stays in the project, no longer attached, and keeps costing its storage. Keep it until the restored volume has made its own next backup, then delete it.

Restoring the bucket isn't possible this way: Railway keeps no backups of it ([7.7](#77-back-up-the-database-and-files)).

**On Railway: restore the copy from Cloudflare**

Not tried. It needs a terminal and Railway's command-line tool, so it's a job for someone technical. Practice it on the test environment first (below).

1. Rebuild what's missing, with [Part 4](part-4-test-environment.md) and [5.2](part-5-production.md#52-production-on-railway). Use production's existing passwords and secrets from the password manager, not new ones.
2. Let migrate deploy once on the new, empty database: it creates the seven database roles that the copy needs. Then stop the admin and the worker: on each, open the newest deployment's three-dot menu and choose **Remove**.
3. In Cloudflare, open the backup bucket, then the newest copy's three-dot menu, and click **Download**.
4. Copy the file into the Postgres service, then replace the empty database with the copy. Railway's SSH access needs its command-line tool and an SSH key registered with Railway. With `Postgres` open in production, the command palette (Ctrl+K) offers **Copy Service Instance ID**:

   ```sh
   scp <the file> <the service instance ID>@ssh.railway.com:/tmp/
   railway ssh --service Postgres --environment production -- sh -c 'dropdb -U postgres lobbystack && createdb -U postgres lobbystack && gunzip -c /tmp/<the file> | pg_restore -U postgres -d lobbystack --no-owner --single-transaction'
   ```

   With `--single-transaction`, the restore either finishes or changes nothing.
5. Redeploy migrate, which applies any migration the copy is missing and checks the database. Then redeploy the admin and the worker: in each one's **Deployments** tab, open the deployment you removed and choose **Redeploy**.
6. If the bucket was lost too, copy your files back into the new one, using the new bucket's **Credentials**: the command from [7.7](#77-back-up-the-database-and-files) with the two places swapped, `aws s3 sync ./lobbystack-files s3://<BUCKET> --endpoint-url <ENDPOINT>`.
7. Check production as in [7.1](#71-release-a-new-version), step 9.

**On a server: restore a nightly backup**

1. Sign in, and list the backups by date and time: `ls /root/lobbystack/.replacement-backups`.
2. Restore the one you choose:

   ```sh
   cd /root/lobbystack
   REPLACEMENT_COMPOSE_PROJECT=lobbystack CONFIRM_REPLACEMENT_RESTORE=1 bash scripts/replacement-restore.sh .replacement-backups/<the folder>
   ```

   It checks the backup's files before it changes anything, then stops the admin and the worker, replaces the database and the files, empties Redis, and starts them again. It ends with `Replacement backup restored:`. If it stops partway, the admin and the worker stay stopped: fix what it names, and run it again.
3. Run `docker compose up -d`, which applies any migration the backup is missing, then do the checks in [5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose), steps 20 to 22.

**On a new server, when the old one is gone**

1. Do [5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose), steps 1 to 12, pointing the domain at the new server's address in step 5.
2. Instead of step 13, put back the `.env` saved in your password manager ([5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose), step 25): `nano .env`, paste it, and save. Recreate your two files from [5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose), steps 16 and 17.
3. Do [5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose), steps 18 to 21. Starting the stack once makes the database roles that the backup needs.
4. Copy the newest backup up from your computer: `scp -r <the backup folder> root@<the server's IP address>:/root/lobbystack/.replacement-backups/`.
5. Restore it as above, then set up the nightly backups again ([5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose), step 27).

**Practice**

Only a restore proves that a copy is complete. Put a practice in your maintenance calendar every three months ([7.25](#725-routine-maintenance-calendar)):

- **On Railway:** on the test environment, restore its newest Railway backup, as above. To practice the copy at Cloudflare as well, give the test environment the same nightly copy into a bucket of its own ([5.2](part-5-production.md#52-production-on-railway), steps 17 to 22), and restore test's copy into test.
- **On a server:** the drill in [5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose), step 26 tried the scripts before go-live; don't run it on an instance in use. To practice with real backups, create a copy of the server from the provider's newest backup of it, with a firewall that allows no outgoing traffic, so that its worker can't reach anyone. Restore last night's backup there, check that it ends with `Replacement backup restored:`, then delete the copy *(not tried)*.

### 7.9 Data retention and deletion requests

LobbyStack deletes some content by itself after a set time, and keeps the rest until someone deletes it. When a caller asks a business to see or delete what it holds about them, the business usually needs your help: the dashboard can do little of it. Whether and how a request must be answered is a legal question for the business; the steps below find and remove the data.

**What LobbyStack keeps, and for how long**

Retention is on by default (`CONTENT_RETENTION_ENABLED`, `.env.example:143-148`). On an instance that doesn't sell plans, and on the paid plans of one that does (`packages/shared/src/billing.ts:446-458`, `packages/domain/src/server/privacy.ts:9-98`):

| What | Kept |
| --- | --- |
| Call transcripts and recordings. Since fork PR #93, a call's summary goes when its transcript does: a message taken during the call stays listed as one without its words, and a conversation whose summary has changed since keeps it | 90 days |
| AI debug traces: what the receptionist was given and did for each answer, callers' and visitors' words included. Only a business that turns them on keeps them, through the API or the command line (`ai_traces_enabled`) | 30 days, on every plan (`packages/db/migrations/0106_ai_traces.sql`) |
| Texts and website chat messages | 365 days. Then each one's words read "[content expired]" |
| Messages the receptionist took for the team | 365 days |
| Copies of the alerts sent to the team | 30 days, even with retention off |
| The record of each email after a call (fork PR #84): who it went to and its subject, never the call's words | 30 days, even with retention off |
| Contacts (name, phone, email), each call's time and outcome, appointments, the summaries of chats, each STOP or START, and the audit log | Until someone deletes them |
| The record of each incoming text, with its sender and its words (`provider_events`) | **Forever**: nothing deletes it |

The free plan, on an instance that sells plans, keeps everything for 30 days.

- Each item's end date is set when it's written, so a change of the periods applies only to new content. To change them, set `CONTENT_RETENTION_POLICY_JSON` on the admin and the worker, the same on both, such as `{"categories":{"transcripts":30,"recordings":30}}`. The five categories are `messages`, `transcripts`, `recordings`, `follow_ups` and `ai_traces`, in days. A value it can't read is ignored without a warning, so check the spelling (`packages/domain/src/server/contentRetentionPolicy.ts:13-44`).
- Before fork PR #93, a call's summary stayed after its transcript was gone. That release's migration `0126` clears those, and migrate's log says how many ([7.3](#73-database-migrations), step 5). Like the original project's, it also clears the summary of any call more than a day old that never had a transcript line.
- Content written while retention was off never expires, even after it's turned back on. `scripts/content-retention-backfill.ts` gives it an end date, one business and one category at a time; it's a job for someone technical (`docs/operations/remediation-rollout.md:100-112`).
- No screen, API call or command deletes one recording: only the end date does (`packages/domain/src/server/storage.ts:312-380`).
- Deleting a document under **Knowledge** removes its text from the receptionist, but its file stays in the bucket (`packages/domain/src/server/knowledge.ts:240-247`).

**Copies outside LobbyStack**

- OpenAI keeps each call's recording for 30 days, and LobbyStack doesn't delete it there (`docs/voice/runtime.md:222-235`).
- Each booking's Google Calendar event says "Appointment for <name>". Canceling the appointment deletes the event (`apps/worker/src/calendarJobs.ts:58-62`).
- Twilio keeps its own logs of calls and texts, and the pictures people send by text: LobbyStack keeps only how many there were.
- Each business's webhook receivers ([6.7](part-6-first-run.md#67-optional-the-api-and-the-command-line)), the emails Resend sent, and PostHog, if it's set up ([3.7](part-3-outside-services.md#37-optional-services)).
- The emails after each call in the team's mailboxes (fork PR #84): a summary and a link, or the whole conversation when the business chose **Summary and the whole conversation**. Nothing deletes them from there ([email](../../features/email.md#email-the-team-after-each-call)).
- Every backup ([7.7](#77-back-up-the-database-and-files)): Railway's monthly ones last 89 days, the copies at Cloudflare 30 days, the server's about a week, and your downloads as long as you keep them.

**A person asks for a copy of their data**

With a key for that business ([6.7](part-6-first-run.md#67-optional-the-api-and-the-command-line)), in the code folder on your computer. `--json` prints everything the API has, and `> <file>` saves it:

1. Find the contact: `pnpm lobbystack contacts list --phone +15145550123`, or `--email` or `--name` in place of `--phone`. Note its ID, then save it: `pnpm lobbystack contacts get <contact ID> --json > contact.json`.
2. Their appointments: `pnpm lobbystack appointments list --contact-id <contact ID> --all --json > appointments.json`.
3. Their calls: `pnpm lobbystack calls list --all --json > calls.json` lists every call of the business; theirs are the ones whose `contact_id` is the contact's. `pnpm lobbystack calls get <call ID> --json` adds a call's transcript. If the business keeps AI debug traces, they hold the person's words too: `pnpm lobbystack calls traces` lists them. Each call's page in the dashboard also has **Download audio** for its recording.
4. The messages the receptionist took for them: `pnpm lobbystack messages list --all --json`, keeping the ones whose `callback_phone` or `call_id` match.
5. Their texts and website chats aren't in the API (`packages/shared/src/publicApi/operations.ts`). Someone technical reads them from the database, signed in as `postgres` (the start of Part 7), with the business's ID from **Settings** > **API keys** and the contact's ID from the end of their page's address:

   ```sql
   \set b '<business ID>'
   \set c '<contact ID>'
   select m.created_at, cv.channel, m.direction, m.body
   from messages m join conversations cv on cv.id = m.conversation_id
   where cv.business_id = :'b'
     and (cv.contact_id = :'c' or cv.widget_visitor_id in (select id from widget_visitors where business_id = :'b' and contact_id = :'c'))
   order by m.created_at;
   ```

**A person asks to be deleted**

1. Cancel their future appointments in the dashboard first. That deletes the calendar events, and texts them a cancellation if they agreed to texts.
2. If they have no call, chat or appointment, **Delete contact**, in the contact's row menu or on their page, removes them. Only an owner or an admin of the business can.
3. Otherwise it refuses: "This contact can't be deleted because it still has linked conversations or appointments." (`packages/domain/src/server/contacts.ts:117-138`). The API and the command line can't delete them either. They can clear the name and the email, though not the phone number: `pnpm lobbystack contacts update <contact ID> --name null --email null`.
4. Deleting everything means deleting rows in the database: their calls with the transcripts and recordings, their chats and texts, their appointments, the records of their website visits and of their incoming texts, then the contact, and afterwards the recordings' files in the bucket. No tested script for it exists yet, so it's a job for someone technical: make a backup first ([7.7](#77-back-up-the-database-and-files)), try it on the test environment, and run it in one transaction, so that a mistake changes nothing.
5. Their record of texting STOP is the proof that they asked not to be texted. Whether to delete it too is a legal question.
6. The copies outside LobbyStack and in the backups (above) remain until they age out.

**A business closes**

Since fork PR #101 one of its owners deletes it, with everything in it, from its **Settings** > **Team**, unless it's an owner's first business: the delete ends its paid plan in Polar, gives its numbers back to Twilio, deletes its files from the bucket and removes its rows ([delete a business](../../features/business-deletion.md)). The copies outside LobbyStack and in the backups (above) remain until they age out.

Since fork PR #102 an owner whose first business is the only one they own cancels it instead, from the same page, after confirming by email: its plan ends and its numbers go back to Twilio 30 days later, but nothing of it is deleted, and [7.27](#727-reactivate-a-canceled-business) opens it again ([cancel an account](../../features/account-cancellation.md)). Its data stays until someone deletes it. A first business, canceled or not, can only be deleted in the database, signed in as `postgres`: end its plan in Polar's dashboard, release its numbers in Twilio's console and delete its folder, named by its ID, in the bucket first, then make a backup and delete it in one transaction, as in step 4 above.

**Not yet confirmed:**

- The name of Railway's button that makes a backup by hand ([7.7](#77-back-up-the-database-and-files)).
- The restore from the copy at Cloudflare, and the practice restore on a copy of a server ([7.8](#78-restore-from-a-backup-and-practice-it)): neither has been tried.
- How long Railway takes to prepare a restore, for a given size.
- The deletion statements outlined in the notes ([7.9](#79-data-retention-and-deletion-requests)), which have never been run.

**[7.7](#77-back-up-the-database-and-files) to [7.9](#79-data-retention-and-deletion-requests) were checked against:** `scripts/replacement-backup.sh`, `scripts/replacement-restore.sh`, `scripts/replacement-restore-drill.sh`, `packages/contracts/src/index.ts`, `packages/providers/src/storage/local.ts`, `packages/domain/src/server/storage.ts`, `packages/domain/src/server/knowledge.ts`, `packages/domain/src/server/privacy.ts`, `packages/domain/src/server/contentRetentionPolicy.ts`, `packages/domain/src/server/contacts.ts`, `packages/domain/src/server/businessDeletion.ts` (fork PR #101), `packages/shared/src/billing.ts`, `packages/shared/src/publicApi/operations.ts`, `packages/db/src/schema/index.ts`, `apps/worker/src/handlers.ts`, `apps/worker/src/calendarJobs.ts`, `docs/voice/runtime.md`, `docs/operations/remediation-rollout.md`, and Railway's, Cloudflare's and the AWS command-line tool's documentation as read on 2026-10-19. The lines on call summaries were checked against `packages/domain/src/server/privacy.ts`, `packages/domain/src/server/conversations.ts` and `packages/db/migrations/0126_clear_expired_call_summaries.sql` (fork PR #93).

## Watching the system

### 7.10 Health checks and uptime monitoring

The admin and the worker each answer two addresses that say whether they work. Railway uses them during each deploy, and your outside uptime check uses the admin's ([5.2](part-5-production.md#52-production-on-railway), step 24).

| Address | What it shows |
| --- | --- |
| The admin's `https://app.example.com/api/health/live` | `"ok":true`, and the version that runs as `"version"` (`apps/admin/src/lib/release-version.ts`) |
| The admin's `https://app.example.com/api/health/ready` | `"ok":true` when the admin can reach the database, the files and Redis, each listed under `"checks"` as `"ok"` or `"failed"`, and the brand it shows. Any `"failed"` turns the answer into an error |
| The worker's `/health/live` | `"ok":true` while the worker runs |
| The worker's `/health/ready` | `"ok":true` when the worker can reach the database, the files and Redis. `"draining":true` means it's stopping ([7.4](#74-deploy-without-cutting-off-calls)) |

- The worker has no public address. On a server, check it from the server itself: `curl -fsS http://127.0.0.1:13002/health/ready`. On Railway, its newest deployment shows **Active**, and Railway emails you if it keeps crashing ([5.2](part-5-production.md#52-production-on-railway), step 23).
- None of these checks makes a call or sends an email. A worker that runs but can't reach Twilio, OpenAI or Resend still looks healthy, so the weekly test call and email in [7.25](#725-routine-maintenance-calendar) matter too.
- A worker that stops shows only in its own checks: the admin's stay green. The signs are elsewhere ([7.16](#716-worker-crash-and-stuck-calls)). Every phone call is answered, then hung up at once, browser calls fail to start, and texts and emails stop going out, while the website chat keeps answering.

**The services LobbyStack depends on**

When something fails for every business at once, look at these pages first. Where a page offers email updates, subscribe the address that gets production's alerts; open the others during an incident:

| Service | Status page | Email updates |
| --- | --- | --- |
| Railway | `status.railway.com` | *Not confirmed* |
| OpenAI: calls and chat | `status.openai.com` | Probably, under **Subscribe to updates** |
| Twilio: numbers, texts and the trunk | `status.twilio.com` | Yes |
| Cloudflare: DNS, Turnstile and the backup bucket | `www.cloudflarestatus.com` | Yes |
| Resend: email | `resend.com/status` | Probably |
| GitHub: releases and deploys | `www.githubstatus.com` | Yes |
| A server's provider | `status.hetzner.com` (subscribe from inside your Hetzner account) or `status.digitalocean.com` | Yes |
| UptimeRobot: your uptime check | `status.uptimerobot.com` | Yes. While it's down, a quiet monitor proves nothing |
| Polar, on an instance that sells plans | `status.polar.sh` | *Not confirmed*; it has a feed at `status.polar.sh/feed.rss` |
| Google Calendar and the map | The Google Workspace and Google Maps Platform status dashboards | No; feeds only |

A green page doesn't prove that a service works for you. OpenAI's stayed green at first during a phone-call outage in May 2026, and Railway's lists only incidents that affect many users. Check the service's own logs too ([7.11](#711-logs-error-ids-and-following-one-call), [7.15](#715-calls-not-answered-or-dropping)).

### 7.11 Logs, error IDs and following one call

The admin and the worker write a line for each step of their work, and a line that starts with `[admin] exception:` or `[worker] exception:` for each error they catch. Most lines are JSON, so Railway can filter them by any field (`packages/telemetry/src/node.ts:313-437`).

**Where to read them**

- **On Railway:** open a service, then its newest deployment, for that service's log. For every service of an environment together, open **Observability** at the top and set the time range. Pro keeps logs for 30 days.
  - Filter with `@<field>:<value>`, such as `@level:error`, and combine filters with `AND`, `OR`, and `-` for "not". Plain words find the lines that contain them.
  - To keep lines, Railway's command-line tool saves them: `railway logs --service admin --environment production --since 24h --json > admin.json`.
- **On a server:** `docker compose logs --since 1h admin worker` shows the last hour of both. Add `| grep '<some text>'` to keep only the lines that contain it. Docker keeps only the newest part of each log ([5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose), step 10).

**An error that the dashboard showed**

Each failure on the server side gets an error ID, which its `[admin] exception:` line carries as `errorId` (`apps/admin/src/lib/api-helpers.ts:116-132`).

1. Find the ID:
   - The phone number screens show it after "Error ID:", and the website chat under "Your message couldn't be sent." (fork PR #79). The API and the command line show it after "Reference:".
   - Every other screen shows only "Request failed.". The ID is then in the browser: open its developer tools (F12 in most browsers), choose **Network**, repeat what failed, click the request shown in red, and find `x-error-id` among its response headers.
2. Find its line: on Railway, filter the admin's log with `@errorId:<error ID>`, or with the ID in double quotes if that finds nothing *(which one works: not tried)*. On a server, `docker compose logs --since 24h admin | grep <error ID>`. The line names the route, the error and where in the code it happened.

A message other than "Request failed." means the request itself was refused, such as a missing field, and the message says why. Nothing is logged for those. A page that shows "Something went wrong. Please try again." and **Retry loading** has no ID: look for `[admin] exception:` lines from that minute.

**Follow one call**

Every line about a call carries its IDs: `callId`, `sessionId` (the GPT-Live session), `businessId` and, for a phone call, `twilioCallSid` (`packages/telemetry/src/callContext.ts:8-26`).

1. Get the IDs from the call's page. The last part of its address, after `/calls/`, is the call ID. Its **Details** tab shows the **Twilio Call SID**, and the **Gateway session**, which is the session ID. Don't use the **ID** field's copy button: for calls imported from the original platform, it copies their old ID.
2. On Railway, in the environment's **Observability** view, filter with `@callId:<call ID> OR @sessionId:<session ID>`, so that the admin's and the worker's lines show together. A call's first lines carry only the session, because the call isn't saved yet. On a server: `docker compose logs --since 24h admin worker | grep -e <call ID> -e <session ID>`.
3. Read them in order:

| Line | From | What it says |
| --- | --- | --- |
| `live.incoming` | admin | The call arrived and was answered. `recordMs`, `acceptMs` and `attachMs` give the milliseconds to each step. Since fork PR #99 it comes once the worker has attached. Two for one `sessionId` mean OpenAI delivered the call twice, and `"decisionAlreadyMade":true` that the second delivery accepted it first |
| `live.incoming_not_served` | admin | The number belongs to no business on this instance |
| `live.incoming_without_dialled_number` | admin | The call didn't carry the number dialed, so it was refused |
| `[admin] exception:` with `live.incoming` | admin | Answering failed; its message says why ([7.15](#715-calls-not-answered-or-dropping)) |
| `live.greeting` | worker | The receptionist's greeting |
| `live.delegation` | worker | Each question passed to the text AI, with `agentMs`, the time its answer took |
| `live.closed` | worker | The end of the call, with `durationMs` |
| `live.detached`, `live.recovered`, `live.orphan_finished` | worker | Another worker took the call over, or picked it up after a crash ([7.16](#716-worker-crash-and-stuck-calls)) |
| `live.recording_unavailable` | worker | OpenAI's recording couldn't be copied |
| `call.summary_failed` | worker | The text AI couldn't write the call's one-line summary after it ended: `error` is `generation_timeout` or `generation_failed`. The call keeps a summary taken from its transcript, and saves none of the questions the receptionist couldn't answer (fork PR #106) |
| `knowledge.unanswered_question_failed` | worker | A question the receptionist couldn't answer wasn't saved for the team ([unanswered questions](../../features/unanswered-questions.md)) |
| `job.failed` | worker | A job failed, such as a text after the call. `willRetry` false means it gave up ([7.16](#716-worker-crash-and-stuck-calls)) |
| `ops.billing.sweep` | worker | Billing work that no job finished, queued again, with how many of each kind ([7.16](#716-worker-crash-and-stuck-calls)) |
| `ops.billing.webhook_refused` | admin | A delivery from Polar was refused. `"reason":"bad_signature"` means `POLAR_WEBHOOK_SECRET` isn't the webhook's secret ([7.18](#718-rotate-secrets-and-keys)) |
| `ops.billing.webhook_customer_mismatch` | admin | An event from Polar about a subscription on another business's Polar customer, which Polar picked by the payer's email because the worker's token lacked `customers:write` ([3.7](part-3-outside-services.md#37-optional-services), "[Selling plans](part-3-outside-services.md#selling-plans-polar)", step 3). The subscription still goes to the business that bought it |

Browser calls also log `live.browser_start`, and `live.browser_refused` when one is turned away, with the limit that ran out (`apps/admin/app/api/voice/live/session/route.ts:59, 174`).

The website chat logs `widget.chat_reply` for each answer, with its time to the first word and the tools it used (`noteUnansweredQuestion` among them when it saved a question it couldn't answer, since fork PR #106), `widget.chat_refused` with the `code` when a message is turned away, and `widget.team_request` when a visitor asks for a person. A failed answer logs an `[admin] exception:` line with the Error ID the chat shows, and its `category` says why ([8.7](part-8-troubleshooting.md#87-the-website-chat); `apps/admin/app/api/widget/chat/route.ts`, fork PR #79). None of these lines has the chat's words.

**Lines that mean a setting is missing**

- The worker, when it starts without email: "SMTP_HOST is missing. Authentication email jobs will fail until email delivery is configured." ([7.17](#717-emails-or-texts-not-going-out)).
- The admin, without `TRUSTED_CLIENT_IP_HEADER`: "[trusted-client-ip] TRUSTED_CLIENT_IP_HEADER is not configured; …". The chat's and browser calls' limits per visitor's IP address then don't apply (`apps/admin/src/lib/widget-policy.ts:23-26`).

**PostHog**

With PostHog set up ([3.7](part-3-outside-services.md#37-optional-services)), the admin's and the worker's errors also arrive there, grouped, with the same fields (`packages/telemetry/src/node.ts:369-437`).

- The dashboard's analytics are on for every business from the start, once the token is built in, and they include recordings of operators' screens (`packages/db/src/schema/index.ts:142`, `apps/admin/src/components/product-analytics.tsx:51-64`). Only the parts marked as sensitive in the calls, contacts, messages and appointments screens are hidden; the rest is recorded as shown. Each business turns this off with **Share telemetry data** under **Settings** > **Preferences**.
- Without `POSTHOG_API_KEY` on the worker, the worker still keeps a record of each business's product events, and never deletes them (`packages/domain/src/server/productEvents.ts:207-229`). Set the key, or have someone technical delete the old ones ([7.25](#725-routine-maintenance-calendar)).

### 7.12 Alerts and how to respond

LobbyStack sends no alert about the instance itself. The alerts come from the services around it, which [5.2](part-5-production.md#52-production-on-railway) and [5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose) set up, and from Twilio's alarms, below.

| Alerts from | About | Set up in |
| --- | --- | --- |
| Your uptime check | Production not answering, or its ready check failing | [5.2](part-5-production.md#52-production-on-railway), step 24 |
| Railway | Failed builds, crashed deployments, usage, and the disk and memory monitors | [5.2](part-5-production.md#52-production-on-railway), steps 23, 25 and 26 |
| OpenAI | Spending close to the project's monthly limit | [3.2](part-3-outside-services.md#32-openai) |
| Twilio | A low balance, from $5 by default ([7.13](#713-costs-and-usage-limits)), and errors (below) | Below |
| The status pages | Outages at the services LobbyStack depends on | [7.10](#710-health-checks-and-uptime-monitoring) |

**Add Twilio's alarms**

1. In Twilio, switch to production's subaccount: an alarm counts only the errors of the account it's in.
2. Open **Monitor** > **Alerts** > **Alarms**, and click **Create alarm**.
3. Choose **Specific error code**, enter `11200`, and have it email production's alert address the first time it happens in 15 minutes *(the form's fields: not confirmed)*. Error 11200 means Twilio couldn't deliver an incoming text, or a text's delivery report, to the admin.
4. Create a second alarm for **Any error** within 1 hour, to the same address.

The repository's `docs/operations/alerts.md` describes three more alerts: messages the worker gave up on, failed jobs, and a stopped dispatcher. They need an OpenTelemetry service that nothing in the repository sets up, and the first one's query names a table that doesn't exist ([Appendix E](appendix-e-doc-problems.md)). The weekly checks in [7.25](#725-routine-maintenance-calendar) look for the same problems.

On an instance that sells plans, the worker also compares the last applied `billing.json`, the billing tables and Polar once a day. Each day they differ, or Polar can't be read, it logs `ops.billing.profile_drift`, and with PostHog set up ([3.7](part-3-outside-services.md#37-optional-services)) sends it there too; once they agree again, it sends `ops.billing.profile_drift_recovered` (`apps/worker/src/handlers.ts:225-244`). PostHog tells you only if you add an alert on that event *(PostHog's steps not researched)*. Since fork PR #74 the daily check leaves the webhook out, because the worker's token goes without `webhooks:read`: when Polar turns the webhook off, it emails the organization's members, and `pnpm billing verify` checks the webhook and its secret ([3.7](part-3-outside-services.md#37-optional-services), "[Selling plans](part-3-outside-services.md#selling-plans-polar)", step 8; `packages/domain/src/server/billingVerify.ts:210-217`).

Every 5 minutes, the worker also queues again the billing work that no job finished: a Polar event not yet applied, usage not yet sent to Polar, and a checkout that didn't run ([7.16](#716-worker-crash-and-stuck-calls)). When an event or usage has waited more than an hour, or a checkout request failed after waiting 15 minutes, it reports the error "Billing work waited longer than it should.", which reaches PostHog's error tracking when it's set up (`apps/worker/src/handlers.ts:246-276`; fork PR #71).

**When an alert arrives**

| Alert | Look first | Then |
| --- | --- | --- |
| The uptime check: production is down | Open `https://app.example.com/api/health/ready`. Which check shows `"failed"`, or does nothing answer at all? | [7.14](#714-incident-basics-who-acts-what-to-check-first-how-to-tell-users), "The dashboard doesn't open" |
| Railway: a build failed | The deployment's build log | Production didn't change: a deployment that fails leaves the previous one running. Fix it on `main`, and release again ([7.1](#71-release-a-new-version)) |
| Railway: a deployment crashed | The last lines of its log | For the worker, [7.16](#716-worker-crash-and-stuck-calls); for the others, [7.14](#714-incident-basics-who-acts-what-to-check-first-how-to-tell-users) |
| Railway: usage, or a memory monitor | The workspace's usage page, and the service's **Metrics** | [7.13](#713-costs-and-usage-limits), [7.24](#724-scale-up) |
| Railway: disk above 80% | The volume's size | Grow the volume now ([7.24](#724-scale-up)): a full volume stops the database |
| Twilio: error 11200 | **Monitor** > **Debugger**, its newest entries | [7.17](#717-emails-or-texts-not-going-out) |
| Twilio: a low balance | Its billing pages | Add funds at once: at $0, calls and texts stop ([7.13](#713-costs-and-usage-limits)) |
| OpenAI: spending | `platform.openai.com/usage` | [7.13](#713-costs-and-usage-limits) |
| PostHog: `ops.billing.profile_drift` | `pnpm billing verify` ([3.7](part-3-outside-services.md#37-optional-services), "[Selling plans](part-3-outside-services.md#selling-plans-polar)", step 8): its `DRIFT` lines say what differs | A change made in Polar's dashboard: run `pnpm billing apply` again, which puts it back. When the event's `status` is `failed`, the worker's token can't read Polar: give it the four read scopes ([3.7](part-3-outside-services.md#37-optional-services), "[Selling plans](part-3-outside-services.md#selling-plans-polar)", step 3). Since fork PR #69, Credits left on a product count as drift until the next `apply` takes them off, and since fork PR #73 so does an annual product that invoices its overage once a year, until an `apply` with `--allow-replace` replaces it ([3.7](part-3-outside-services.md#37-optional-services), "[Selling plans](part-3-outside-services.md#selling-plans-polar)", step 7) |
| PostHog: the error "Billing work waited longer than it should." | The worker's `job.failed` lines for `billing.reconcile`, `billing.syncUsage` or `billing.createCheckout` ([7.11](#711-logs-error-ids-and-following-one-call)) | Fix the Polar, token or database error they name, such as a worker token without `events:write` ([3.7](part-3-outside-services.md#37-optional-services), "[Selling plans](part-3-outside-services.md#selling-plans-polar)", step 3). `"polarConfigured":false` on the error means the worker has no `POLAR_ACCESS_TOKEN` or `POLAR_ORGANIZATION_ID`: set both ([4.6](part-4-test-environment.md#46-add-the-admin-and-the-worker)). The worker keeps queuing the work until it's done |
| PostHog: the warning "The worker's Polar token can't read or make customers" | The worker's `[worker] warning:` lines, one for each checkout ([7.11](#711-logs-error-ids-and-following-one-call)) | The worker's token lacks `customers:write`, so each checkout goes to whichever Polar customer has the payer's email. Checkouts keep working meanwhile. Put in a new worker token with its eight scopes ([3.7](part-3-outside-services.md#37-optional-services), "[Selling plans](part-3-outside-services.md#selling-plans-polar)", step 3; [7.18](#718-rotate-secrets-and-keys)) |
| PostHog: the error "A live Polar subscription is for a product no plan maps to" | The worker's `[worker] exception:` lines, with the business's ID ([7.11](#711-logs-error-ids-and-following-one-call)) | Since fork PR #75, an event about a live subscription to a product no plan sells, such as one made by hand in Polar's dashboard, waits, and the business keeps its plan. The billing sweep runs it again each hour, so after an hour "Billing work waited longer than it should." comes too. Run `pnpm billing apply` if the product belongs in `billing.json` ([3.7](part-3-outside-services.md#37-optional-services), "[Selling plans](part-3-outside-services.md#selling-plans-polar)", step 7), or move the subscription in Polar to a product the plans sell, and the event applies (`docs/providers/polar.md:129`, `docs/operations/alerts.md:19`) |

### 7.13 Costs and usage limits

LobbyStack shows no costs. On an instance that doesn't sell plans, **Settings** > **Usage** says only "Self-hosted workspaces use your own providers. No usage limits or billing apply.", and **Analytics** counts calls, appointments and messages. The providers' bills are the record. Nothing in LobbyStack limits what a business uses on such an instance, so the only spending limits are the ones you set at the providers (`packages/shared/src/billing.ts:79-94`).

**Where the money goes**

| Service | Charges for | Where to see it |
| --- | --- | --- |
| OpenAI | Every call, every chat answer and answer during a call, and documents read for the receptionist | `platform.openai.com/usage`, for production's project or for all of them. It needs an organization owner or the Usage Dashboard permission, and shows days in UTC |
| Twilio | Each number, every month from the day it's bought; call minutes on the trunk; texts | The trunk's **Dashboard** shows minutes, calls and cost; the billing pages show the balance |
| Railway | What each service uses, by the minute, on top of the Pro plan | `railway.com/workspace/usage`, and the invoices at `railway.com/workspace/billing` |
| Cloudflare | The backup bucket's storage | R2's pages |

Look at all of them once a month ([7.25](#725-routine-maintenance-calendar)), and compare each with the month before.

**Keep Twilio from stopping**

At a balance of $0, Twilio suspends the account with its subaccounts. Incoming calls then fail with error 10003, and texts with 30002; calls already in progress can finish. Turn on automatic top-ups on the main account, since subaccounts draw on its balance:

1. In Twilio's main account, open the billing overview, and choose **Enable auto recharge** *(the labels as Twilio's older help pages give them; the new console's: not confirmed)*.
2. Set it to **Enabled**, **When Balance Falls Below** to at least $10, the lowest Twilio offers, and **Recharge Balance To** to about two months of spending. Choose the payment method, and save.
3. Twilio emails you when the balance reaches $5. To hear sooner, add an amount under **Balance Notifications**.

If the balance ran out, calls work again 5 to 10 minutes after the funds arrive.

**What makes a month cost more**

- Long calls. Each minute costs at OpenAI and at Twilio. A phone call ends at 30 minutes, and a browser call too, unless `WEB_CALL_MAX_DURATION_MS` lowers it (`packages/shared/src/index.ts:30-34`). On a copy older than `9b66d01`, a browser call ends at 5 minutes, unless the variable raises it to at most 30.
- Answers during calls use OpenAI's priority tier, at twice the standard price, so the receptionist answers faster (`mintlify/self-hosting/environment-variables.mdx:112`). `AI_DELEGATION_SERVICE_TIER=default` on the worker halves that part of the bill, and callers wait longer for answers.
- Numbers nobody uses: every business can buy one ([7.20](#720-decide-who-can-sign-up)). Release the ones it doesn't need ([7.21](#721-buy-change-and-release-numbers)).
- Open sign-up: every stranger's business runs on your OpenAI and Twilio accounts ([7.20](#720-decide-who-can-sign-up)).

**What LobbyStack records itself**

For someone technical: the database keeps a row with a cost for each call, text and AI answer, in `unit_economics_events`. A call's GPT-Live part is the code's own estimate, $0.05 a minute (`packages/domain/src/server/liveCalls.ts:19-21`), not OpenAI's bill. Its Twilio part, and each text's, are Twilio's prices. AI answers get a cost only when all five of the `AI_CHAT_` price variables are set (`packages/agent-core/src/model.ts:62-79`). This month's totals:

```sql
select event_kind, provider, count(*) as events, count(cost_usd) as priced, round(sum(cost_usd)::numeric, 2) as usd
from unit_economics_events where occurred_at >= date_trunc('month', now()) group by 1, 2 order by usd desc nulls last;
```

`priced` lower than `events` means rows without a price. The admin can also export these figures by business, at `/api/internal/finance/export`, but no doc describes it, it's off by default, and its database role has no password until someone sets one ([Appendix E](appendix-e-doc-problems.md)).

**Not yet confirmed:**

- How Railway's filter takes an error ID (`@errorId:` or the ID in quotes), and how it shows a JSON line without a level, such as `job.failed`.
- Which status pages offer email updates: OpenAI's, Resend's and Railway's very likely do; Polar's isn't known.
- The fields of Twilio's alarm form, and the new console's billing labels.
- Whether PostHog keeps screen recordings when its project has them turned off.
- How OpenAI's usage page shows GPT-Live minutes.

**[7.10](#710-health-checks-and-uptime-monitoring) to [7.13](#713-costs-and-usage-limits) were checked against:** `packages/telemetry/src/node.ts`, `packages/telemetry/src/callContext.ts`, `apps/admin/src/lib/api-helpers.ts`, `apps/admin/src/lib/request-json.ts`, `apps/admin/src/lib/release-version.ts`, `apps/admin/app/api/health/ready/route.ts`, `apps/worker/src/index.ts`, `apps/worker/src/jobFailureLog.ts`, `apps/admin/app/api/webhooks/openai/live/route.ts`, `apps/admin/app/api/voice/live/session/route.ts`, `apps/admin/src/components/live-call-detail-surface.tsx`, `apps/admin/src/lib/client-analytics.ts`, `apps/admin/src/components/product-analytics.tsx`, `apps/admin/src/lib/widget-policy.ts`, `apps/admin/src/lib/trusted-client-ip.ts`, `packages/domain/src/server/productEvents.ts`, `packages/domain/src/server/liveCalls.ts`, `packages/agent-core/src/model.ts`, `packages/shared/src/billing.ts`, `docs/operations/alerts.md`, and the providers' pages as read on 2026-10-19. Fork PR #71's billing sweep lines in [7.11](#711-logs-error-ids-and-following-one-call) and [7.12](#712-alerts-and-how-to-respond) were checked at `1d4c172` against `apps/worker/src/handlers.ts` and `scheduler.ts`, `packages/domain/src/server/billingSweep.ts`, `packages/db/migrations/0114_billing_sweep.sql`, `apps/admin/app/api/webhooks/polar/route.ts`, `docs/providers/polar.md` and `docs/operations/alerts.md`. Fork PR #72's lines in [7.11](#711-logs-error-ids-and-following-one-call) and [7.12](#712-alerts-and-how-to-respond) were checked at `cc0c65d` against `apps/worker/src/handlers.ts`, `apps/admin/app/api/webhooks/polar/route.ts`, `apps/admin/src/lib/polar-event.ts`, `packages/telemetry/src/node.ts` and `docs/providers/polar.md`, and [7.12](#712-alerts-and-how-to-respond)'s line numbers are from that commit. Fork PR #73's line in [7.12](#712-alerts-and-how-to-respond) was checked at `35af54b` against `packages/domain/src/server/billingPolar.ts` and `billingVerify.ts`. Fork PR #74's lines in [7.12](#712-alerts-and-how-to-respond) were checked at `7d20322` against `packages/domain/src/server/billingVerify.ts`, `apps/worker/src/index.ts` and `handlers.ts`, and `docs/providers/polar.md`, and [7.12](#712-alerts-and-how-to-respond)'s line numbers are now from that commit. Fork PR #75's line in [7.12](#712-alerts-and-how-to-respond) was checked at `24e211d` against `apps/worker/src/handlers.ts`, `docs/providers/polar.md` and `docs/operations/alerts.md`, and its line numbers are from that commit.

## Incidents

### 7.14 Incident basics: who acts, what to check first, how to tell users

An incident is anything that stops callers from reaching a business, or stops the businesses from working. Most start outside LobbyStack: a provider's outage, a balance at zero, a setting changed by mistake. So look outside first, and change one thing at a time.

**Before anything happens**

- Decide who answers the alerts ([7.12](#712-alerts-and-how-to-respond)), and who stands in for them. Each needs production's entries in the password manager ([1.2](part-1-prepare.md#12-your-worksheet-and-keeping-secrets-safe)), and access to Railway or the server, Twilio and OpenAI.
- Keep each business's contact person, with an email and a phone number, somewhere outside LobbyStack: when the instance is down, so is its team list.
- Subscribe to the status pages ([7.10](#710-health-checks-and-uptime-monitoring)).
- Agree with each business what it does while the receptionist is down. A business that forwards its own line to its LobbyStack number ([6.4](part-6-first-run.md#64-get-a-phone-number-and-make-the-first-calls)) can turn the forwarding off with its phone company, so that calls ring its own phones again.

**When something breaks**

1. Write down the time, what was reported, and by whom, and keep notes as you go: the logs are searched by time.
2. Open `https://app.example.com/api/health/ready`, and note which check shows `"failed"`, or whether nothing answers.
3. Look at the status pages of OpenAI, Twilio, and Railway or the server's provider ([7.10](#710-health-checks-and-uptime-monitoring)). If one has an incident that matches, tell the businesses (below), and check again once the page says it's resolved.
4. Look at your release list ([7.1](#71-release-a-new-version), step 10). If a release went out just before the problem started, roll it back first ([7.5](#75-roll-back-a-bad-release)).
5. Find the symptom below, and follow its section.
6. Once it's fixed, check production as in [7.1](#71-release-a-new-version), step 9, and call one business's number.

| What people report | Look at | Section |
| --- | --- | --- |
| The dashboard doesn't open, or every page fails | The ready check | Below |
| Calls ring with no answer, or the number is out of service | Twilio's call log | [7.15](#715-calls-not-answered-or-dropping) |
| Calls are answered, then hang up at once | The worker | [7.16](#716-worker-crash-and-stuck-calls) |
| Calls drop partway | A deploy, or the worker | [7.4](#74-deploy-without-cutting-off-calls), [7.16](#716-worker-crash-and-stuck-calls) |
| Texts or emails don't arrive | The message's status, then Twilio's or Resend's logs | [7.17](#717-emails-or-texts-not-going-out) |
| The website chat doesn't answer, or browser calls fail to start | Redis, then OpenAI's status page | Below, [7.15](#715-calls-not-answered-or-dropping) |
| Everything is slow | The services' memory and processor use | [7.24](#724-scale-up) |

**The dashboard doesn't open**

| The ready check shows | What's wrong | What to do |
| --- | --- | --- |
| Nothing, or an error page from Railway or Caddy | The admin isn't running, or the address doesn't reach it | On Railway, open the admin's newest deployment and read the end of its log; redeploy it, or roll back ([7.5](#75-roll-back-a-bad-release)). On a server, run `docker compose ps`, then `docker compose logs --tail 50 admin caddy` |
| `"database":"failed"` | PostgreSQL is down, or its disk is full | On Railway, open `Postgres`, its log and its volume's size ([7.24](#724-scale-up)). On a server, `docker compose ps postgres` and `df -h /` |
| `"redis":"failed"` | Redis is down. The chat and browser calls turn every visitor away until it's back, and since fork PR #74 no one can start a checkout or open the billing portal, because their limits can't be counted (`apps/admin/src/lib/fixed-window-limit.ts:44-62`) | Start it again: on Railway, **Redeploy** its newest deployment; on a server, `docker compose restart redis`. Then restart the worker the same way, so that it sets up its schedules again ([7.7](#77-back-up-the-database-and-files)) |
| `"storage":"failed"` | The bucket, or the server's disk | On Railway, the bucket and the `S3_` variables ([4.4](part-4-test-environment.md#44-add-postgresql-redis-and-the-bucket)). On a server, `df -h /` |

**Tell the businesses**

- Tell them early, before you know the cause: their callers notice first. Say what doesn't work, since when, what they can do meanwhile, and when you'll write again.
- Write again once it's fixed: what happened, and what their callers may have missed. Calls in the gap show on **Calls** as "Call ended because of a technical issue before a final outcome was captured." Texts, emails and reminders that waited go out late, and some may not go out at all ([7.16](#716-worker-crash-and-stuck-calls)).

**Afterwards**

Write a short note: the times, the cause, what fixed it, and what would have shown it sooner. Keep it with your release list.

### 7.15 Calls not answered or dropping

A phone call goes from Twilio, over the SIP trunk, to OpenAI. OpenAI asks the admin whether to answer it, the admin hands it to the worker, and the worker holds it until it ends ([0.3](part-0-start-here.md#03-how-lobbystack-fits-together)). What the caller hears tells you where it stopped:

| What the caller hears | Where it stopped | Look at |
| --- | --- | --- |
| The number is out of service, or the carrier's own message | Twilio: the number isn't on the trunk, or not on the account any more | The number in Twilio (below) |
| Ringing, then silence or a fast busy signal | Between Twilio and OpenAI, or OpenAI refused the call | Twilio's call log (step 2) |
| A busy signal | The admin: the business used up its plan's minutes, on an instance that sells plans | [8.5](part-8-troubleshooting.md#85-phone-calls) |
| A refusal straight away | The admin: the caller is blocked, on the contact's page | The contact |
| An answer, then the line hangs up after a moment | The worker didn't take the call | [7.16](#716-worker-crash-and-stuck-calls) |
| The receptionist, then the call drops partway | A worker deploy, a crash, or the 30-minute limit | [7.4](#74-deploy-without-cutting-off-calls), [7.16](#716-worker-crash-and-stuck-calls) |

**Check, in this order**

1. **The status pages:** OpenAI's **Realtime** and **Live**, and Twilio's **Elastic SIP Trunking** ([7.10](#710-health-checks-and-uptime-monitoring)).
2. **Twilio's call log**, in production's subaccount: **Monitor** > **Logs** > **Voice** > **Calls**. Find the call by its time and its number, and open it.
   - No record of the call: Twilio never got it. Check that the number is still in the subaccount's numbers.
   - Error 32011: Twilio couldn't reach OpenAI, or OpenAI answered with an error. Check the trunk's origination address, `sip:<project ID>@sip.api.openai.com;transport=tls` ([3.3](part-3-outside-services.md#33-twilio), step 11), then OpenAI's status page.
   - Error 32010: the trunk has no working origination address ([3.3](part-3-outside-services.md#33-twilio), step 11).
   - Error 10003: the balance reached zero ([7.13](#713-costs-and-usage-limits)).
   - **Failed**, after 0 seconds, with a last SIP response of 400 from `sip.api.openai.com`, and nothing in the admin's log (step 3): the problem is at OpenAI. Look at its status page and its developer forum, then write to its support. OpenAI had two outages like this in 2026, and its status page stayed green at first.
3. **The admin's log** ([7.11](#711-logs-error-ids-and-following-one-call)), around the time of the call:
   - Nothing at all: OpenAI's request didn't arrive, or the admin turned it away. On the admin, check that `LIVE_PROTOTYPE_ENABLED` is `true` (otherwise it answers 404), and that `OPENAI_WEBHOOK_SECRET` is the secret of production's webhook (otherwise it answers 400, "Invalid signature.") (`apps/admin/app/api/webhooks/openai/live/route.ts:36-44`).
   - `live.incoming_not_served`: the number isn't any business's number on this instance ([7.21](#721-buy-change-and-release-numbers)).
   - `live.incoming_without_dialled_number`: the call didn't carry the number that was dialed. Give someone technical the line's `sessionId`.
   - `[admin] exception:` with `live.incoming.lookup`: the database didn't answer ([7.14](#714-incident-basics-who-acts-what-to-check-first-how-to-tell-users)).
   - `[admin] exception:` with `live.incoming`, and "Worker attach failed with status <n>." or "fetch failed": the worker didn't take the call ([7.16](#716-worker-crash-and-stuck-calls)).
   - `live.incoming` and no exception: the admin answered. Follow the call in the worker's lines ([7.11](#711-logs-error-ids-and-following-one-call)).

**Put a number back on the trunk**

LobbyStack puts each number it buys on the trunk. A number that isn't on it has nothing to answer its calls.

1. In Twilio, in production's subaccount, open the number's settings.
2. Under **Voice**, choose **SIP Trunking**, then production's trunk, and save *(the labels as Twilio's docs give them)*.
3. Call the number.

Someone technical can do the same with the repository's script, which also records the change in LobbyStack's database (`scripts/operations/move-number-to-gpt-live.ts`). The command in `docs/voice/runtime.md` fails with `Cannot find package '@lobbystack/db'`; adding `--tsconfig scripts/tsconfig.json` fixes it ([Appendix E](appendix-e-doc-problems.md)). It runs from the copy of the code on a computer ([Part 2](part-2-local-development.md)), after `pnpm install`: no script is in the images that run on Railway or the server.

1. Open a tunnel to production's database, in a terminal of its own:
   - Railway: `ssh -N -L 15432:127.0.0.1:5432 <Postgres's service instance ID>@ssh.railway.com`. With `Postgres` open in production, the command palette (Ctrl+K) offers **Copy Service Instance ID**. Railway needs your SSH key first ([7.8](#78-restore-from-a-backup-and-practice-it)).
   - Server: `ssh -N -L 15432:127.0.0.1:15433 root@<the server's IP address>`.
2. In another terminal, in the code folder, run this with production's values: the trunk's SID, the subaccount's SID and token, and `LOBBYSTACK_WORKER_PASSWORD` ([4.3](part-4-test-environment.md#43-make-the-passwords-and-secrets)) in the address:

   ```sh
   TWILIO_SIP_TRUNK_SID='<trunk SID>' TWILIO_ACCOUNT_SID='<account SID>' TWILIO_AUTH_TOKEN='<auth token>' \
   LOBBYSTACK_WORKER_DATABASE_URL='postgresql://lobbystack_worker:<password>@127.0.0.1:15432/lobbystack' \
   pnpm exec tsx --tsconfig scripts/tsconfig.json scripts/operations/move-number-to-gpt-live.ts --business-id <business ID> --number +15815550123
   ```

   It prints what it would change. Run it again with `--apply` at the end to make the change: it then prints `"moved":"GPT-Live"`.

### 7.16 Worker crash and stuck calls

**Signs that the worker is down**

- The admin's checks stay green: they don't cover the worker (`apps/admin/app/api/health/ready/route.ts:13-27`).
- Every phone call is answered, then hung up at once, and its outcome reads "Call ended because of a technical issue before a final outcome was captured." The admin's log has `[admin] exception:` lines with `live.incoming`, saying "Worker attach failed with status <n>." or "fetch failed" (`apps/admin/src/lib/live-prototype.ts:39-54`).
- Browser calls fail to start.
- Texts, emails, reminders, calendar updates and the businesses' webhooks stop going out.
- The website chat keeps answering: it runs in the admin.

**Get it running again**

On Railway:

1. Open the worker's newest deployment. **Crashed** means it kept stopping and Railway gave up restarting it. The end of its log says why.
2. The usual causes:
   - `<NAME> is required in production.`: a setting is missing ([4.6](part-4-test-environment.md#46-add-the-admin-and-the-worker)).
   - `password authentication failed for user "lobbystack_worker"`: its database password doesn't match ([4.6](part-4-test-environment.md#46-add-the-admin-and-the-worker)).
   - An error about storage: the worker won't start without the bucket ([4.6](part-4-test-environment.md#46-add-the-admin-and-the-worker)).
   - "Deploy Ran Out of Memory!", or exit code 137: see [7.24](#724-scale-up). After raising a limit, redeploy: a restart keeps the old one.
   - It started with a release: roll back ([7.5](#75-roll-back-a-bad-release)).
3. Fix the cause, then open the newest deployment's three-dot menu and choose **Redeploy**.

On a server:

1. Run `cd /root/lobbystack`, then `docker compose ps worker` and `docker compose logs --tail 100 worker`. The usual causes are the same as above.
2. Fix the cause, then run `docker compose up -d worker`.
3. Check it with `curl -fsS http://127.0.0.1:13002/health/ready`, which should show `"ok":true`.

**Calls that were in progress**

- Every minute, one worker looks for calls that have no worker, from 1 minute to 2 hours old, and takes each one over or ends it (`apps/worker/src/handlers.ts:642-667`). So after a crash, the calls in progress carry on or end within a minute or two.
- A call still shown as **In progress** after 2 hours stays that way: nothing ends an old phone call. On an instance that doesn't sell plans, it costs nothing, and **Analytics** already counts it as missed (`packages/domain/src/server/analytics.ts:145-149`). Leave it.
- Someone technical can close old browser calls with `scripts/operations/voice-recovery.ts`, as `docs/operations/remediation-rollout.md:119-129` describes, through the tunnel in [7.15](#715-calls-not-answered-or-dropping). Without `--apply` it only lists them. Every mistake makes it print the same line, "Voice recovery failed; check arguments, evidence flags, and database access.", so check the arguments and the database address first.

**Texts, emails and reminders that didn't go out**

- While the worker is down, they wait in the database, and go out late once it's back.
- While Redis is down, the worker can't queue them. It tries each one 10 times, over about 13 minutes, then gives up on it (`packages/db/src/outbox.ts:10-14`).
- While Twilio or the email service refuses them, each text and email is tried 5 times, over about 15 seconds, then counted as failed. Alerts to the businesses' teams get 12 tries over about 3 hours (`packages/jobs/src/index.ts:51-58`).
- Nothing sends a given-up text or email again (`docs/operations/alerts.md:7`). After an outage that lasted longer than those tries, tell each business that some texts and emails may not have gone out. Texts that didn't go out show in **Messages** as **Sending** or **Failed to send**. Someone technical can count what was given up with the weekly checks ([7.25](#725-routine-maintenance-calendar)).

**Billing work that didn't finish**

On an instance that sells plans, nothing needs sending again by hand. Every 5 minutes the worker's billing sweep queues again each Polar event not applied 5 minutes after it arrived, each piece of usage not sent to Polar 15 minutes after its last change, and each checkout not run 5 minutes after its last change, at most once an hour each, until the work is done (`packages/domain/src/server/billingSweep.ts:19-24`, `apps/worker/src/scheduler.ts:42`; fork PR #71). A checkout request still waiting after 15 minutes fails instead, so a plan change never goes through long after the person left the page: they start it again (`docs/providers/polar.md:125`). Since fork PR #75 an event about a live subscription to a product no plan sells waits too, run again each hour, until the product is linked ([7.12](#712-alerts-and-how-to-respond)).

### 7.17 Emails or texts not going out

**Emails**

1. Check that email is set up: without `SMTP_HOST`, the worker's log says "SMTP_HOST is missing. Authentication email jobs will fail until email delivery is configured." when it starts. Then the sign-in emails (confirming an address, resetting a password, setting up an account) fail, and every other email, invitations and alerts included, is skipped without any error (`apps/worker/src/handlers.ts:469-475`).
2. Open Resend's **Emails** page, and look for the email by its address and time.
   - **Not there:** Resend never got it. The worker's log has a `job.failed` line for `email.send` with the reason. Common causes are in [3.4](part-3-outside-services.md#34-email): a wrong `SMTP_PASSWORD`, `EMAIL_FROM` not on the verified domain, or the domain no longer verified.
   - **Delivered:** Resend handed it to the person's mail server. Ask them to look in spam.
   - **Delivery delayed:** Resend keeps trying for up to 14 hours.
   - **Bounced:** the person's mail server refused it, usually because the address is wrong. Fix the address in LobbyStack.
   - **Suppressed:** the address is on Resend's suppression list, after an earlier bounce or a spam complaint, and Resend didn't send it. Fix the cause first, then open the **Suppressions** page, find the address, and choose **Remove email address** from its menu. The list covers your whole Resend team.
3. A failed email isn't sent again: once it's fixed, have the person ask again, such as with **Forgot password?**.

**Texts**

1. Open the conversation in **Messages**. Each text the business sent shows **Sending**, **Sent**, **Delivered**, **Not delivered** or **Failed to send**, and the reason when there is one, such as "This contact texted STOP, so they don't get texts." (`apps/admin/public/locales/en/messages.json:54-69`).
2. A text that stays on **Sending**: the worker isn't running ([7.16](#716-worker-crash-and-stuck-calls)), or it has no Twilio settings, which makes it skip texts without failing them (`apps/worker/src/handlers.ts:508-511`).
3. Otherwise, open Twilio's **Monitor** > **Logs** > **Messaging**, in production's subaccount, and click the text's date. Its page shows Twilio's error code:

| Code | What it means | What to do |
| --- | --- | --- |
| 30003 | The phone is off, or out of reach | Nothing: it usually comes back |
| 30005 | The number doesn't exist | Check the number |
| 30006 | A landline, which can't get texts | Don't text it again |
| 30007 | The carrier or Twilio filtered it as spam | Check the wording against Twilio's messaging policy. If it complies, send Twilio's support 3 or more of the texts' IDs (Message SIDs) |
| 30008 | An unknown failure at the carrier | Try a short text in plain characters, then Twilio's support, with 3 IDs from the last 48 hours |
| 30032 | A toll-free number that isn't verified yet | Finish its verification ([3.3](part-3-outside-services.md#33-twilio)) |
| 30034 | A US number that isn't registered for texting, or isn't in the campaign's **Sender Pool** | Finish A2P 10DLC, and add the number to the Sender Pool ([3.3](part-3-outside-services.md#33-twilio), step 14; [7.21](#721-buy-change-and-release-numbers)) |
| 21610 | The person texted STOP | Only they can undo it, by texting START |

4. Texts people send don't appear in **Messages**: open Twilio's **Monitor** > **Debugger**. Error 11200 means the admin refused Twilio's request or didn't answer. Check that the admin's `TWILIO_AUTH_TOKEN` is production's subaccount's current token ([7.18](#718-rotate-secrets-and-keys)), and that the number's messaging address is production's ([7.23](#723-change-the-domain-or-the-brand)).

The businesses' teams get an alert for some failures too, such as "SMS delivery failed" (`packages/domain/src/server/sms.ts:310`).

**Not yet confirmed:**

- What Twilio shows for a call that OpenAI refuses because the project has no SIP access.
- Whether Twilio sends an incoming text again after the admin fails it.
- Whether a STOP to one business's number stops texts from every number in the same subaccount.
- Whether the tunnel through `ssh.railway.com` works for the scripts; nothing here has been run against a real database.
- Twilio's current labels for a number's voice settings.

**[7.14](#714-incident-basics-who-acts-what-to-check-first-how-to-tell-users) to [7.17](#717-emails-or-texts-not-going-out) were checked against:** `apps/admin/app/api/webhooks/openai/live/route.ts`, `apps/admin/src/lib/live-prototype.ts`, `apps/admin/src/lib/call-outcome.ts`, `apps/admin/app/api/voice/live/session/route.ts`, `apps/admin/app/api/health/ready/route.ts`, `apps/admin/src/lib/fixed-window-limit.ts`, `apps/admin/app/api/webhooks/twilio/sms/route.ts`, `apps/admin/app/api/webhooks/twilio/status/route.ts`, `apps/worker/src/index.ts`, `apps/worker/src/handlers.ts`, `apps/worker/src/scheduler.ts`, `apps/worker/src/outboxDispatcher.ts`, `packages/jobs/src/index.ts`, `packages/db/src/outbox.ts`, `packages/domain/src/server/analytics.ts`, `packages/domain/src/server/voiceRecovery.ts`, `packages/domain/src/server/sms.ts`, `scripts/operations/move-number-to-gpt-live.ts`, `scripts/operations/voice-recovery.ts`, `docs/voice/runtime.md`, `docs/operations/alerts.md`, `docs/operations/remediation-rollout.md`, the dashboard's English labels, and Twilio's, OpenAI's and Resend's pages as read on 2026-10-19. [7.16](#716-worker-crash-and-stuck-calls)'s billing work lines were checked at `1d4c172` against `packages/domain/src/server/billingSweep.ts`, `apps/worker/src/scheduler.ts` and `docs/providers/polar.md` (fork PR #71), and their line numbers again at `cc0c65d`, `35af54b`, `7d20322` and `24e211d`, where its line on held Polar events was added (fork PR #75). [7.14](#714-incident-basics-who-acts-what-to-check-first-how-to-tell-users)'s Redis row was checked at `7d20322` against `apps/admin/src/lib/fixed-window-limit.ts` and `billing-limit.ts` (fork PR #74).

## Security and access

### 7.18 Rotate secrets and keys

Change a secret when it may have leaked: someone who had it left, it was pasted where others could see it, or a computer that held it was lost. Some providers also suggest changing their keys every few months. For most of LobbyStack's own values, a change costs more than it protects, so change those after a leak.

**What changing each generated value does**

The numbers are the ones in [4.3](part-4-test-environment.md#43-make-the-passwords-and-secrets). None of these values has an overlap: LobbyStack holds one copy of each, so the old value stops working as soon as the new one is live.

| # | Value | What a change breaks | When |
| --- | --- | --- | --- |
| 1 | `POSTGRES_PASSWORD` | Nothing, when it's changed inside PostgreSQL first (below). Changing only the variable stops migrate and the backups | After a leak |
| 2 to 5 | The four `LOBBYSTACK_…_PASSWORD` values | A few minutes of failed requests | After a leak |
| 6 | `REDIS_PASSWORD` (Railway only) | The website chat, browser calls, live updates and the job queue stop for a few minutes | After a leak |
| 7 | `BETTER_AUTH_SECRET` | Everyone is signed out, and signs in again with the same password. Email-change links, a calendar connection in progress, calendar links sent through the API, and some connected AI assistants must be done again | After a leak, or to sign everyone out |
| 8 | `ENCRYPTION_KEY` | Every business's API keys, connected assistants, calendar connections and webhook endpoints (below). Platform keys survive | Only after a leak |
| 9 | `INTERNAL_SERVICE_SECRET` | Only a browser call that starts at that moment | Any time |
| 10 | `INTERNAL_SERVICE_TOKEN` | Every call fails while the admin and the worker hold different values | At a quiet hour |
| 11 | `NUMBER_CLAIM_TOKEN_SECRET` | A number search made just before must be done again | Any time |
| 12 | `OTP_HASH_SECRET` | Every caller's saved PIN, and the codes sent in the last 10 minutes | Only after a leak |
| 13 | `WIDGET_SESSION_SECRET` | Open website chats stop for up to about 55 minutes, unless the visitor reloads the page | At a quiet hour |
| | `LOCAL_STORAGE_SIGNING_SECRET` (server only) | Links to recordings and files that are already open | Any time |

Make each new value as in [4.3](part-4-test-environment.md#43-make-the-passwords-and-secrets), letters and digits only, and save it in production's password manager entry before you use it, along with the second copy of values 8 and 12 ([5.2](part-5-production.md#52-production-on-railway), step 3).

**Values 7, 9, 10, 11 and 13, and the server's storage secret**

- On Railway: change the value on the admin's **Variables**, and click **Deploy**. The worker refers to value 10, so both deploy, and go live minutes apart: calls fail in between, hence the quiet hour.
- On a server: change the line in `.env`, then run `docker compose up -d`.
- Before changing value 7, tell users they'll be signed out. Don't set `BETTER_AUTH_SECRETS` (with an S) in the hope of keeping people signed in: it signs them out all the same.

**Values 8 and 12, after a leak**

Each business has work to do afterwards, so plan the hour with them.

1. Change the value once: on Railway on the admin, since the worker refers to it, then **Deploy**; on a server, its line in `.env`, then `docker compose up -d`.
2. After a change of value 8, each business:
   - makes new API keys under **Settings** > **API keys**, puts them where the old ones were, and signs the command line in again ([6.7](part-6-first-run.md#67-optional-the-api-and-the-command-line));
   - connects Google Calendar again under **Integrations**;
   - clicks **Rotate secret** on each endpoint under **Integrations** > **Webhooks**, puts the new secret in its receiver, then sends the missed events again with **Resend** in the endpoint's delivery log. Until then, nothing tells the business: the worker's log just shows `webhook.deliver failed (attempt N of 5): Unsupported state or unable to authenticate data`;
   - connects each AI assistant again.
3. After a change of value 12, each business sets new PINs for the contacts that had one, and tells those callers. A caller who gives the old PIN is refused, and after 5 wrong tries the contact is locked.

**The database passwords, values 1 to 5**

On Railway, migrate gives values 2 to 5 to the database on every run, so changing the variables is enough:

1. At a quiet hour, change the lines on `Postgres` > **Variables**, and click **Deploy**.
2. Postgres restarts, for up to about 2 minutes, then migrate, the admin and the worker deploy. Until migrate has set the new passwords, the new admin and worker can't sign in, and may fail or restart, as on the first deploy.
3. migrate's log shows `Database role logins configured for 4 roles.` Check that the admin's and the worker's newest deployments show **Active**, and **Redeploy** any that doesn't ([5.2](part-5-production.md#52-production-on-railway), step 13).
4. Open `/api/health/ready`, sign in, and make a test call.

Value 1 is different: PostgreSQL keeps the password it was first given, so change it inside PostgreSQL first.

1. Open `Postgres`'s **Console** tab, or run `railway ssh --service Postgres --environment production` on your computer. There, run `psql -U postgres -d lobbystack`. Inside its own service it needs no password.
2. Type `\password postgres`, enter the new value twice, then type `\q`. This way the value appears in no history or log.
3. At once, change `POSTGRES_PASSWORD` on `Postgres` > **Variables**, and click **Deploy**. Postgres restarts, and migrate and the backup service deploy again. The admin and the worker don't use this value.
4. Check migrate's log, and the backup service's next run ([5.2](part-5-production.md#52-production-on-railway), step 22).

Changing the variable without step 2 leaves the database on the old password: migrate then fails with `password authentication failed for user "postgres"`, and the nightly copies stop.

On a server, the database keeps the passwords it was first given, and nothing updates them:

1. In `/root/lobbystack`, run `docker compose exec postgres psql -U postgres -d lobbystack`.
2. Type `\password <role>` for each password you change: `postgres`, `lobbystack_auth`, `lobbystack_app`, `lobbystack_worker` or `lobbystack_dispatcher`. Then type `\q`. From now on, the admin's and the worker's new connections fail, so go straight on.
3. Put the same values in `.env`. For `POSTGRES_PASSWORD`, change the password inside the `DATABASE_URL` line too.
4. Run `docker compose up -d`. It restarts PostgreSQL for a few seconds, and the admin and the worker with the new passwords.
5. Do the checks in [5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose), steps 20 to 22, and save the new `.env` in the password manager.

**Redis's password, value 6 (Railway only)**

At a quiet hour, change `REDIS_PASSWORD` on `Redis` > **Variables**, and click **Deploy**. Redis restarts with its data, then the admin and the worker deploy with the new password. In between, the website chat, browser calls, live updates and the job queue stop. Work waiting to be sent stays in the database and goes out afterwards, as long as Redis is back within about 13 minutes ([7.16](#716-worker-crash-and-stuck-calls)). A server's Redis has no password.

**The providers' keys**

Where the provider keeps the old and the new key valid side by side, make the new one, deploy it, test it, and only then remove the old one. On a server, each value is a line in `.env`, followed by `docker compose up -d`.

| Value | Make the new one | Then |
| --- | --- | --- |
| `OPENAI_API_KEY` | At OpenAI, in the same project as the old one: the trunk's address names that project ([3.3](part-3-outside-services.md#33-twilio), step 11) | Set it on the admin, which the worker refers to, and **Deploy**. Make a test call and a website chat, then delete the old key. If `AI_CHAT_API_KEY` or `AI_EMBEDDING_API_KEY` is set, change it too |
| `OPENAI_WEBHOOK_SECRET` | Below | |
| `TWILIO_AUTH_TOKEN` | Below | |
| `SMTP_PASSWORD` | At Resend, **API Keys**: a new key with **Sending access** to the same domain ([3.4](part-3-outside-services.md#34-email)) | Set it on the worker and **Deploy**. Send yourself a password reset, and find it on Resend's **Emails** page. Then choose **Remove API key** in the old key's **More options** menu |
| `TURNSTILE_SECRET_KEY` | In Cloudflare, Turnstile > the widget > **Settings** > **Rotate Secret Key**. The old and the new secret both work for 2 hours, and the site key stays the same | Set it on the admin and **Deploy**, within the 2 hours |
| `GOOGLE_CLIENT_SECRET` | In Google Cloud, on production's client, **Add Secret**. Both secrets work until the old one is disabled | Set it on the admin, which the worker refers to, and **Deploy**. After an hour, check that the calendar card under **Integrations** still shows **Connected**, then disable the old secret *(inferred)*. Never make a new client instead: a new client ID cuts off every connected calendar |
| `POLAR_ACCESS_TOKEN` | In Polar, Organization Settings > **Developers** > **New Token**: since fork PR #74 one for the admin and one for the worker, with the scopes from [3.7](part-3-outside-services.md#37-optional-services), "[Selling plans](part-3-outside-services.md#selling-plans-polar)", step 3, or on a server one token with all nine | Set each on its service, the worker's typed in rather than a reference to the admin's, **Deploy**, start a checkout and open **Manage subscription** on the test environment, then delete the old token. Put the new tokens' end dates in the calendar ([7.25](#725-routine-maintenance-calendar)). The next day's billing check shows whether the worker can still read Polar: `pnpm lobbystack billing catalog-runs --kind verify` ([7.12](#712-alerts-and-how-to-respond)). A worker token without `subscriptions:write` goes unnoticed until a business that pays for Starter clicks **Upgrade to Pro** ([3.7](part-3-outside-services.md#37-optional-services), "[Selling plans](part-3-outside-services.md#selling-plans-polar)"), or an owner deletes a business that pays, whose delete then says the plan couldn't be canceled (fork PR #101), and one without `customers:write` shows at the first checkout, as the warning "The worker's Polar token can't read or make customers" ([7.12](#712-alerts-and-how-to-respond)). Give neither token `webhooks:read` |
| `POLAR_WEBHOOK_SECRET` | In Polar's webhook settings *(whether it can make a new secret in place: not confirmed)* | Set it on the admin and **Deploy** at once. Deliveries in between are refused and sent again by Polar; send any left failed again from Polar's delivery overview. Polar turns the webhook off after 10 failed deliveries in a row, so turn it back on there first if it did. The admin logs each refused delivery as `ops.billing.webhook_refused` (`apps/admin/app/api/webhooks/polar/route.ts:34-41`, `docs/providers/polar.md:98`; fork PR #71) |
| A platform key | `pnpm platform-key:create` with the same `--partner` and `--owner-email` as the old one, run as `PLATFORM_API_KEYS='<the value now on the admin>' pnpm platform-key:create ...` so the printed value keeps the old key ([6.7](part-6-first-run.md#67-optional-the-api-and-the-command-line)) | Set the printed value on the admin and **Deploy**. Move whatever uses the old key to the new one, then delete the old entry from `PLATFORM_API_KEYS` and **Deploy** again. A mistake in the list stops every platform key |

**OpenAI's webhook secret**

OpenAI's dashboard can make a new secret *(where, and whether the old one keeps working: not confirmed)*. OpenAI's API can keep the old one working for 24 hours. In a terminal on your own computer, since the key stays in its history, with production's OpenAI key:

1. List the project's webhooks, and note the `id` of the one whose `url` is production's:

   ```sh
   curl https://api.openai.com/v1/webhook_endpoints -H "Authorization: Bearer <production's OpenAI key>"
   ```

2. Make the new secret:

   ```sh
   curl -X POST https://api.openai.com/v1/webhook_endpoints/<the id>/rotate_secret \
     -H "Authorization: Bearer <production's OpenAI key>" -H "Content-Type: application/json" \
     -d '{"keep_old_secret_active_for_24_hours": true}'
   ```

   The answer holds the new `signing_secret`, shown only this once. Save it in the password manager.
3. Set it as `OPENAI_WEBHOOK_SECRET` on the admin, **Deploy**, and call a business number.

Whether calls keep working between steps 2 and 3 isn't confirmed: it depends on whether OpenAI signs each call with both secrets, so do it at a quiet hour. Don't add a second webhook instead: OpenAI sends every call to every webhook of the project, and the one whose secret the admin doesn't hold fails.

**Twilio's Auth Token**

1. At a quiet hour, open production's subaccount in Twilio (**Account Selection** at the top left > **View Subaccounts**). Open its account settings (**Go to account settings** on its dashboard), then **Keys & Credentials** > **API keys & tokens**, click **Request a secondary token**, then **Request token**, and copy the **Secondary token**.
2. Set it as `TWILIO_AUTH_TOKEN` on the admin, which the worker refers to, and **Deploy**.
3. As soon as both show **Active**, click **Promote to primary** in Twilio, tick **I acknowledge the impact of this action**, and click **Promote token**. The old token stops at once.
4. Text a business number, and check that the text appears in **Messages**. If it doesn't, Twilio's **Monitor** > **Debugger** shows error 11200 ([7.17](#717-emails-or-texts-not-going-out)).

Phone calls don't use the token: they reach OpenAI through the trunk. Between steps 2 and 3, though, incoming texts may be refused, if Twilio keeps signing them with the old token until the promotion *(not confirmed)*. Keep that gap short.

**When you can't tell what leaked**

When a computer or a password manager export with production's entry is lost, change the providers' keys and values 1 to 7, 9, 10, 11 and 13 the same day, and decide about values 8 and 12 with the businesses.

### 7.19 Manage operators, API keys and platform keys

The instance has no administrator screen. Each business manages its own team ([6.6](part-6-first-run.md#66-invite-the-team)), and only a platform key reaches across businesses ([6.7](part-6-first-run.md#67-optional-the-api-and-the-command-line)). So most of this is done in each business's **Settings**, by one of its owners or admins.

**When someone leaves a business's team**

1. In **Settings** > **Team**, click **More options** on the person's row, and choose **Remove**. It acts at once, with no question and no message: the row just disappears. It also revokes the API keys they made for the business, the invitations they sent, and those sent to their address.
2. Their access to the business ends with their next click, and their connected AI assistants and API keys stop at once. They stay signed in to their account, which keeps any other business they belong to.
3. What they connected keeps running, so check two places:
   - **Integrations**: if they connected Google Calendar, the business's bookings keep going to their Google account's calendar. Click the Google Calendar card, then **Disconnect**, which acts at once, and connect the business's own calendar.
   - **Integrations** > **Webhooks**: for each endpoint they set up that sends to an address the business doesn't control, click **Delete**, then **Delete endpoint**. Or switch off "Send events to this endpoint".
4. **Settings** > **Connected apps** lists every member's AI assistants. **Disconnect** the ones that were theirs. They already don't work, so this only tidies the list.

**An invitation sent by mistake**

**Cancel invite**, in the invitation's row menu, acts at once. The email can't be recalled, but its link then shows "This invitation link is invalid or has expired."

**Business API keys**

- Revoke a key in **Settings** > **API keys** as soon as nothing needs it, or when the person who holds it leaves. Revoked keys stay listed as "Revoked" with the date. A program that still uses one gets "The API key is invalid or has been revoked.", and an AI assistant connected with it stops too.
- A computer whose command line was signed in with that key needs `pnpm lobbystack login` again, with a new key ([6.7](part-6-first-run.md#67-optional-the-api-and-the-command-line)).

**Platform keys**

- They're the most powerful keys on the instance, above all those made with `--access all`. Keep as few as you can, each in the password manager, named after who or what uses it.
- To replace one without a gap, see [7.18](#718-rotate-secrets-and-keys). To revoke one, delete its entry from `PLATFORM_API_KEYS` on the admin, and deploy. Then run `pnpm lobbystack business list` with another platform key: a mistake in the list makes every platform key answer with an error, while business keys keep working.

**Shutting someone out of every business**

Nothing locks an account: someone you've removed can still sign in, and create businesses of their own, up to 10 ([7.20](#720-decide-who-can-sign-up)). To take them off every business at once, someone technical:

1. Lists their memberships, signed in to the database as `postgres` (the start of Part 7):

   ```sql
   select b.id as business_id, b.name, m.id as member_id, m.role
   from business_memberships m join businesses b on b.id = m.business_id join users u on u.id = m.user_id
   where u.email = '<their email>' and m.status = 'active';
   ```

2. Removes each one with a platform key made with `--access all`: `pnpm lobbystack team remove <member ID> --business <business ID>`. A business they own alone can't lose its last owner, so the command refuses: that business stays theirs.
3. Revokes any platform key they held, and changes the secrets they could see ([7.18](#718-rotate-secrets-and-keys)).

**Accounts and businesses you don't know**

Once a month, and every week while sign-up is open ([7.20](#720-decide-who-can-sign-up)), look at the newest accounts and businesses, signed in to the database as `postgres`:

```sql
select email, created_at from users order by created_at desc limit 50;
select id, name, created_at from businesses order by created_at desc limit 50;
```

Nothing deletes an account, and only one of its owners can delete a business, never an owner's first ([7.9](#79-data-retention-and-deletion-requests), fork PR #101). To stop a business you don't know from costing you, release its number with a platform key made with `--access all` ([7.21](#721-buy-change-and-release-numbers)).

**Every three months, review who has access**

- The people in the Railway project, or with an SSH key on the server.
- The people and keys at each provider: Twilio, OpenAI, Cloudflare, Resend, Google, Polar, GitHub and UptimeRobot.
- Who can open production's password manager entries.
- The entries in `PLATFORM_API_KEYS`.
- The owners and admins of each business, with that business.

### 7.20 Decide who can sign up

No setting limits sign-up (`apps/admin/src/lib/auth.ts:255-400`): anyone who opens `/en/signup` can make an account, and Turnstile stops only robots. Each account can create 10 businesses (`packages/domain/src/server/tenancy.ts:33`). On an instance that doesn't sell plans, each of them can buy a number on your Twilio account, within 2 a day and 5 in 30 days per person (`packages/db/migrations/0084_number_claim_in_progress.sql:24-29`), and every call and chat runs on your OpenAI account.

Choose one:

- **Open**, on an instance that sells plans: strangers paying is the point ([1.3](part-1-prepare.md#13-decide-these-before-any-data-exists)). Still look for accounts you don't recognize ([7.19](#719-manage-operators-api-keys-and-platform-keys)).
- **Closed**, on an instance for your own businesses or your clients'. A rule in front of the admin refuses the one request that creates an account, `POST /api/auth/sign-up/email`. Everything else keeps working: sign-in, Twilio's and OpenAI's webhooks, the website chat, the API and the health checks.

What changes once it's closed:

- The sign-up page still shows, but its form answers "We couldn't create your account. Please try again." (`apps/admin/src/components/auth-card.tsx:104-111`).
- An invited person who has no account yet can't use **Create account to accept**. Make their account for them (below).

**Close it on a server**

On a server, Caddy is the only way in ([5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose)), so a rule there covers every request.

1. Sign in to the server, `cd /root/lobbystack`, and open your Caddy file with `nano docker/caddy/Caddyfile.production`. Add the four lines that start with `@signup` and the `respond` line, so that it reads:

   ```caddyfile
   {$APP_HOSTNAME} {
     @signup {
       method POST
       path /api/auth/sign-up/email
     }
     respond @signup 403

     reverse_proxy admin:3000 {
       header_up X-Real-IP {remote_host}
     }
   }
   ```

   Caddy compares the path without regard to capitals, after decoding it, so variations of the address are refused too (Caddy's matcher docs).
2. Check the file in a throwaway copy of Caddy, so that a mistake never reaches the running one. With your address:

   ```sh
   docker run --rm -e APP_HOSTNAME=app.example.com -v "$PWD/docker/caddy/Caddyfile.production:/etc/caddy/Caddyfile:ro" caddy:2.10-alpine caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
   ```

   It should end with `Valid configuration`.
3. Apply it with `docker compose up -d --force-recreate caddy`. Visitors get no answer for a few seconds while Caddy restarts.
4. Check it from your computer: `curl -i -X POST https://app.example.com/api/auth/sign-up/email` should answer `HTTP/2 403`, and `https://app.example.com/api/health/ready` should still show `"ok":true`. Then sign in once, and send one website chat message.

To open sign-up again, remove those lines and repeat steps 2 and 3.

**Close it on Railway, with Cloudflare**

Railway has no rules of its own for a path, so the rule goes in Cloudflare, which already holds your DNS ([3.1](part-3-outside-services.md#31-choose-your-addresses)). Cloudflare applies rules only to traffic that passes through it, so this first turns on Cloudflare's proxy for production's address, which [3.1](part-3-outside-services.md#31-choose-your-addresses) left off. Do it at a quiet hour, with production's numbers and a phone at hand.

1. In Cloudflare, open your domain. Check that nothing would block Twilio, OpenAI or Polar once their requests pass through Cloudflare:
   - Under **Security** settings, turn **Bot Fight Mode** off. Nothing can make an exception to it, and it may challenge requests that don't come from a browser *(where the switch is: not confirmed)*.
   - Under **Security rules**, click **Create rule** > **Custom rules**. Name it "Programs skip the browser check". Under **When incoming requests match**, choose the field **URI Path**, the operator **starts with** and the value `/api/`, then add a second line with **Or**: **URI Path**, **starts with**, `/.well-known/`. As the action, choose **Skip**, tick only **Browser Integrity Check**, and click **Deploy** *(the labels as Cloudflare's docs give them)*. Webhooks, the API, the command line, connected AI assistants and the uptime check aren't browsers, and Cloudflare's browser check, which is on by default, could turn them away.
   - Under **Security** settings, turn **Email Address Obfuscation** off *(where the switch is: not confirmed)*. Cloudflare turns it on for every new domain, and it rewrites the dashboard's pages.
2. Open **SSL/TLS** > **Overview**, choose **Custom SSL/TLS** if it offers it, then **Full**, not **Full (strict)**. Railway requires that, and **Full (strict)** would make the address fail with error 526.
3. Open **DNS** > **Records**, edit production's record, such as `app`, and set **Proxy status** to **Proxied** (an orange cloud). Leave the TXT record as it is.
4. Within the next 5 minutes, test everything that comes from outside: open `https://app.example.com/api/health/ready`, sign in, send a text to a business number and check that it appears in **Messages**, call that number, and send a website chat message. If you have the command line, also run the automatic check from [4.9](part-4-test-environment.md#49-smoke-test).
   - If anything fails, set the record back to **DNS only**: that undoes the change within 5 minutes. Then look at **Security** > **Events** in Cloudflare, and at Twilio's **Monitor** > **Debugger**, for what was stopped *(Cloudflare's menu names not confirmed)*.
   - Keep `TRUSTED_CLIENT_IP_HEADER=x-real-ip` on the admin. Railway fills that header from Cloudflare's own record of each visitor's address, so the per-visitor limits keep working, as far as Railway's staff have said.
5. Now add the rule itself: **Security rules** > **Create rule** > **Custom rules**. Name it "Refuse sign-up". Choose the editor that takes a typed expression *(its name not confirmed; Cloudflare's examples say **Edit expression**)* and enter:

   ```text
   (http.request.uri.path eq "/api/auth/sign-up/email" and http.request.method eq "POST")
   ```

   As the action, choose **Block**, and click **Deploy**. The Free plan allows 5 such rules; these steps use 2.
6. Check it as in the server's step 4: the `curl` command should answer `HTTP/2 403`, and everything else should still work.

This stops sign-up through the page and through Cloudflare. Someone determined can still send the request to Railway directly, skipping Cloudflare, because Railway offers no way to accept only Cloudflare's traffic. So keep looking for accounts you don't recognize ([7.19](#719-manage-operators-api-keys-and-platform-keys)).

To open sign-up again, delete the "Refuse sign-up" rule. The proxy can stay on.

**Make an account while sign-up is closed**

1. With a platform key ([6.7](part-6-first-run.md#67-optional-the-api-and-the-command-line)), run `lobbystack users create <email>`. It makes the account with no password, at most 20 an hour, and emails the person a link to set one (`packages/shared/src/publicApi/operations.ts:130`).
2. The person opens the link and sets a password. That also confirms their email address.
3. If they were invited, they then open the invitation and choose **Sign in to accept**.

**Not yet confirmed:**

- Whether OpenAI signs each call with both secrets during the 24 hours, and which token Twilio signs texts with before a promotion ([7.18](#718-rotate-secrets-and-keys)).
- Whether Polar can make a new webhook secret in place, and how its access tokens are revoked.
- Which AI assistants connect with a secret of their own, and so must connect again after a change of value 7. Someone technical can list them as `postgres`: `select name, token_endpoint_auth_method from oauth_clients;`, where `none` means unaffected.
- A way to end one person's sessions without signing everyone out.
- The rules in [7.20](#720-decide-who-can-sign-up), in Caddy and in Cloudflare, which haven't been tried, and the labels of Cloudflare's settings.

**[7.18](#718-rotate-secrets-and-keys) to [7.20](#720-decide-who-can-sign-up) were checked against:** `apps/admin/src/lib/auth.ts`, `apps/admin/src/lib/google-calendar-oauth.ts`, `apps/admin/src/lib/verification-flow.ts`, `apps/admin/src/lib/live-web-call.ts`, `apps/admin/src/lib/live-prototype.ts`, `apps/admin/src/lib/twilio-provider.ts`, `apps/admin/src/lib/twilio-status-auth.ts`, `apps/admin/src/lib/widget-keys.ts`, `apps/admin/src/lib/oauth-provider.ts`, `apps/admin/src/lib/mcp/handler.ts`, `apps/admin/src/components/live-team-surface.tsx`, `apps/admin/src/components/live-integrations-surface.tsx`, `apps/admin/src/components/auth-card.tsx`, `packages/providers/src/crypto/secretBox.ts`, `packages/providers/src/polar/webhook.ts`, `packages/domain/src/server/publicApi/apiKeys.ts`, `packages/domain/src/server/publicApi/platformKeys.ts`, `packages/domain/src/server/publicApi/webhooks.ts`, `packages/domain/src/server/oauth/tokens.ts`, `packages/domain/src/server/contactPasscodes.ts`, `packages/domain/src/server/tenancy.ts`, `packages/db/src/cli.ts`, `packages/db/src/client.ts`, `packages/db/migrations/0069_mcp_oauth.sql`, `packages/db/migrations/0084_number_claim_in_progress.sql`, `docker-compose.yml`, `docker/postgres/init/roles.sh`, the installed better-auth 1.7.7 and its OAuth provider, the dashboard's English labels, and Twilio's, OpenAI's, Resend's, Cloudflare's, Google's, Polar's, Railway's and Caddy's pages as read on 2026-10-19. [7.18](#718-rotate-secrets-and-keys)'s webhook secret row was checked at `1d4c172` against `apps/admin/app/api/webhooks/polar/route.ts` and `docs/providers/polar.md` (fork PR #71), and its Polar token row at `cc0c65d` against `.env.example` and `apps/worker/src/handlers.ts` (fork PR #72). The Polar token row was checked again at `7d20322` against `docs/providers/polar.md`, `apps/admin/app/api/billing/portal/route.ts`, `apps/worker/src/index.ts` and `docker-compose.yml` (fork PR #74), and the webhook secret row's line numbers are from `24e211d`.

## Phone numbers

### 7.21 Buy, change and release numbers

Each business has one number, which an owner or admin buys in the dashboard ([6.4](part-6-first-run.md#64-get-a-phone-number-and-make-the-first-calls)). Twilio bills it to your account from that day until it's released, whether or not the business still uses LobbyStack.

**Buying**

- Each person can buy 2 numbers a day and 5 in 30 days, over all their businesses. With a platform key, the limits count each business's numbers instead (`packages/shared/src/publicApi/operations.ts:146`).
- The worker buys the number, names it "LobbyStack <business ID>" in Twilio, puts it on production's trunk, and points its texts at the instance. In Twilio's console, that name tells you which business each number belongs to.
- **US numbers:** once the texting registration's campaign is approved ([3.3](part-3-outside-services.md#33-twilio), step 14), add each new number to the campaign's Messaging Service: in Twilio, open the service, then its **Sender Pool**, and add the number *(Twilio's labels not confirmed)*. Nothing does this by itself, and until it's done the number's texts to US phones fail with error 30034 ([7.17](#717-emails-or-texts-not-going-out)).
- LobbyStack can't take over a number the business already has, at Twilio or elsewhere. Forward that number's calls to the LobbyStack number instead ([6.4](part-6-first-run.md#64-get-a-phone-number-and-make-the-first-calls)).
- A number released earlier, by any business, can be bought again when Twilio offers it again. Before fork PR #93 that failed after Twilio had charged for it: LobbyStack still counted the number as taken, so the worker released it again and the dashboard said it couldn't get that number (`packages/db/migrations/0124_phone_numbers_e164_unreclaimed_unique.sql`, `apps/worker/src/handlers.ts:1081-1094`).

**Changing a number**

**Request change**, in **Settings** > **Phone Number**, swaps a business's number once ([6.4](part-6-first-run.md#64-get-a-phone-number-and-make-the-first-calls)). For the next 30 days:

- Both numbers answer calls.
- The business's texts may go out from either number, because LobbyStack picks any of its active numbers *(which one isn't defined; not confirmed in practice)*. Tell the business, so its customers aren't surprised.
- The dashboard shows only the new number. The old one, with the date it goes, shows only on the command line: `pnpm lobbystack numbers list --business <business ID>`, in its `release_scheduled_at` column.
- A new US number needs adding to the Sender Pool, as above.

To end the 30 days sooner, release the old number (below).

**Releasing a number**

A release is final: the number goes back to Twilio, and its monthly fee stops. The dashboard has no button for it, so use a key that can release numbers ([6.7](part-6-first-run.md#67-optional-the-api-and-the-command-line)):

1. Find the number's ID: `pnpm lobbystack numbers list --business <business ID>`. With a business key, leave out `--business`.
2. Release it: `pnpm lobbystack numbers release <number ID> --business <business ID>`. It answers at once, and within moments the number stops reaching the receptionist.
3. Run `numbers list` again. The number's status moves from `active` to `releasing`, then `released`, usually within a minute *(not timed)*. The business can then buy a new one.
   - "This number's replacement is still being set up. Release it once the new number is live." means a change is still under way: wait until the new number shows `active`.
   - A number that goes back to `active`: the worker couldn't release it at Twilio. It tries again every hour, and its log has a `job.failed` line that says why ([7.11](#711-logs-error-ids-and-following-one-call)).

- Before releasing a US number that texts, remove it from the campaign's Sender Pool *(whether a release does it: not confirmed)*.
- Don't release numbers in Twilio's console while LobbyStack uses them. LobbyStack would still count the number as the business's, so the business couldn't buy another *(inferred)*. Twilio can restore a number released there within 10 days, but under a new ID that LobbyStack doesn't know.
- A number that stops answering calls although it's `active` may have left the trunk: [7.15](#715-calls-not-answered-or-dropping) puts it back.

**Not yet confirmed:**

- How long a release takes to reach `released`.
- Which number a business's texts come from while a change is under way.
- Whether a release takes the number out of the Sender Pool, and the Sender Pool's labels in Twilio's current console.

**[7.21](#721-buy-change-and-release-numbers) was checked against:** `packages/domain/src/server/phoneNumbers.ts`, `packages/domain/src/server/compliance.ts`, `packages/domain/src/server/smsSender.ts`, `packages/domain/src/server/publicApi/resources.ts`, `packages/shared/src/publicApi/operations.ts`, `packages/cli/src/commands.ts`, `apps/worker/src/handlers.ts`, `packages/providers/src/twilio/twilioProvider.ts`, `apps/admin/src/components/live-phone-number-settings-surface.tsx`, `packages/db/migrations/0003_resolvers.sql`, and Twilio's pages as read on 2026-10-19. The line on buying a released number again was checked against `packages/db/migrations/0124_phone_numbers_e164_unreclaimed_unique.sql` and `packages/domain/src/server/phoneNumbers.ts` (fork PR #93).

## Maintenance

### 7.22 Upgrade pinned versions

LobbyStack runs on versions fixed in the repository and in your services' settings, so nothing changes under it by itself. The other side of that: updates arrive only when someone takes them.

| What | Version now | Fixed in | Supported until |
| --- | --- | --- | --- |
| Node.js, which runs the admin, the worker and migrate | 26.12.1, by its image's digest | The three Dockerfiles, in six `FROM` lines | April 2029. Long-term support starts in October 2026 |
| pnpm, which installs the code's libraries | 12.15.0 | `package.json` and nine other places in the repository | |
| The code's libraries | Exact versions | `pnpm-lock.yaml` | |
| PostgreSQL, with pgvector | 16, with pgvector 0.8.7 | `pgvector/pgvector:pg16`: on Railway in `Postgres`'s settings ([4.4](part-4-test-environment.md#44-add-postgresql-redis-and-the-bucket)), on a server in `docker-compose.yml` | November 9, 2028 |
| Redis | [7.4](#74-deploy-without-cutting-off-calls) | `redis:7-alpine` on Railway ([4.4](part-4-test-environment.md#44-add-postgresql-redis-and-the-bucket)), `redis:7.4-alpine` in `docker-compose.yml` | December 1, 2029 |
| Caddy, on a server | [2.10](part-2-local-development.md#210-if-something-fails-locally) | `docker-compose.yml` | *Not researched* |
| Polar's API, only if the instance sells plans | `2026-10` | `POLAR_API_VERSION` in `packages/shared/src/billing.ts`, and the webhook's version, which `pnpm billing apply` sets | Until Polar retires it, which its changelog announces |

**Node.js, pnpm and the libraries**

These change in the repository. Someone technical makes the change on `main`, the checks run, and it reaches the test environment, then production as a release ([7.1](#71-release-a-new-version)).

- GitHub's Dependabot can propose these changes every week, as pull requests. On a fork it stays off until someone switches it on *(where: not confirmed)*, and it doesn't look at `docker-compose.yml` (`.github/dependabot.yml`).
- Node.js 26.12.1 is the security release of October 21, 2026, with fixes in TLS, DNS and the Brotli decoder that `fetch()` uses on compressed responses (CVE-2026-111497, among others). An instance built before fork PR #90 runs Node.js 26.10.0 until it takes a release with that change.
- To take a newer Node.js 26, move all six `FROM` lines to the new version's tag and digest, such as `node:26.12.1-bookworm-slim@sha256:…`, in one commit on `main`, then release it. The digest is the one Docker Hub lists for that tag.
- To take a newer pnpm, change all ten places in one commit on `main`: `packageManager` in `package.json`, whose `+sha512.` part is the hex form of what `npm view pnpm@<version> dist.integrity` prints, the `npm install --global pnpm@…` line in the three Dockerfiles, and the six `version:` lines under `pnpm/action-setup` in `.github/workflows/`. Then run `pnpm install` with the new pnpm, which also rewrites the first part of `pnpm-lock.yaml`, where pnpm 12 locks its own version. Everyone who works on the code installs the new version as in [2.2](part-2-local-development.md#22-install-the-tools).
- pnpm installs a library's version only once it's 3 days old (`pnpm-workspace.yaml:6-8`), so a version published today waits. Since fork PR #91, pnpm 12 also refuses to install a lockfile that holds a younger version (`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`), so Dependabot waits 3 days before it proposes one (`.github/dependabot.yml`), and a hand-made lockfile change has to wait too.

**Polar's API version**

Since fork PR #73, every call to Polar asks for API version `2026-10`, and `pnpm billing apply` makes the webhook send that version's messages, so nothing changes when Polar makes a newer version its current one. Once Polar stops serving `2026-10`, though, it answers 404 to every call, so checkouts, the billing portal, usage reports and the daily check all stop. Before then, someone technical reads Polar's changelog, moves `POLAR_API_VERSION` on `main`, and it goes out as a release ([7.1](#71-release-a-new-version)). Then run `pnpm billing apply` in each environment, as in [3.7](part-3-outside-services.md#37-optional-services), "[Selling plans](part-3-outside-services.md#selling-plans-polar)", steps 6 to 8, which moves the webhook to the new version; until that run, `verify` and the daily check report the webhook as drift (`docs/providers/polar.md:79-81`, `packages/domain/src/server/billingPolar.ts:617-620`).

**Debian's fixes inside the built images**

Each build installs Debian's updates inside the images (`Dockerfile.admin:55`), but a server's Docker reuses an earlier build's result. So on a server, build without it once a month, at a quiet hour:

```sh
cd /root/lobbystack
REPLACEMENT_COMPOSE_PROJECT=lobbystack bash scripts/replacement-backup.sh
export SERVICE_VERSION=$(git rev-parse --short HEAD)
docker compose build --no-cache
docker compose run --rm migrator
docker compose up -d
```

On 4 GB, build one image at a time, as in [5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose), step 19, adding `--no-cache` to each. Whether Railway's builds reuse earlier results too isn't confirmed.

**PostgreSQL and Redis within a version**

The tags `pg16`, `7-alpine` and `7.4-alpine` get each new minor version, such as 16.15 to 16.16, with its fixes. A running service keeps the copy it started with.

- **On Railway:** when a newer image is out, an update button appears in the service's settings *(its label not confirmed)*. Make a backup by hand first ([7.7](#77-back-up-the-database-and-files)), then apply it at a quiet hour: the database or Redis goes away for up to about 2 minutes. Keep Railway's automatic image updates off ([4.4](part-4-test-environment.md#44-add-postgresql-redis-and-the-bucket)), so this never happens by itself at a busy hour.
- **On a server:** at a quiet hour, after the night's backup:

  ```sh
  cd /root/lobbystack
  docker compose pull --ignore-buildable
  docker compose up -d
  ```

  The first line fetches the newest PostgreSQL, Redis and Caddy for their tags. The second restarts the ones that changed, for a few seconds each.
- **Then pgvector:** a newer pgvector in the image doesn't update the database by itself. As `postgres` (the start of Part 7), run `ALTER EXTENSION vector UPDATE;`, then `SELECT extversion FROM pg_extension WHERE extname = 'vector';` shows the version.
- **Before you take a new PostgreSQL image,** check on Docker Hub (`hub.docker.com/r/pgvector/pgvector`) that `pg16` is still built on Debian bookworm. A newer Debian, such as trixie, sorts text differently, and the database's indexes would then need rebuilding: a job for someone technical.

**A new major version**

PostgreSQL 16 is supported until November 2028 and Redis 7.4 until December 2029, so plan a move a few months before.

- Changing the tag on a database in use doesn't work: PostgreSQL 17 won't start on a database that 16 wrote. The move is a copy, a new empty database of the new version, and a restore, as in [7.8](#78-restore-from-a-backup-and-practice-it). It's a job for someone technical, tried on the test environment first, and it starts in the repository, in `docker-compose.yml` and this guide's [4.4](part-4-test-environment.md#44-add-postgresql-redis-and-the-bucket).
- Railway's own Redis is version 8, which the original LobbyStack chose not to adopt (`.railway/README.md:35`). Keep `redis:7-alpine`.

### 7.23 Change the domain or the brand

Moving the instance to a new address touches every number, every connected service, and every business's website and printed signs. Plan it a day or more ahead, and keep the old address working for weeks.

What people notice:

- Everyone signs in again at the new address, with the same password, and connects their AI assistants again. At the old address, the dashboard still opens, but sign-in fails.
- Texts to each number are refused from the switch until its texting address is changed at Twilio (step 8).
- Website chat snippets, shared profile links and printed QR codes keep the old address, so the old address must keep reaching the admin until each business has replaced them.

**Before, a day or more ahead**

1. Check which brand the new address will get (below).
2. Make the new address reach the admin, and keep the old one:
   - On Railway: in `admin` > **Settings** > **Networking**, add the new domain with **+ Custom Domain** and port `3000`, create its DNS records, and wait for the green check mark ([4.7](part-4-test-environment.md#47-use-your-own-domain-optional), steps 1 and 2). Leave the old domain where it is.
   - On a server: point the new name at the server, as in [5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose), step 5.
3. Turnstile: add the new host name to production's widget ([3.5](part-3-outside-services.md#35-cloudflare-turnstile), step 4).
4. Google Calendar, if it's used: on production's client, add `https://<new address>/api/calendar/google/callback` under **Authorized redirect URIs** ([3.7](part-3-outside-services.md#37-optional-services), step 6), and, if the domain changes, the new domain under **Authorized domains** ([3.7](part-3-outside-services.md#37-optional-services), step 4).
5. List every business's numbers, with the query in [7.26](#726-shut-down-an-instance), step 4.
6. Tell the businesses the hour, and what they'll do afterwards: sign in again, connect their assistants again, replace the chat snippet on their website, update the profile links they've shared, and reprint their QR signs.

**The switch, at a quiet hour**

7. Change the address:
   - On Railway: change `APP_BASE_URL` on the admin, and click **Deploy**. Check that both the admin and the worker deployed again ([4.7](part-4-test-environment.md#47-use-your-own-domain-optional), step 4).
   - On a server: in `.env`, change `APP_BASE_URL`, `APP_HOSTNAME`, `TWILIO_SMS_WEBHOOK_URL`, `TWILIO_STATUS_CALLBACK_URL` and `GOOGLE_REDIRECT_URI`. In `docker/caddy/Caddyfile.production`, put both names on the first line, with the old one written out: `{$APP_HOSTNAME}, old.example.com {`. Then run `SERVICE_VERSION=$(git rev-parse --short HEAD) docker compose up -d --build`.
8. At once, in production's subaccount at Twilio, open each number's settings and set **A message comes in** to `https://<new address>/api/webhooks/twilio/sms`, and its status callback to `https://<new address>/api/webhooks/twilio/status` *(field names not confirmed)*. Until then, every text to that number is refused, even through the old address, because the admin now checks Twilio's signature against the new one. On an instance that sells plans, change the shared number too ([3.3](part-3-outside-services.md#33-twilio), step 20).
9. Change the webhook's address in production's OpenAI project to `https://<new address>/api/webhooks/openai/live` *(whether the dashboard edits it in place: not confirmed)*, and, on an instance that sells plans, Polar's to `https://<new address>/api/webhooks/polar`. Calls keep working through the old address meanwhile.
   - Edit Polar's webhook on its page in Polar, so it keeps its secret *(whether the page edits the address: not confirmed)*. `pnpm billing apply` would make a second webhook instead, with a new secret. Then sign the command line in at the new address and run `pnpm billing verify` ([3.7](part-3-outside-services.md#37-optional-services), "[Selling plans](part-3-outside-services.md#selling-plans-polar)", step 8).

**Right after**

10. Open `https://<new address>/api/health/ready`: it should show `"ok":true` and the brand you expect. The admin's log should have its `[brand]` line, and no `brand.build_mismatch`.
11. Sign in at the new address, and make a test call. Text a business number and find the text in **Messages**. Connect a test calendar, and chat on a site that still has the old snippet.
12. Run the automatic check from [4.9](part-4-test-environment.md#49-smoke-test) with `ADMIN_BASE_URL=https://<new address>`, and every number in `SMOKE_EXPECTED_NUMBERS`, separated by commas: it names each number whose texting address is still the old one.
13. Connect your own AI assistants again, to `https://<new address>/api/mcp`, and sign the command line in again at the new address ([6.7](part-6-first-run.md#67-optional-the-api-and-the-command-line)).
14. Cancel and send again any invitation that's still open ([6.6](part-6-first-run.md#66-invite-the-team)): its link leads to the old address, where sign-in fails.
15. If the brand publishes a Zapier integration ([3.7](part-3-outside-services.md#zapier)), push it again with the new address: `npm run push -- --brand <id> --url https://<new address>` in `integrations/zapier`. New connections then start with the new address. Each Zapier connection keeps the address it saved, so tell the businesses that use Zapier to reconnect with the new one.
16. If the brand publishes a Make app ([3.7](part-3-outside-services.md#make)), build and deploy it again with the new address: `npm run build -- --brand <id> --url https://<new address>` in `integrations/make`, then **Deploy to Make**, and commit its `makecomapp.json`. New connections then start with the new address. Each Make connection keeps the address it was made with, so tell the businesses that use Make to change it in their connection, or make a new one.

**In the weeks after**

17. Keep the old address reaching the admin directly, not through a redirect, until every business has replaced its snippet and its signs: a redirected snippet stops the chat. Keep the old domain registered meanwhile. Then remove it: from the admin's **Networking** settings on Railway, or from the Caddyfile's first line on a server, followed by `docker compose up -d --force-recreate caddy`. Remove its redirect address at Google and its host name at Turnstile too.
18. If the texting registration ([3.3](part-3-outside-services.md#33-twilio), step 14) names the old address or website, update it at Twilio.

**Change the brand**

LobbyStack picks the brand in this order ([3.6](part-3-outside-services.md#36-your-brand)):

1. a brand file in `brands/` that claims the address's domain;
2. otherwise `BRAND_PRESET`, on the admin and the worker;
3. otherwise the only brand in `brands/` besides LobbyStack, if there's exactly one: AlloPlace today;
4. otherwise LobbyStack's own, with the name and logo chosen at the brand step ([6.2](part-6-first-run.md#62-the-brand-step)).

So a new domain can change the brand by itself, and so can a second brand added to `brands/`: an address no brand claims then falls to step 4 unless `BRAND_PRESET` is set. To change it on purpose:

- **A brand file:** a developer edits `brands/`, runs `pnpm brands:build` and commits ([3.6](part-3-outside-services.md#36-your-brand)). A release then brings it ([7.1](#71-release-a-new-version)).
- **`BRAND_PRESET`:** set it on the admin and the worker, then click **Deploy**, or on a server run the `--build` command ([7.6](#76-change-a-setting-safely)). It does nothing on a domain that a brand file claims.
- **The name and logo chosen at the brand step:** someone technical runs `DELETE FROM public.deployment_branding;` as `postgres`. Then whoever owns every business opens `/onboarding/brand` and chooses again ([6.2](part-6-first-run.md#62-the-brand-step)). No rebuild is needed: emails use the new name within 30 seconds. This applies only where no brand file applies, which in this code needs `brands/` without AlloPlace, or with several brands and none picked.

Then check `"brand"` in `/api/health/ready`, and the admin's `[brand]` line. An admin built before the change logs `[brand] brand.build_mismatch: …`, ending with "Rebuild the admin to show it."

With `BRAND_REQUIRED=true` on the admin and the worker, both refuse to start unless a brand file applies, as in steps 1 to 3. A move or a second brand that would lose the brand then fails at once, instead of showing LobbyStack.

### 7.24 Scale up

One admin and one worker are enough for most instances. In a load test on a computer on 2026-10-15, one admin process handled about 400 people chatting at once, and the chat's own limits were reached first. When an instance grows, these run out, roughly in this order:

| Limit | What it is | What to do |
| --- | --- | --- |
| The chat's and browser calls' own limits | Chats: 60 opened a minute per business, and 60 messages a minute and 600 an hour per website key. Browser calls: 120 started a minute on the whole instance, and 60 an hour per business (`apps/admin/src/lib/widget-policy.ts`, `apps/admin/src/lib/web-voice-policy.ts`) | They're in the code: a developer changes them, and a release brings the change ([7.1](#71-release-a-new-version)) |
| OpenAI's tier | Every call and chat on the instance shares production's OpenAI organization. On the Build tier, at most 50 calls at once and $500 a month; on Launch, 300 and $5,000 ([3.2](part-3-outside-services.md#32-openai)) | The tier rises with what you've paid OpenAI. **Settings** > **Organization** > **Limits** shows it |
| Twilio's new-account limit | Until Twilio approves the business profile, the trunk carries only a few calls at once ([3.3](part-3-outside-services.md#33-twilio)) | Get the profile approved before go-live ([5.4](part-5-production.md#54-go-live-checklist)) |
| Database connections | PostgreSQL accepts 100 by default. One admin opens up to 40 and one worker up to 16, and during a worker's deploy two workers run (`packages/db/src/client.ts:66-75`) | Lower each copy's share before adding copies (below) |
| The admin's single thread | Past about 400 people chatting at once, every page and chat slows down | A second copy of the admin (below) |
| Memory and disk | A service or a server that runs out stops | Watch them ([5.2](part-5-production.md#52-production-on-railway), step 25), and grow them (below) |

**On Railway**

- **Memory and processors:** each service grows by itself, up to 24 GB of memory and 24 virtual processors on Pro, and Railway bills what it uses (Railway's docs). There's nothing to choose. Don't set a limit under **Replica Limits** on the worker or Postgres: a service that reaches it is stopped, and the worker's calls with it.
- **Disk:** the Postgres volume holds 50 GB by default on Pro. To grow it, open the volume's settings and raise **Volume Size** *(Railway calls this a live resize)*. A volume can't shrink again.
- **More copies of the admin:** a job for someone technical. Before raising the admin's replicas to 2, lower its database connections so that two admins, the worker and a draining worker stay under 100: each role's pool takes a `<ROLE>_POOL_MAX` variable, such as `LOBBYSTACK_APP_POOL_MAX` (`packages/db/src/client.ts:70`), which no doc mentions yet. Everything the admin shares between copies already goes through PostgreSQL and Redis.
- Postgres and Redis can't have copies on Railway, because they have volumes.

**On a server**

Move to a bigger plan with the provider's resize, called **Rescale** at Hetzner:

1. Make a backup and download it ([7.7](#77-back-up-the-database-and-files)).
2. At a quiet hour, sign in and stop LobbyStack, which gives calls in progress their goodbye: `cd /root/lobbystack && docker compose stop`.
3. In the provider's console, turn the server off, choose the bigger plan, and keep the current disk size, so you can move back to a smaller plan later. A bigger disk can't be undone. DigitalOcean allows about a minute of downtime for each GB of disk in use.
4. Turn the server on, sign in, run `docker compose up -d`, and do the checks in [5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose), steps 20 to 22. If the provider's console now shows a different IP address, change the DNS record to it ([5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose), step 5) *(whether a resize keeps the address: not confirmed)*.

One server can grow only so far, and its local file storage works only on one machine. Past that, production needs several machines and a bucket for its files: plan a move to Railway with someone technical.

### 7.25 Routine maintenance calendar

Put these in a shared calendar, with a name next to each. Most take a few minutes. The checks marked for someone technical run in the database as `postgres` (the start of Part 7).

**Every day**

- Read the alerts that came in: UptimeRobot, Railway, Twilio, and OpenAI's spending alerts ([7.12](#712-alerts-and-how-to-respond)).
- Someone technical looks through the worker's log for failed jobs that gave up, `job.failed` lines with `willRetry` false, and for `[worker] exception:` lines ([7.11](#711-logs-error-ids-and-following-one-call)).

**Every week**

- Check that the backups ran ([7.7](#77-back-up-the-database-and-files), "Every week"), and on Railway copy the bucket ([7.7](#77-back-up-the-database-and-files)).
- Call a business number, send it a text, and have the dashboard send you an email, such as a password reset. The health checks make no calls and send no emails ([7.10](#710-health-checks-and-uptime-monitoring)).
- Look at the spending: OpenAI's usage, Twilio's balance, and Railway's usage or the server's bill ([7.13](#713-costs-and-usage-limits)).
- While sign-up is open, look for accounts and businesses you don't know ([7.19](#719-manage-operators-api-keys-and-platform-keys)).
- Someone technical runs:

  ```sql
  -- Work waiting to be sent, and work given up on this week
  select count(*) filter (where published_at is null and dead_lettered_at is null and available_at <= now()) as waiting,
         count(*) filter (where dead_lettered_at > now() - interval '7 days') as given_up_this_week
  from outbox_messages;
  -- Calls still open after 2 hours
  select id, business_id, started_at, transport from calls where ended_at is null and started_at < now() - interval '2 hours';
  -- This week's texts, by status
  select status, count(*) from messages where channel = 'sms' and created_at > now() - interval '7 days' group by 1;
  ```

  `waiting` should be close to 0, and `given_up_this_week` 0: anything else means texts, emails or jobs that never went out ([7.16](#716-worker-crash-and-stuck-calls)). A call listed by the second query is stuck ([7.16](#716-worker-crash-and-stuck-calls)). Texts still `queued` or `sending` from days before are stuck too ([7.17](#717-emails-or-texts-not-going-out)).

**Every month**

- On a server, install the system's updates (below), check that `df -h /` leaves room for two more backups, and remove old images with `docker image prune -f` ([5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose), "From now on").
- On a server, rebuild the images without the cache, for Debian's fixes ([7.22](#722-upgrade-pinned-versions)).
- Look for new versions: a commit on `main` that moves Node.js or the libraries, and newer PostgreSQL and Redis images ([7.22](#722-upgrade-pinned-versions)).
- On an instance that sells plans, look in Polar's changelog for a date when API version `2026-10` stops working, and plan the move ([7.22](#722-upgrade-pinned-versions)).
- Look for accounts and businesses you don't know ([7.19](#719-manage-operators-api-keys-and-platform-keys)).
- Read the month's costs, and compare them with the month before ([7.13](#713-costs-and-usage-limits)).
- Without `POSTHOG_API_KEY` on the worker, product events pile up in the database ([7.11](#711-logs-error-ids-and-following-one-call)). Someone technical removes those older than 30 days: `delete from product_events where sent_at is null and occurred_at < now() - interval '30 days';`

The server's updates, at a quiet hour:

1. Check that last night's backup finished, and download it ([7.7](#77-back-up-the-database-and-files)).
2. Run `apt update && apt upgrade`, and read the list before you confirm. If it includes `docker-ce` or `containerd.io`, Docker restarts during the upgrade, and LobbyStack with it, which ends the calls in progress.
3. If `/var/run/reboot-required` exists (`ls /var/run/reboot-required`), restart: `cd /root/lobbystack && docker compose stop`, which gives calls in progress their goodbye, then `reboot`.
4. Sign in again, and run `cd /root/lobbystack && docker compose up -d`: after a stop by hand, LobbyStack doesn't start again by itself. Then do the checks in [5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose), step 20.

**Every three months**

- Practice a restore ([7.8](#78-restore-from-a-backup-and-practice-it)).
- Review who has access ([7.19](#719-manage-operators-api-keys-and-platform-keys)).
- Check that the incident contacts are current: who answers the alerts, who stands in, and each business's contact person ([7.14](#714-incident-basics-who-acts-what-to-check-first-how-to-tell-users)).

**Every year**

- Check that the domain renews by itself, at Cloudflare or wherever it was bought.
- Look at the retention periods ([7.9](#79-data-retention-and-deletion-requests)) and at each provider's plan.
- Look at the versions' end dates ([7.22](#722-upgrade-pinned-versions)): PostgreSQL 16 on November 9, 2028, Node.js 26 in April 2029, Redis 7.4 on December 1, 2029.

**Dates to note once**

Each of these stops something on a given day, so put it in the calendar when you make it:

- The end date of the Cloudflare token that the nightly copy uses, if it has one ([5.2](part-5-production.md#52-production-on-railway), step 19).
- The end dates of Polar's access tokens, the admin's and the worker's, or the one on a server, on an instance that sells plans ([7.18](#718-rotate-secrets-and-keys)).
- Google deletes a sign-in client that hasn't been used for six months, after an email 30 days before (Google's "Manage OAuth Clients" help page). A test environment with no calendar connected can lose its client this way; make a new one then ([3.7](part-3-outside-services.md#37-optional-services), step 6).
- Node.js's security fixes for version 26, due on or shortly after October 21, 2026 ([7.22](#722-upgrade-pinned-versions)).

### 7.26 Shut down an instance

Shutting an instance down deletes every business's data for good. Plan it weeks ahead with the businesses, and keep the final copies for as long as the law or your agreements say.

**Weeks before**

1. Tell each business the date, and what stops: calls, texts, the website chat, its public page and its QR codes. Ask it to:
   - forward its own line elsewhere, if it forwards to its LobbyStack number ([6.4](part-6-first-run.md#64-get-a-phone-number-and-make-the-first-calls));
   - remove the chat snippet from its website;
   - export what it wants to keep. The command line exports contacts, appointments, calls with their transcripts, and the messages the receptionist took, as in [7.9](#79-data-retention-and-deletion-requests) without the filters for one person. Each call's page offers **Download audio**. Texts and chats are only in the database ([7.9](#79-data-retention-and-deletion-requests)).
2. On an instance that sells plans, cancel the businesses' subscriptions in Polar, so nobody is billed for the last weeks *(Polar's steps not researched)*.

**The last day, while the worker still runs**

3. Cancel the future appointments that should get a cancellation, in each business's dashboard, or decide that they won't. Canceling texts the customers who agreed to texts, and deletes the events from the businesses' Google Calendars.
4. List every business and number, as `postgres` (the start of Part 7):

   ```sql
   select id, name, created_at from businesses order by created_at;
   select b.name, p.id, p.e164, p.status
   from phone_numbers p join businesses b on b.id = p.business_id
   where p.status in ('active', 'reclaiming') order by b.name;
   ```

5. Release every number with a platform key made with `--access all` ([6.7](part-6-first-run.md#67-optional-the-api-and-the-command-line)): `pnpm lobbystack numbers release <number ID> --business <business ID>` for each. Then `select status, count(*) from phone_numbers group by 1;` should show no `active` or `reclaiming`. The database calls a released number `reclaimed`. In Twilio's console, check that no number named "LobbyStack" followed by a business ID is left in production's subaccount, and release any that is.
6. Wait until nothing is left to send: no call in progress, and the first weekly query in [7.25](#725-routine-maintenance-calendar) shows `waiting` at 0.
7. Take a final backup and a copy of the files ([7.7](#77-back-up-the-database-and-files)), and download both. Keep them encrypted, together with production's password manager entry, which a restore needs ([7.8](#78-restore-from-a-backup-and-practice-it)). Requests to delete a person's data ([7.9](#79-data-retention-and-deletion-requests)) still apply to these copies.

**Delete the services**

8. On Railway, delete production from the dashboard, not the command line: the dashboard's deletion can be undone for 48 hours, and `railway delete` can't.
   - Production in a project of its own: the project's settings, **Danger** > **Delete Project**.
   - Production as an environment beside test: delete the environment in the project's settings, under **Environments** *(the button's name not confirmed)*. That's final at once, with its volumes and their backups.
   - The usage up to the deletion is still billed, and the Pro plan keeps running until it's canceled in the workspace's settings. A domain bought through Railway renews by itself until you switch that off at `railway.com/workspace/domains`.
9. On a server, run `cd /root/lobbystack && docker compose down`, then delete the server and its backups in the provider's console *(the providers' steps not researched)*.

**Close the outside accounts** *(each provider's steps not researched)*

10. Twilio: once its numbers are released, close production's subaccount, with its trunk, Messaging Service and texting registration.
11. OpenAI: delete production's project, or its webhook and its keys. OpenAI deletes its copies of the calls' recordings by itself after 30 days.
12. Resend: remove production's key, and the sending domain if nothing else sends from it. Cloudflare: delete production's Turnstile widget, its DNS records, and the backup bucket once you no longer need the copies in it. Google: delete production's client. UptimeRobot: delete the monitor. Polar: archive the products.

What stays afterwards: the events of past bookings in the businesses' Google Calendars, the chat snippets on their websites, which then load nothing, and the printed QR codes, which lead nowhere.

**Not yet confirmed:**

- Where to switch on Dependabot for a fork, and whether it updates the digests in the Dockerfiles.
- Whether Railway's builds reuse earlier results, and the label of its image update button.
- Twilio's labels for a number's texting address, and whether OpenAI's dashboard changes a webhook's address in place.
- Whether Railway serves an old and a new domain side by side, and whether Caddy gets a certificate for both names ([7.23](#723-change-the-domain-or-the-brand)).
- Whether a restart of the server gives calls in progress their goodbye, and whether Ubuntu's automatic restarts of services include Docker.
- How each provider closes an account, and whether a deleted Railway project is billed during its 48 hours.

**[7.22](#722-upgrade-pinned-versions) to [7.26](#726-shut-down-an-instance) were checked against:** `Dockerfile.admin`, `Dockerfile.worker`, `Dockerfile.migrator`, `docker-compose.yml`, `.railway/template.ts`, `.railway/README.md`, `.github/dependabot.yml`, `package.json`, `pnpm-workspace.yaml`, `packages/db/migrations/0000_roles.sql`, `packages/shared/src/brands/resolve.ts`, `packages/domain/src/server/branding.ts`, `apps/admin/instrumentation.ts`, `apps/admin/src/lib/widget-policy.ts`, `apps/admin/src/lib/web-voice-policy.ts`, `apps/admin/app/api/webhooks/twilio/sms/route.ts`, `apps/admin/src/lib/mcp/oauth-config.ts`, `packages/db/src/client.ts`, `packages/domain/src/server/productEvents.ts`, `apps/worker/src/handlers.ts`, `apps/worker/src/scheduler.ts`, `apps/worker/src/calendarJobs.ts`, `packages/providers/src/twilio/twilioProvider.ts`, `packages/embed/src/index.ts`, `scripts/production-smoke.ts`, and Railway's, Docker's, Ubuntu's, PostgreSQL's, Redis's, Node.js's, Hetzner's and DigitalOcean's pages as read on 2026-10-19. [7.22](#722-upgrade-pinned-versions)'s Polar API version and [7.25](#725-routine-maintenance-calendar)'s monthly look at Polar's changelog were added at `35af54b`, checked against `packages/shared/src/billing.ts`, `packages/providers/src/polar/polarBilling.ts` and `polarCatalog.ts`, `packages/domain/src/server/billingPolar.ts` and `docs/providers/polar.md` (fork PR #73). [7.25](#725-routine-maintenance-calendar)'s two Polar token end dates were added at `7d20322` (fork PR #74), and [7.22](#722-upgrade-pinned-versions)'s line numbers in `docs/providers/polar.md` are from `24e211d`.

### 7.27 Reactivate a canceled business

Since fork PR #102 an owner can cancel their account once its first business is the only one they own ([cancel an account](../../features/account-cancellation.md)). Nothing of it is deleted, so you can open it again, such as when the owner changes their mind. Only someone signed in to the database as `postgres` can (the start of Part 7).

1. Find the business's ID. It's in both emails the deployment's inbox got, "Cancellation request" and "Canceled", as **Business ID**. Or list the canceled businesses:

   ```sql
   select id, name, slug, canceled_at from businesses where status = 'canceled' order by canceled_at desc;
   ```

2. Open it again:

   ```sql
   select app.reactivate_business('<business ID>');
   ```

   It answers an error, and changes nothing, when no canceled business has that ID.

What it does:

- Its team can open it again, from the workspace menu. Someone with no other business opens on it.
- Its numbers that haven't gone back to Twilio yet stay with it and answer again.
- The worker picks up its recurring jobs within 5 minutes.
- Its audit log gets `business.reactivated`.

What it doesn't do:

- **Bring the plan back.** A plan paid through Polar was canceled there, so the business is on the free plan until its owner chooses a plan in **Settings** > **Plan**. A plan set by hand (`managed`) is as you left it.
- **Bring back numbers already released.** Buy new ones ([7.21](#721-buy-change-and-release-numbers)).
- **Undo a new start.** An owner who created a business since then keeps it. The reactivated one is older, so it's their first business again, and they can delete the new one from its **Settings** > **Team**.

The cancellation's link stays used. The owner can cancel again from **Settings** > **Team**.

**Not yet confirmed:** a reactivation on a deployed instance. It has been run only by the tests.

**[7.27](#727-reactivate-a-canceled-business) was checked against:** `packages/db/migrations/0130_business_cancellation.sql`, `packages/domain/src/server/businessCancellation.ts` and `packages/domain/src/server/businessCancellation.integration.test.ts` (fork PR #102).

### 7.28 Reset a test environment

`devops/reset-database.mjs` empties a test environment's database so it looks freshly migrated: no accounts, no businesses, no settings and no plans. It's for testing a deployment from its first sign-up again without wiping volumes ([4.10](part-4-test-environment.md#410-keep-the-test-environment-up-to-date)). Never run it on production, and protect production's database from it (below). It came with fork PR #110.

**What it deletes and what it keeps**

- It empties every table in the `public`, `app` and `drizzle` schemas except the two migration histories, `public.__lobbystack_migrations` and `drizzle.__drizzle_migrations`. A fresh migration puts rows in those two and in no other table, so afterwards the database matches one migrate has just set up. CI checks that on every pull request: it migrates a new database, fills it, resets it and compares every table, sequence and both histories with the fresh copy (`scripts/reset-database.integration.test.ts`).
- Gone: every account and sign-in, business, membership, contact, call, message, appointment, knowledge document, phone number record, plan and Polar link, API and widget key and webhook, the deployment's name and logo, and the plans `pnpm billing apply` wrote.
- Kept: the tables, functions, row level security policies and grants, the database's roles and their passwords, the volume's backups, and the services' variables, `PLATFORM_API_KEYS` included.
- Outside the database nothing changes. Numbers stay in your Twilio account and keep costing their monthly fee, subscriptions and customers stay in Polar, and files stay in the bucket. Redis keeps its sign-ins, rate limits and queued jobs unless you add `--redis`: the admin looks sign-ins up in Redis first, so without it a browser signed in before the reset stays signed in as an account that no longer exists (`apps/admin/src/lib/auth.ts:112`).

**Before**

1. Release the test numbers you don't want to keep paying for, with `pnpm lobbystack numbers release` ([7.21](#721-buy-change-and-release-numbers)). Once the database is reset LobbyStack no longer knows them, so release any you forgot in Twilio's console.
2. On an instance that sells plans, cancel the test subscriptions in Polar's sandbox, so Polar stops sending events about businesses that are gone *(Polar's steps not researched)*.
3. Have the code on your computer ([Part 2](part-2-local-development.md)), updated, with `pnpm install` done. The script uses the `pg` and `ioredis` packages the install brings, and needs Node.js 18 or later.

**Run it**

4. In Railway, open the test environment and copy two values from the services' **Variables** tabs: `DATABASE_PUBLIC_URL` on `Postgres`, and `REDIS_PUBLIC_URL` on `Redis`. The `DATABASE_URL` the services use, at `postgres.railway.internal`, works only inside Railway. For the copy on your computer, use `DATABASE_URL` and `REDIS_URL` from `.env` ([2.9](part-2-local-development.md#29-stop-reset-and-update)).
5. In the code folder, run:

   ```sh
   node devops/reset-database.mjs --redis
   ```

   It asks for the database's address, then for Redis's, with typing hidden, so their passwords stay out of your terminal's history. Both can go on the command line instead: `node devops/reset-database.mjs <database URL> --redis <Redis URL>`.
6. It shows the database's name, its server and the user it signed in as, how many migrations it has, and what it holds: the businesses by name, the users, the rows in its tables and the Redis keys. Then it lists what the reset leaves behind: numbers still bought in Twilio, live Polar subscriptions and files in the bucket. Check that the businesses are the test environment's, then type the database's name, `railway` on Railway, to go ahead. Anything else stops it with nothing deleted. With `--dry-run` it shows the same and stops.
7. It empties the tables in one transaction, so either all of them are emptied or none is, and checks that each is empty before it commits. Then it deletes the Redis keys under `lobbystack:`, every key the admin and the worker make; other keys in the same Redis stay. A table the admin or the worker keeps busy makes it wait up to 10 seconds, three times, and a migration in progress stops it.

**After**

8. Redeploy the admin and the worker, from each one's newest deployment, so neither keeps anything from before in memory, such as the deployment's name.
9. Sign up. As on a new instance, the first account to finish onboarding picks the deployment's name and logo ([6.2](part-6-first-run.md#62-the-brand-step)).
10. **Only if the instance sells plans:** the plan screens show the brand's `billing.json` with **Starter** and **Pro** greyed out, as before a first apply. Sign up with the operator key's email and enter the emailed code, since the key works only for a verified account, then run `pnpm billing apply --brand <brand> --polar sandbox` ([3.7](part-3-outside-services.md#37-optional-services), "[Selling plans](part-3-outside-services.md#selling-plans-polar)", steps 5 and 7). It finds the products and the webhook an earlier run made in Polar, by their tags and address, so it should only write the plans back into the database, and `POLAR_WEBHOOK_SECRET` stays as it is *(not yet tried after a reset)*.

**Protect production**

- The script refuses a database linked to Polar's live organization: one with a billing run against Polar production, which `pnpm billing apply --polar live` and the worker's daily check on such an instance record. A test environment's runs say `sandbox`, as long as the admin and the worker have `POLAR_API_BASE_URL` set to Polar's sandbox: without it they count as production (`packages/shared/src/billing.ts:125`). For a test copy of production, `--allow-live-payments` resets it anyway.
- Mark production's database once, with production's `DATABASE_PUBLIC_URL`: `node devops/reset-database.mjs --protect`. Signed in to the database as `postgres` (the start of Part 7), as on a server, `alter database <its name> set lobbystack.reset_protection = 'on';` makes the same mark. From then on the script refuses it, whether or not it sells plans. `--unprotect` takes the mark off, after asking for the database's name. The mark is a setting on the database, `lobbystack.reset_protection`, which nothing else reads. A backup restored into a new database may not carry it ([7.8](#78-restore-from-a-backup-and-practice-it)), so protect the database again after a restore.

| Option | What it does |
| --- | --- |
| `--dry-run` | Shows what would be deleted, and deletes nothing |
| `--redis [<url>]` | Also deletes the deployment's Redis keys. Without the address it asks for it, with typing hidden |
| `--redis-prefix <name>` | The deployment's `REDIS_PREFIX`, when it isn't `lobbystack` |
| `--confirm <database>` | Answers the question with this name, for a run where nobody can type. Another database's name stops it |
| `--allow-live-payments` | Resets a database linked to Polar's live organization anyway |
| `--protect`, `--unprotect` | Marks the database so the script refuses it, or takes the mark off, and changes nothing else |

| It stops with | Why | What to do |
| --- | --- | --- |
| `isn't a LobbyStack database` | The database has no `__lobbystack_migrations` table | Check the address: the database's name is its last part, `railway` on Railway |
| `isn't a superuser` | Row level security would hide rows from that user | Use `DATABASE_PUBLIC_URL`, which signs in as `postgres` |
| `is protected against resets` | Someone marked it with `--protect` | Check that it really is a test database, then run `--unprotect` |
| `linked to Polar's live organization` | A billing run went to Polar production: real payments, or a test environment whose worker has no `POLAR_API_BASE_URL` | Check the address and the variable. Only for a test environment or a test copy of production, add `--allow-live-payments` |
| `a migration is running` | migrate holds its lock | Run it again once migrate's deployment has finished |
| `kept a table busy` | The admin or the worker held a table for about half a minute | Run it again in a quiet moment, or with the admin's and the worker's deployments removed ([4.10](part-4-test-environment.md#410-keep-the-test-environment-up-to-date)) |
| `couldn't check ... certificate` | `sslmode=require` in the address makes the `pg` package check the certificate, and Railway's is its own | End the address with `?sslmode=no-verify` |
| `works only inside Railway` | The address is the internal `DATABASE_URL` | Use `DATABASE_PUBLIC_URL` |

Each says `Nothing was deleted.` The script exits with 0 when it finished or a dry run ended, 1 when it stopped, and 2 for a mistake in its options.

**Not yet confirmed:** a run against Railway's Postgres and Redis. The script has run only against a local PostgreSQL 16 and Redis 7, and in CI. Whether Railway's public address needs `?sslmode=no-verify`.

**[7.28](#728-reset-a-test-environment) was checked against:** `devops/reset-database.mjs`, `scripts/reset-database.integration.test.ts`, `packages/db/src/cli.ts`, `packages/db/src/migrations/raw-migrations.ts`, `packages/db/migrations/0098_deployment_branding.sql`, `packages/db/migrations/0108_billing_catalog.sql`, `apps/admin/src/lib/auth.ts`, `apps/admin/src/lib/redis.ts` and `packages/jobs/src/index.ts` (fork PR #110).
