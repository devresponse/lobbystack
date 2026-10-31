# Appendix B. Command cheat sheet

The commands this guide uses, in one place. Each one names the section that explains it: read that section the first time, since it says what the command should print and what to do when it doesn't. Replace each `<…>` with your own value, and don't type a password or key where others can see your screen.

**On your computer** ([Part 2](part-2-local-development.md)), in the `lobbystack` folder:

| To | Run | See |
| --- | --- | --- |
| Install pnpm | `npm install --global pnpm@12.15.0` | [2.2](part-2-local-development.md#22-install-the-tools) |
| Check the tools | `git --version`, `docker compose version`, `node --version`, `pnpm --version` | [2.2](part-2-local-development.md#22-install-the-tools) |
| Get the code | `git clone https://github.com/devresponse/lobbystack.git`, or your own fork's address ([1.4](part-1-prepare.md#14-get-the-code)), then `cd lobbystack` | [2.3](part-2-local-development.md#23-get-the-code-and-create-your-settings-file) |
| Install, and make the settings file | `pnpm install`, then `pnpm env:generate` | [2.3](part-2-local-development.md#23-get-the-code-and-create-your-settings-file) |
| Start the database and Redis | `docker compose up -d postgres redis` | [2.4](part-2-local-development.md#24-way-a-run-from-source) |
| Set up or update the database | `pnpm db:migrate` | [2.4](part-2-local-development.md#24-way-a-run-from-source) |
| Build the two packages the dashboard needs | `pnpm --filter @lobbystack/telemetry build`, then `pnpm --filter @lobbystack/shared build` | [2.4](part-2-local-development.md#24-way-a-run-from-source) |
| Run the apps (Way A) | `pnpm dev`, and Ctrl+C to stop | [2.4](part-2-local-development.md#24-way-a-run-from-source) |
| Run everything in Docker (Way B) | `docker compose --env-file .env --env-file .env.local up -d --build` | [2.5](part-2-local-development.md#25-way-b-run-everything-in-docker) |
| See Way B's services, and follow their logs | `docker compose ps`, `docker compose logs -f admin worker` | [2.5](part-2-local-development.md#25-way-b-run-everything-in-docker) |
| Catch the emails it sends | `docker compose --profile development up -d mailpit` | [2.7](part-2-local-development.md#27-optional-extras) |
| Add a demo business | `pnpm db:seed` | [2.7](part-2-local-development.md#27-optional-extras) |
| Check a change before a pull request | `pnpm typecheck`, `pnpm test`, `pnpm build` | [2.8](part-2-local-development.md#28-run-the-checks-before-you-ship-a-change) |
| Check a change to the database | `pnpm db:check`, `pnpm db:verify-rls` | [2.8](part-2-local-development.md#28-run-the-checks-before-you-ship-a-change) |
| Check a change to how calls behave | `pnpm voice:eval`, then `pnpm voice:call` against the test environment | [2.8](part-2-local-development.md#28-run-the-checks-before-you-ship-a-change) |
| Stop the database and Redis, keeping the data | `docker compose stop` | [2.9](part-2-local-development.md#29-stop-reset-and-update) |
| Get the newest code | `git pull`, `pnpm install`, `pnpm db:migrate`, the two build commands, then `pnpm dev` | [2.9](part-2-local-development.md#29-stop-reset-and-update) |
| **Delete all local data** and start over | `docker compose down -v` | [2.9](part-2-local-development.md#29-stop-reset-and-update) |
| **Empty a test environment's database** and Redis, keeping the tables | `node devops/reset-database.mjs --redis`, then paste the database's and Redis's addresses when it asks | [7.28](part-7-operations.md#728-reset-a-test-environment) |
| Protect production's database from that | `node devops/reset-database.mjs --protect`, then paste production's database address | [7.28](part-7-operations.md#728-reset-a-test-environment) |
| Make new local passwords | `pnpm env:generate --force`, then `docker compose down -v` | [2.9](part-2-local-development.md#29-stop-reset-and-update) |
| Add a brand, after editing `brands/` | `pnpm brands:build` | [3.6](part-3-outside-services.md#36-your-brand) |
| Build the website chat's loader again | `pnpm widget:embed:build` | [8.7](part-8-troubleshooting.md#87-the-website-chat) |

**Passwords and secrets** ([4.3](part-4-test-environment.md#43-make-the-passwords-and-secrets)). Each prints a new 64-character value: `openssl rand -hex 32` on a Mac, on Linux or in Git Bash, or `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` wherever Node.js is installed.

**Releases**, from the copy of the code on your computer:

| To | Run | See |
| --- | --- | --- |
| Create `production` the first time | `git fetch origin`, then `git push origin <commit ID>:refs/heads/production` | [5.2](part-5-production.md#52-production-on-railway), step 2 |
| Release a tested commit | `git fetch origin`, then `git push origin <commit ID>:production` | [7.1](part-7-operations.md#71-release-a-new-version) |
| Go back to an earlier commit | `git fetch origin`, then `git push --force origin <the earlier commit ID>:production` | [7.5](part-7-operations.md#75-roll-back-a-bad-release) |
| Check a test environment from outside | `pnpm smoke:production`, with its values on the same line | [4.9](part-4-test-environment.md#49-smoke-test) |

**On Railway**, with Railway's command-line tool and an SSH key registered with Railway ([7.8](part-7-operations.md#78-restore-from-a-backup-and-practice-it)):

| To | Run | See |
| --- | --- | --- |
| Open a shell in the database's service | `railway ssh --service Postgres --environment production`, then `psql -U postgres -d lobbystack` | [Part 7](part-7-operations.md), "Signing in to the database" |
| Save a day of the admin's log | `railway logs --service admin --environment production --since 24h --json > admin.json` | [7.11](part-7-operations.md#711-logs-error-ids-and-following-one-call) |
| Restore the copy from Cloudflare | The two commands in [7.8](part-7-operations.md#78-restore-from-a-backup-and-practice-it), step 4 | [7.8](part-7-operations.md#78-restore-from-a-backup-and-practice-it) |

Most of the work on Railway is done in its dashboard, not with commands: deploys ([4.10](part-4-test-environment.md#410-keep-the-test-environment-up-to-date), [7.1](part-7-operations.md#71-release-a-new-version)), settings ([7.6](part-7-operations.md#76-change-a-setting-safely)), backups ([7.7](part-7-operations.md#77-back-up-the-database-and-files)) and logs ([7.11](part-7-operations.md#711-logs-error-ids-and-following-one-call)).

**On a server** ([5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose)), signed in with `ssh root@<the server's IP address>`, in `/root/lobbystack`:

| To | Run | See |
| --- | --- | --- |
| See every service and its health | `docker compose ps -a` | [5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose), step 20 |
| Check the admin and the worker | `curl -fsS http://127.0.0.1:13000/api/health/ready`, `curl -fsS http://127.0.0.1:13002/health/ready` | [5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose), step 20 |
| Check the deployment mode | `docker compose exec admin printenv DEPLOYMENT_MODE` | [5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose), step 20 |
| Read the last hour's logs | `docker compose logs --since 1h admin worker` | [7.11](part-7-operations.md#711-logs-error-ids-and-following-one-call) |
| Read one service's latest lines | `docker compose logs --tail 100 worker`, or `admin`, `caddy`, `postgres` | [7.14](part-7-operations.md#714-incident-basics-who-acts-what-to-check-first-how-to-tell-users), [7.16](part-7-operations.md#716-worker-crash-and-stuck-calls) |
| Check the database's structure and security | The two commands in [5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose), step 22 | [5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose), step 22 |
| Apply a changed setting | `docker compose up -d`; for a value built into the dashboard, `SERVICE_VERSION=$(git rev-parse --short HEAD) docker compose up -d --build` | [7.6](part-7-operations.md#76-change-a-setting-safely) |
| Make a backup now | `REPLACEMENT_COMPOSE_PROJECT=lobbystack bash scripts/replacement-backup.sh` | [7.7](part-7-operations.md#77-back-up-the-database-and-files) |
| List the backups | `ls /root/lobbystack/.replacement-backups` | [7.8](part-7-operations.md#78-restore-from-a-backup-and-practice-it) |
| Restore a backup | The command in [7.8](part-7-operations.md#78-restore-from-a-backup-and-practice-it), "On a server" | [7.8](part-7-operations.md#78-restore-from-a-backup-and-practice-it) |
| Sign in to the database | `docker compose exec postgres psql -U postgres -d lobbystack`, and `\q` to leave | [Part 7](part-7-operations.md), "Signing in to the database" |
| Restart Redis | `docker compose restart redis`, then the worker the same way | [7.14](part-7-operations.md#714-incident-basics-who-acts-what-to-check-first-how-to-tell-users) |
| Check the free disk space | `df -h /` | [7.25](part-7-operations.md#725-routine-maintenance-calendar) |
| Remove old images | `docker image prune -f` | [7.25](part-7-operations.md#725-routine-maintenance-calendar) |
| Stop everything for a restart of the server | `docker compose stop`, then `reboot`; afterwards `docker compose up -d` | [7.25](part-7-operations.md#725-routine-maintenance-calendar) |
| Install the system's updates | `apt update && apt upgrade`, reading the list before you confirm | [7.25](part-7-operations.md#725-routine-maintenance-calendar) |

The update to a new release, in order ([7.1](part-7-operations.md#71-release-a-new-version), step 8):

```sh
cd /root/lobbystack
REPLACEMENT_COMPOSE_PROJECT=lobbystack bash scripts/replacement-backup.sh
git pull --ff-only
export SERVICE_VERSION=$(git rev-parse --short HEAD)
docker compose build
docker compose run --rm migrator
docker compose up -d
```

Going back to an earlier release, once `production` has moved back on GitHub ([7.5](part-7-operations.md#75-roll-back-a-bad-release)):

```sh
cd /root/lobbystack
git fetch origin
git reset --hard origin/production
SERVICE_VERSION=$(git rev-parse --short HEAD) docker compose up -d --build
```

Finding one error or one call in the logs ([7.11](part-7-operations.md#711-logs-error-ids-and-following-one-call)):

```sh
docker compose logs --since 24h admin | grep <error ID>
docker compose logs --since 24h admin worker | grep -e <call ID> -e <session ID>
```

**From any computer.** The addresses open in a browser, and the `pnpm` commands run in the code folder from [Part 2](part-2-local-development.md):

| To | Open, or run | See |
| --- | --- | --- |
| See whether the admin works, and what it reaches | `https://<your address>/api/health/ready` | [7.10](part-7-operations.md#710-health-checks-and-uptime-monitoring) |
| See which version runs | `https://<your address>/api/health/live` | [7.10](part-7-operations.md#710-health-checks-and-uptime-monitoring) |
| Sign the `lobbystack` command in | `pnpm lobbystack login --url https://<your address> --key-stdin` | [6.7](part-6-first-run.md#67-optional-the-api-and-the-command-line) |
| See a business's numbers, team or calendars | `pnpm lobbystack numbers list`, `pnpm lobbystack team list`, `pnpm lobbystack calendar list --json` | [6.7](part-6-first-run.md#67-optional-the-api-and-the-command-line), [8.9](part-8-troubleshooting.md#89-google-calendar) |
| Make a platform key | `pnpm platform-key:create --name "Operator key" --partner operator --owner-email <your email> --access all`. If the admin already has platform keys, start the line with `PLATFORM_API_KEYS='<the value now on the admin>'` | [6.7](part-6-first-run.md#67-optional-the-api-and-the-command-line) |
| Set Polar up from the brand's `billing.json`, or after a change to it | `pnpm billing plan --brand <brand> --polar sandbox`, then the same with `apply` in place of `plan` and `--railway-file .env.railway` at the end. For production, `--polar live --profile production` | [3.7](part-3-outside-services.md#37-optional-services), "[Selling plans](part-3-outside-services.md#selling-plans-polar)" |
| Check that `billing.json`, the billing tables and Polar agree | `pnpm billing verify --brand <brand> --polar sandbox`: exit 0 in sync, 1 a difference, 2 Polar couldn't be read | [3.7](part-3-outside-services.md#37-optional-services), "[Selling plans](part-3-outside-services.md#selling-plans-polar)"; [7.12](part-7-operations.md#712-alerts-and-how-to-respond) |
| See the plans customers are shown, and which prices checkout can sell | `pnpm lobbystack billing plans`, with a key that has `billing:manage`; with the operator's key, add `--business <ID>`. The API call is `GET /api/v1/billing/plans` | [3.7](part-3-outside-services.md#37-optional-services), "[Selling plans](part-3-outside-services.md#selling-plans-polar)", step 8 |
| Issue a promo code, list codes, or revoke one | `pnpm lobbystack billing code-create <plan> --max-uses <number> --expires-at <date>`, or `--business-id <ID>` for one business; `pnpm lobbystack billing codes`; `pnpm lobbystack billing code-revoke <code ID>`. With the operator's key | [3.7](part-3-outside-services.md#37-optional-services), "[Selling plans](part-3-outside-services.md#selling-plans-polar)" |

**Never run these on production:**

- `docker compose down -v` or `docker volume prune --all`: they delete the database, the recordings and the certificate ([5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose), "From now on").
- `bash scripts/replacement-restore-drill.sh` on an instance in use: its restore throws away everything written while it runs ([5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose), step 26).
- `docker compose config` where others can see your screen: it prints every secret ([5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose), step 18).
- `git push --force` to `production` without checking the compare page first ([7.1](part-7-operations.md#71-release-a-new-version), step 6).
