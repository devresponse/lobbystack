# Appendix A. Variables by service

**Status:** checked on 2026-10-19 against the code at `d18f916`; `WEB_CALL_MAX_DURATION_MS` was updated on 2026-10-20 for fork PR #54 (`9b66d01`), and the Polar lines on 2026-10-22 for fork PRs #59 (`a44f995`), #60 (`a6ff674`), #61 (`b6ba2aa`) and #62 (`a067534`), and on 2026-10-23 for #66 (`d800141`) and #69 (`91d5c3a`), and on 2026-10-24 for #72 (`cc0c65d`), #73 (`35af54b`) and #74 (`7d20322`), and `BRAND_PRESET` and `BRAND_REQUIRED` on 2026-10-27 for #87. Every variable that the admin, the worker and migrate read was found in the code, and `.env.example`, `docker-compose.yml`, the three Dockerfiles and `.railway/template.ts` were read line by line. Nothing was deployed for it.

This appendix is for looking a setting up. [Part 4](part-4-test-environment.md) (on Railway) and [5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose) (on a server) say which ones to set, and when. Here, each one has the services it goes on, where its value comes from, and what changing it later does. The ones to leave alone come last, so you know what they are when you see them in `.env`.

**How to read the tables**

- **On:** the services it goes on. "The same" means the admin and the worker must have the same value ([7.6](part-7-operations.md#76-change-a-setting-safely)).
- **Value:**
  - **Make it:** a random value you make, numbered as in [4.3](part-4-test-environment.md#43-make-the-passwords-and-secrets). On a server, `generate-env.mjs` made it ([5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose), step 13).
  - A section number, such as **[3.2](part-3-outside-services.md#32-openai)**: the value a provider gives you there.
  - A value written `like this`: type exactly that.
  - **The worker refers to the admin's:** on Railway, a line such as `ENCRYPTION_KEY=${{admin.ENCRYPTION_KEY}}`, which copies the admin's value, so the two can't differ ([4.6](part-4-test-environment.md#46-add-the-admin-and-the-worker), step 5).
  - **Unset:** don't add it on Railway. On a server, leave its line in `.env` as it is.
- **Changing it later:**
  - **Any time:** change it the usual way ([7.6](part-7-operations.md#76-change-a-setting-safely)).
  - **Rebuild:** it's built into the admin, so only a rebuild applies a change ([7.6](part-7-operations.md#76-change-a-setting-safely)).
  - Otherwise, it says what a change breaks, and where the steps are.

**Where each service's variables are set**

| Service | On Railway | On a server |
| --- | --- | --- |
| `Postgres` (`postgres` on a server) | [4.4](part-4-test-environment.md#44-add-postgresql-redis-and-the-bucket), step 5 | The `POSTGRES_PASSWORD` and `LOBBYSTACK_…_PASSWORD` lines at the top of `.env`, read once, at its first start |
| `Redis` (`redis` on a server) | [4.4](part-4-test-environment.md#44-add-postgresql-redis-and-the-bucket), step 9 | Nothing: a server's Redis has no password |
| `migrate` (`migrator` on a server) | [4.5](part-4-test-environment.md#45-add-the-migrate-service-and-set-up-the-database), step 2 | `docker-compose.yml` makes its database address from `POSTGRES_PASSWORD` |
| `admin` | [4.6](part-4-test-environment.md#46-add-the-admin-and-the-worker), step 4, with the additions in [4.6](part-4-test-environment.md#46-add-the-admin-and-the-worker), step 6, and [4.8](part-4-test-environment.md#48-connect-the-providers-to-this-environment); in production, the changes in [5.2](part-5-production.md#52-production-on-railway), steps 9 and 15 | `.env`, changed in [5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose), steps 15 and 23, and the override file ([5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose), step 17) |
| `worker` | [4.6](part-4-test-environment.md#46-add-the-admin-and-the-worker), step 5, then the same places as the admin | The same |
| The backup service, in production | [5.2](part-5-production.md#52-production-on-railway), step 20 | Nothing: the backups are a script ([5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose), step 27) |

On a server, every service reads the one `.env` file, but only the lines that `docker-compose.yml` or your override file hands it ([7.6](part-7-operations.md#76-change-a-setting-safely)). Some of `.env`'s lines, such as `DATABASE_URL`, `REDIS_URL`, `WORKER_INTERNAL_URL` and `LOCAL_STORAGE_PATH`, are for running on your computer ([Part 2](part-2-local-development.md)): `docker-compose.yml` gives the services values of its own instead.

**Built into the admin**

`APP_BASE_URL`, `BRAND_PRESET`, `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, `NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN` and `NEXT_PUBLIC_POSTHOG_HOST` are built into the admin, and on Railway also `STORAGE_PROVIDER`, `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION` and `S3_FORCE_PATH_STYLE` (`Dockerfile.admin:19-42`, `docker-compose.yml:93-100`). Set them before the admin's first build. Every other value takes effect when its service starts again ([7.6](part-7-operations.md#76-change-a-setting-safely)).

**The instance**

| Variable | On | What it's for | Value | Changing it later |
| --- | --- | --- | --- | --- |
| `NODE_ENV` | migrate, the admin and the worker | Production mode, with its start-up checks and secure sign-in cookies | `production`. The images set it too | Leave it: any other value turns the checks off |
| `DEPLOYMENT_MODE` | The admin | Whether new businesses get plans and billing ([1.3](part-1-prepare.md#13-decide-these-before-any-data-exists)) | `self_hosted_standard`, or `cloud` to sell plans. The worker doesn't read it; this guide sets it there too, which does no harm | It applies to businesses created afterwards. [8.12](part-8-troubleshooting.md#812-a-business-on-the-free-plan-by-mistake) moves an existing one |
| `APP_BASE_URL` | The admin and the worker, the same | The address. It picks the brand, and goes into sign-in, emails and each new number's texting address | [3.1](part-3-outside-services.md#31-choose-your-addresses), with no slash at the end. The worker refers to the admin's | Rebuild, and follow [7.23](part-7-operations.md#723-change-the-domain-or-the-brand) |
| `SITE_URL`, `AUTH_TRUSTED_ORIGINS` | The admin | More addresses to trust besides `APP_BASE_URL`. `SITE_URL` also goes into affiliate links | `${{APP_BASE_URL}}` on Railway. Unset on a server, where `docker-compose.yml` doesn't pass them | They follow `APP_BASE_URL` |
| `BRAND_PRESET` | The admin and the worker, the same | The brand, where no brand file claims the address ([3.6](part-3-outside-services.md#36-your-brand)). Unset there, the only brand besides LobbyStack, AlloPlace, stands in | The brand's folder name, such as `lobbystack`, or unset | Rebuild. Delete it once a brand file claims the address ([5.2](part-5-production.md#52-production-on-railway), step 9) |
| `BRAND_REQUIRED` | The admin and the worker | Refuse to start when no brand file applies ([7.23](part-7-operations.md#723-change-the-domain-or-the-brand)) | Unset, or `true`. On a server, only through the override file | Any time |
| `PORT` | The admin and the worker | The port each one listens on | `3000` on the admin, `3002` on the worker. On a server, `docker-compose.yml` sets them | Leave it |
| `HOSTNAME` | The admin | Lets Railway's private network reach the admin | `::` on Railway. Unset on a server | Leave it |
| `RAILWAY_DOCKERFILE_PATH` | migrate, the admin and the worker, on Railway | Which Dockerfile builds the service | `Dockerfile.migrator`, `Dockerfile.admin` or `Dockerfile.worker` | Leave it |
| `SERVICE_VERSION` | migrate, the admin and the worker | The version `/api/health/live` shows | Unset on Railway, which names the commit itself. On a server, the commands in [5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose) set it on the same line | Set again at every build |

**Passwords and secrets**

In production, the admin and the worker refuse to start when a secret they need is missing, shorter than 32 characters, or still a `replace-with-…` placeholder ([4.6](part-4-test-environment.md#46-add-the-admin-and-the-worker), "If the first deploy fails"). [7.18](part-7-operations.md#718-rotate-secrets-and-keys) says what changing each one breaks.

| Variable | On | What it's for | Value | Changing it later |
| --- | --- | --- | --- | --- |
| `BETTER_AUTH_SECRET` | The admin | Signs sign-in sessions | Make it (value 7) | Signs everyone out ([7.18](part-7-operations.md#718-rotate-secrets-and-keys)) |
| `ENCRYPTION_KEY` | The admin and the worker, the same | Encrypts stored keys, calendar connections and webhook secrets | Make it (value 8). The worker refers to the admin's | Only after a leak: it breaks all of those ([7.18](part-7-operations.md#718-rotate-secrets-and-keys)) |
| `INTERNAL_SERVICE_SECRET` | The admin | Signs short-lived values, such as the end of a browser call | Make it (value 9) | Any time ([7.18](part-7-operations.md#718-rotate-secrets-and-keys)) |
| `INTERNAL_SERVICE_TOKEN` | The admin and the worker, the same | Lets the admin hand each call to the worker | Make it (value 10). The worker refers to the admin's | At a quiet hour: calls fail while the two differ ([7.18](part-7-operations.md#718-rotate-secrets-and-keys)) |
| `NUMBER_CLAIM_TOKEN_SECRET` | The admin | Signs the numbers a search offers, so that only those can be picked | Make it (value 11) | Any time ([7.18](part-7-operations.md#718-rotate-secrets-and-keys)) |
| `OTP_HASH_SECRET` | The admin and the worker, the same | Protects email codes and callers' keypad PINs | Make it (value 12). The worker refers to the admin's | Only after a leak: every saved PIN stops working ([7.18](part-7-operations.md#718-rotate-secrets-and-keys)) |
| `WIDGET_SESSION_SECRET` | The admin | Signs website chat sessions | Make it (value 13) | At a quiet hour ([7.18](part-7-operations.md#718-rotate-secrets-and-keys)) |
| `LOCAL_STORAGE_SIGNING_SECRET` | The admin and the worker, the same, on a server only | Signs links to the recordings and files on the server's disk | `generate-env.mjs` makes it. On Railway, `STORAGE_PROVIDER=s3` makes it unneeded | Any time ([7.18](part-7-operations.md#718-rotate-secrets-and-keys)) |

**The database**

| Variable | On | What it's for | Value | Changing it later |
| --- | --- | --- | --- | --- |
| `PGDATA`, `POSTGRES_DB`, `POSTGRES_USER` | `Postgres`, on Railway | Where PostgreSQL keeps its data, the database's name, and its administrator's name | `/var/lib/postgresql/data/pgdata`, `lobbystack` and `postgres` ([4.4](part-4-test-environment.md#44-add-postgresql-redis-and-the-bucket), step 5). On a server, `docker-compose.yml` sets the last two | Never |
| `POSTGRES_PASSWORD` | `Postgres`; the database addresses of migrate and the backup service refer to it | The administrator's password, which only migrate and the backups use | Make it (value 1) | Inside PostgreSQL first ([7.18](part-7-operations.md#718-rotate-secrets-and-keys)) |
| `LOBBYSTACK_AUTH_PASSWORD`, `LOBBYSTACK_APP_PASSWORD`, `LOBBYSTACK_WORKER_PASSWORD`, `LOBBYSTACK_DISPATCHER_PASSWORD` | `Postgres`, which holds them; migrate, the admin and the worker refer to them | The passwords of the four roles the services sign in as | Make them (values 2 to 5) | On Railway, at a quiet hour; on a server, inside PostgreSQL first ([7.18](part-7-operations.md#718-rotate-secrets-and-keys)) |
| `LOBBYSTACK_MIGRATOR_PASSWORD`, `LOBBYSTACK_READONLY_PASSWORD` | `Postgres`, on a server only | Two roles that nothing signs in as | `generate-env.mjs` makes them. Railway doesn't need them ([4.3](part-4-test-environment.md#43-make-the-passwords-and-secrets)) | Leave them |
| `DATABASE_URL` | migrate, the admin and the worker, each its own | How each one reaches the database, and as which role | On Railway, the lines in [4.5](part-4-test-environment.md#45-add-the-migrate-service-and-set-up-the-database), step 2, and [4.6](part-4-test-environment.md#46-add-the-admin-and-the-worker), steps 4 and 5, made of references. On a server, `docker-compose.yml` makes them | They follow the passwords |
| `LOBBYSTACK_APP_POOL_MAX` and the other `LOBBYSTACK_…_POOL_MAX` | The admin and the worker | How many database connections each role opens | Unset: 12 for each role, and 4 for the dispatcher | For someone technical, before adding copies ([7.24](part-7-operations.md#724-scale-up)) |

The admin signs in with all four roles, and the worker with the worker and dispatcher ones. On Railway, migrate gives the four roles their passwords on every run ([4.5](part-4-test-environment.md#45-add-the-migrate-service-and-set-up-the-database)); on a server, PostgreSQL takes all seven at its first start, and nothing changes them afterwards ([5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose), step 15). `VERIFY_RLS_BEHAVIOR=true` appears inside migrate's command ([4.5](part-4-test-environment.md#45-add-the-migrate-service-and-set-up-the-database), step 3), not among its variables.

**Redis**

| Variable | On | What it's for | Value | Changing it later |
| --- | --- | --- | --- | --- |
| `REDIS_PASSWORD` | `Redis`, on Railway | Redis's password | Make it (value 6) | At a quiet hour ([7.18](part-7-operations.md#718-rotate-secrets-and-keys)) |
| `REDIS_URL` | The admin and the worker, the same | How both reach Redis | On Railway, the same line on both, made of references ([4.6](part-4-test-environment.md#46-add-the-admin-and-the-worker)). On a server, `docker-compose.yml` sets it | It follows the password |
| `REDIS_PREFIX` | The admin and the worker, the same | The names both give their data in Redis | Unset, for `lobbystack` | Leave it ([7.6](part-7-operations.md#76-change-a-setting-safely)) |

**Recordings and files**

| Variable | On | What it's for | Value | Changing it later |
| --- | --- | --- | --- | --- |
| `STORAGE_PROVIDER` | The admin and the worker, the same | Where recordings and uploaded files are kept | `s3` on Railway, for the bucket. `local` on a server, for its disk | Never once there are files: nothing moves them ([7.6](part-7-operations.md#76-change-a-setting-safely)) |
| `S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | The admin and the worker, the same | The bucket and its keys | On Railway, references to `Bucket` ([4.6](part-4-test-environment.md#46-add-the-admin-and-the-worker)). On a server, leave `.env`'s lines as they are: they do nothing while `STORAGE_PROVIDER` is `local` | Never once there are files |
| `S3_FORCE_PATH_STYLE` | The admin and the worker, the same | How the bucket's addresses are written | `false` | Leave it |
| `LOCAL_STORAGE_PATH` | The admin and the worker, the same, on a server only | The folder for files on the server's disk | `docker-compose.yml` sets it, on a volume of its own | Leave it |

**Calls and AI**

| Variable | On | What it's for | Value | Changing it later |
| --- | --- | --- | --- | --- |
| `OPENAI_API_KEY` | The admin and the worker, the same | Calls, the chat's answers and knowledge search | [3.2](part-3-outside-services.md#32-openai), `sk-…`. The worker refers to the admin's | Any time, with a new key from the same project ([7.18](part-7-operations.md#718-rotate-secrets-and-keys)) |
| `OPENAI_WEBHOOK_SECRET` | The admin | Checks that each phone call comes from OpenAI | [3.2](part-3-outside-services.md#32-openai), `whsec_…`, once the address works ([4.8](part-4-test-environment.md#48-connect-the-providers-to-this-environment)) | [7.18](part-7-operations.md#718-rotate-secrets-and-keys) |
| `LIVE_PROTOTYPE_ENABLED` | The admin and the worker, the same | Turns calls on | `true` | Leave it ([7.6](part-7-operations.md#76-change-a-setting-safely)) |
| `WORKER_INTERNAL_URL` | The admin | The worker's private address, where the admin hands it each call | `http://${{worker.RAILWAY_PRIVATE_DOMAIN}}:3002` on Railway. On a server, `docker-compose.yml` sets it | Leave it |
| `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` | The worker, on Railway | Lets calls finish when a deploy replaces the worker | `1860` | Leave it ([7.4](part-7-operations.md#74-deploy-without-cutting-off-calls)) |
| `LIVE_DRAIN_TIMEOUT_MS` | The worker | How long calls go on when the worker stops | Unset. On a server, the override file passes it, empty | Leave it unset ([7.4](part-7-operations.md#74-deploy-without-cutting-off-calls)) |
| `WEB_CALL_MAX_DURATION_MS` | The admin | How long a call from the browser may last | Unset, for 30 minutes, or less, in milliseconds ([5.1](part-5-production.md#51-what-changes-from-the-test-environment)). Before `9b66d01`, unset meant 5 minutes. On a server, the override file passes it | Any time |
| `LIVE_RECORDED_GREETING` | The admin | Opens calls from the browser with a recording of the greeting | Unset, or `true` ([4.6](part-4-test-environment.md#46-add-the-admin-and-the-worker), step 6) | Any time |
| `AI_DELEGATION_SERVICE_TIER` | The worker | OpenAI's faster tier for answers during calls, at twice the price ([3.2](part-3-outside-services.md#32-openai)) | Unset, for `priority` | Any time. `default` halves that part of the bill, and callers wait longer for answers ([7.13](part-7-operations.md#713-costs-and-usage-limits)) |
| `AI_CHAT_…`, `AI_SUMMARY_…`, the other `AI_DELEGATION_…` | The admin and the worker | Another text model for the chat, call summaries and answers during calls, its settings, and its prices | Unset: `gpt-6-luna` at OpenAI, through `OPENAI_API_KEY` ([3.2](part-3-outside-services.md#32-openai)). On a server, leave `.env`'s lines as they are | A job for a developer: another model changes how the receptionist answers |
| `AI_EMBEDDING_…` | The admin and the worker, the same | Another model for indexing knowledge | Unset. On a server, leave `.env`'s lines as they are | On both at once, if ever. At its next start, the worker indexes every business's knowledge again, and until it's done, searches match words only (`apps/worker/src/index.ts:258-270`, `packages/domain/src/server/knowledge.ts:489-491`) |

**Twilio and texts**

| Variable | On | What it's for | Value | Changing it later |
| --- | --- | --- | --- | --- |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | The admin and the worker, the same | The Twilio subaccount, for numbers and texts, and to check that requests come from Twilio | [3.3](part-3-outside-services.md#33-twilio), step 5. The worker refers to the admin's | The token: [7.18](part-7-operations.md#718-rotate-secrets-and-keys). Keep the subaccount: the numbers are in it |
| `TWILIO_SIP_TRUNK_SID` | The worker | The trunk that each new number joins, and where the worker finds each phone call's cost | [3.3](part-3-outside-services.md#33-twilio), step 9, `TK…` | Don't: only numbers bought afterwards would join a new trunk, and the costs of calls to the older ones would no longer be recorded (`apps/worker/src/handlers.ts:590`; inferred) |
| `TWILIO_SMS_WEBHOOK_URL` | The admin | The address Twilio sends texts to, which the admin checks Twilio's signature against | `${{APP_BASE_URL}}/api/webhooks/twilio/sms` on Railway. On a server, typed out ([5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose), step 15) | With the address ([7.23](part-7-operations.md#723-change-the-domain-or-the-brand)) |
| `TWILIO_STATUS_CALLBACK_URL` | The admin and the worker, the same | Where Twilio reports whether each text arrived | `${{APP_BASE_URL}}/api/webhooks/twilio/status` on Railway, and the worker refers to the admin's. On a server, typed out | With the address ([7.23](part-7-operations.md#723-change-the-domain-or-the-brand)) |
| `TWILIO_ALERT_SMS_FROM` | The admin and the worker, the same | Only if the instance sells plans: the shared number cloud businesses text from | [3.3](part-3-outside-services.md#33-twilio), step 18. The worker refers to the admin's | Only to another number that's set up as in [3.3](part-3-outside-services.md#33-twilio), steps 18 to 20 |

**Email**

| Variable | On | What it's for | Value | Changing it later |
| --- | --- | --- | --- | --- |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USERNAME` | The worker | The email service | [3.4](part-3-outside-services.md#34-email): with Resend, `smtp.resend.com`, `587`, `false` and `resend` | Any time |
| `SMTP_PASSWORD` | The worker | The email service's key | [3.4](part-3-outside-services.md#34-email), such as Resend's `re_…` key | Any time ([7.18](part-7-operations.md#718-rotate-secrets-and-keys)) |
| `EMAIL_FROM` | The worker | The sender | [3.4](part-3-outside-services.md#34-email): an address on your verified domain | Any time |
| `EMAIL_REPLY_TO` | The worker | Where replies to the emails go | Unset, or an address ([3.4](part-3-outside-services.md#34-email)) | Any time |
| `FEEDBACK_TO_EMAIL` | The admin | Where feedback sent from the dashboard goes | Unset, or your address ([3.4](part-3-outside-services.md#34-email)). On a server, the override file passes it | Any time |

**Sign-up and access**

| Variable | On | What it's for | Value | Changing it later |
| --- | --- | --- | --- | --- |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | The admin | Shows Turnstile's check on the sign-up page | [3.5](part-3-outside-services.md#35-cloudflare-turnstile). It isn't secret | Rebuild |
| `TURNSTILE_SECRET_KEY` | The admin | Checks Turnstile's answer | [3.5](part-3-outside-services.md#35-cloudflare-turnstile) | Any time ([7.18](part-7-operations.md#718-rotate-secrets-and-keys)) |
| `REQUIRE_EMAIL_VERIFICATION` | The admin | Sign-in needs the email code | Unset on test; `true` in production ([5.1](part-5-production.md#51-what-changes-from-the-test-environment)) | Any time ([6.1](part-6-first-run.md#61-create-your-account)) |
| `TRUSTED_CLIENT_IP_HEADER` | The admin | Where to find each visitor's IP address, for the limits per visitor ([3.1](part-3-outside-services.md#31-choose-your-addresses)) | `x-real-ip` on Railway, and on a server with the Caddyfile from [5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose), step 16 | Leave it |
| `WIDGET_KEY_ISSUANCE_ENABLED` | The admin | Lets businesses create website chat keys | `true`, or unset to refuse new ones ([5.1](part-5-production.md#51-what-changes-from-the-test-environment)) | Any time: existing keys keep working |
| `PUBLIC_API_RATE_LIMIT_PER_MINUTE` | The admin | Requests a minute for each API key | Unset, for 120 | Any time |
| `PLATFORM_API_KEYS` | The admin | Platform keys, for partners who set up businesses through the API ([6.7](part-6-first-run.md#67-optional-the-api-and-the-command-line)) | Unset, or what `pnpm platform-key:create` prints | Any time. A mistake in it stops every platform key ([7.18](part-7-operations.md#718-rotate-secrets-and-keys)) |
| `BETTER_AUTH_USE_SECURE_COOKIES` | The admin | Sign-in cookies sent over HTTPS only | Unset: production then uses them. Don't add it empty, which turns them off (`apps/admin/src/lib/auth.ts:250-252`) | Leave it |

**Optional services**

| Variable | On | What it's for | Value | Changing it later |
| --- | --- | --- | --- | --- |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | The admin and the worker, the same | Google Calendar | [3.7](part-3-outside-services.md#37-optional-services). The worker refers to the admin's ([4.8](part-4-test-environment.md#48-connect-the-providers-to-this-environment)) | The secret: [7.18](part-7-operations.md#718-rotate-secrets-and-keys). Never make a new client: every connected calendar would be cut off ([7.18](part-7-operations.md#718-rotate-secrets-and-keys)) |
| `GOOGLE_REDIRECT_URI` | The admin and the worker, the same | Where Google sends the owner back after they allow access | `${{APP_BASE_URL}}/api/calendar/google/callback` on Railway, and the worker refers to the admin's. On a server, typed out ([5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose), step 23) | With the address ([7.23](part-7-operations.md#723-change-the-domain-or-the-brand)) |
| `GOOGLE_MAPS_EMBED_API_KEY` | The admin | The map on public profile pages | [3.7](part-3-outside-services.md#37-optional-services), `AIza…`. It isn't secret | Any time |
| `FIRECRAWL_API_KEY` | The worker | Website import | [3.7](part-3-outside-services.md#37-optional-services), `fc-…` | Any time |
| `NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN` | The admin | Dashboard analytics, and the admin's error reports | [3.7](part-3-outside-services.md#37-optional-services), `phc_…`. It isn't secret | Rebuild |
| `NEXT_PUBLIC_POSTHOG_HOST` | The admin | Where the dashboard sends them | [3.7](part-3-outside-services.md#37-optional-services). On a server, always set it: `.env`'s line names the original LobbyStack's address | Rebuild ([7.6](part-7-operations.md#76-change-a-setting-safely)) |
| `POSTHOG_API_KEY` | The worker | The worker's events and error reports | [3.7](part-3-outside-services.md#37-optional-services), `phc_…` | Any time. Without it, product events pile up in the database ([7.25](part-7-operations.md#725-routine-maintenance-calendar)) |
| `POSTHOG_HOST` | The worker | Where the worker sends them | Unset for PostHog's US region; `https://eu.i.posthog.com` for the EU | Any time |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS` | migrate, the admin and the worker | Every service's logs | [3.7](part-3-outside-services.md#37-optional-services) | Any time |
| `POLAR_ACCESS_TOKEN` | The admin and the worker, each its own | Only if the instance sells plans: LobbyStack's access to Polar. Since fork PR #74 the admin's token has only `customer_sessions:write`, for the billing portal, and the worker's eight scopes: four for its daily billing check, `checkouts:write` and `events:write`, `subscriptions:write` for **Upgrade to Pro** and `customers:write` for each business's own Polar customer. Neither has `webhooks:read`. On a server, one token with all nine | [3.7](part-3-outside-services.md#37-optional-services), "[Selling plans](part-3-outside-services.md#selling-plans-polar)", step 3. The worker's is typed in, not a reference to the admin's | [7.18](part-7-operations.md#718-rotate-secrets-and-keys), and before each ends ([7.25](part-7-operations.md#725-routine-maintenance-calendar)) |
| `POLAR_ORGANIZATION_ID` | The admin and the worker, the same | Only if the instance sells plans: Polar's organization | [3.7](part-3-outside-services.md#37-optional-services), "[Selling plans](part-3-outside-services.md#selling-plans-polar)", step 4. The worker refers to the admin's | Leave it: an instance stays with the first organization it's linked to ([3.7](part-3-outside-services.md#37-optional-services), "[Selling plans](part-3-outside-services.md#selling-plans-polar)", step 1) |
| `POLAR_API_BASE_URL` | The admin and the worker, the same | Polar's sandbox, or its live service | `https://sandbox-api.polar.sh` on test; unset in production ([5.2](part-5-production.md#52-production-on-railway), step 9), which means the same as `https://api.polar.sh` | Leave it: subscriptions don't move between the two ([3.7](part-3-outside-services.md#37-optional-services)) |
| `POLAR_STARTER_MONTHLY_PRODUCT_ID` and the other three product IDs | Neither, since fork PR #66 | Nothing now: checkout and plan changes sell the products `pnpm billing apply` links. An instance that never applied a `billing.json` still sells a plan through its variable if one is set | None | Delete them where they're still set: `pnpm billing verify` lists them, and after fork PR #73's `--allow-replace` run warns that the two annual ones name archived products ([3.7](part-3-outside-services.md#37-optional-services), "[Selling plans](part-3-outside-services.md#selling-plans-polar)", steps 7 and 8) |
| `POLAR_WEBHOOK_SECRET` | The admin | Checks that each of Polar's messages comes from Polar | `pnpm billing apply`, when it makes the webhook ([3.7](part-3-outside-services.md#37-optional-services), "[Selling plans](part-3-outside-services.md#selling-plans-polar)", steps 7 and 8) | [7.18](part-7-operations.md#718-rotate-secrets-and-keys) |

**Content retention**

| Variable | On | What it's for | Value | Changing it later |
| --- | --- | --- | --- | --- |
| `CONTENT_RETENTION_ENABLED`, `CONTENT_RETENTION_POLICY_JSON` | The admin and the worker, the same | How long messages, transcripts and recordings are kept ([5.1](part-5-production.md#51-what-changes-from-the-test-environment)) | Unset: the plans' own periods | [7.9](part-7-operations.md#79-data-retention-and-deletion-requests) |

**On a server only**

| Variable | On | What it's for | Value | Changing it later |
| --- | --- | --- | --- | --- |
| `APP_HOSTNAME` | Caddy | The name Caddy answers to, and gets the certificate for | The address without `https://` ([5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose), step 15) | With the address ([7.23](part-7-operations.md#723-change-the-domain-or-the-brand)) |
| `HTTP_BIND_ADDRESS` | Docker Compose, for Caddy | Lets visitors reach Caddy from outside the server | `0.0.0.0`, added at the end of `.env` ([5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose), step 15) | Leave it |
| `HTTP_PORT` | Docker Compose, for Caddy | Caddy's port for plain `http://` | Unset, for 80 | Leave it |
| `ADMIN_PORT`, `WORKER_PORT`, `POSTGRES_PORT`, `REDIS_PORT` | Docker Compose | The ports on the server itself, where the checks in [5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose), step 20, reach each service | `13000`, `13002`, `15433` and `16380`, as `.env` has them | Leave them: the checks and the scripts use them |

**Set for you, by Railway or by the build**

- `RAILWAY_GIT_COMMIT_SHA`, `RAILWAY_DEPLOYMENT_ID` and `RAILWAY_ENVIRONMENT_NAME`: Railway sets them, and the services use them to name the version and the environment, in error reports and in `/api/health/live`.
- `RAILWAY_PRIVATE_DOMAIN`, `RAILWAY_PUBLIC_DOMAIN`, and the bucket's `BUCKET`, `ENDPOINT`, `REGION`, `ACCESS_KEY_ID` and `SECRET_ACCESS_KEY`: Railway's own values, which your lines refer to, as in `${{Postgres.RAILWAY_PRIVATE_DOMAIN}}`.
- `NEXT_PUBLIC_SERVICE_VERSION`, `NEXT_PUBLIC_ASSET_VERSION`, `NEXT_PUBLIC_DEPLOYMENT_ENVIRONMENT`, `NEXT_PUBLIC_BRAND_BASE_URL` and `NEXT_PUBLIC_BRAND_PRESET`: the admin's build writes them (`apps/admin/next.config.ts:31-44`). Don't set them on any service.

**Leave these as they are**

On a server they're in `.env`, from `.env.example`. Keep each line as the generator wrote it, and don't add them on Railway:

- `LOBBYSTACK_MAINTENANCE_MODE`: keep `false`. It isn't a way to pause the instance ([7.6](part-7-operations.md#76-change-a-setting-safely)).
- `LOBBYSTACK_CERTIFICATION_MODE`, `LOBBYSTACK_CERTIFICATION_EMAILS`, `LOBBYSTACK_CERTIFICATION_PHONES` and `LOBBYSTACK_CERTIFICATION_CALENDARS`: keep `false` and empty. They're for release tests: once on, they limit texts, emails and calendars to these lists, and block buying numbers.
- `FINANCE_EXPORT_ENABLED`, `FINANCE_EXPORT_TOKEN` and `LOBBYSTACK_FINANCE_EXPORT_DATABASE_URL`: keep the finance export off. No doc describes it ([Appendix E](appendix-e-doc-problems.md), item 76).
- `TWILIO_ALERT_ACCOUNT_SID`, `TWILIO_ALERT_API_KEY_SID`, `TWILIO_ALERT_API_KEY_SECRET`, `TWILIO_ALERT_WEBHOOK_KEY_ID` and `TWILIO_ALERT_WEBHOOK_SECRET`: keep them empty, so the shared number stays in the environment's own subaccount ([3.3](part-3-outside-services.md#33-twilio)).
- `RESEND_WEBHOOK_SECRET`: keep it empty ([Appendix E](appendix-e-doc-problems.md), item 77).
- `POLAR_ACCEPT_LEGACY_BUSINESS_IDS`: keep `false`. It's for businesses moved from the original LobbyStack's earlier platform.
- `PROSPECT_DEMO_OPERATOR_EMAIL`: keep it empty. It names the one account allowed to make demo businesses for sales prospects (`apps/admin/src/lib/api-helpers.ts:61-67`).
- `ONBOARDING_FOLLOWUP_FROM` and `ONBOARDING_FOLLOWUP_SENDER_NAME`: a founder's check-in email, sent 24 hours after onboarding to owners who haven't come back (`.env.example:203`). Empty, none is sent.
- `UNIT_ECONOMICS_MONTHLY_DATABASE_COST_USD`, `UNIT_ECONOMICS_MONTHLY_HOSTING_COST_USD` and `UNIT_ECONOMICS_MONTHLY_STORAGE_COST_USD`: monthly costs for an internal cost report. Empty counts as 0.
- `FIRECRAWL_BASE_URL`: keep it empty, for Firecrawl's own service.
- `WEB_CALL_ALLOWED_ORIGINS` and `WEB_CALL_PUBLIC_BUSINESS_SLUG`: only for the marketing site's voice demo ([Appendix F](appendix-f-sites.md)). Without the slug, the admin refuses the demo's calls, whatever `WEB_CALL_ALLOWED_ORIGINS` says.
- `PUBLIC_APP_URL`, `PUBLIC_LIVE_CALL_ENDPOINT` and `PUBLIC_WEB_CALL_BUSINESS_SLUG`: the marketing site's ([Appendix F](appendix-f-sites.md)). No service reads them.
- `ALLOWED_DEV_ORIGINS`: for `pnpm dev` on your computer only.
- `CONTENT_RETENTION_DATABASE_URL` and `VOICE_RECOVERY_DATABASE_URL`: for two scripts a developer runs by hand.

**Don't set these**

- `BETTER_AUTH_SECRETS`, with an S: it signs everyone out all the same ([7.18](part-7-operations.md#718-rotate-secrets-and-keys)).
- `OPENAI_BASE_URL`, `OPENAI_PROJECT_ID` and `OPENAI_ORG_ID`: OpenAI's own code reads them, and a wrong value sends calls to another address or project ([3.2](part-3-outside-services.md#32-openai)).
- `BRAND_APP_NAME`, `BRAND_LOGO_URL`, `BRAND_ACCENT_COLOR`, `NEXT_PUBLIC_TERMS_URL` and the other old `NEXT_PUBLIC_…_URL` links: they do nothing any more. A brand file holds them now ([3.6](part-3-outside-services.md#36-your-brand)).
- `SEND_VERIFICATION_EMAIL_ON_SIGNUP`: the hosted template sets it, but nothing reads it ([Appendix E](appendix-e-doc-problems.md), item 32).
- `OTEL_SERVICE_NAME`: each service names itself ([Appendix E](appendix-e-doc-problems.md), item 22).
- `LOBBYSTACK_APP_DATABASE_URL` and the other `LOBBYSTACK_…_DATABASE_URL` values: each one points a role at another database. `LOBBYSTACK_MIGRATOR_DATABASE_URL` would replace migrate's `DATABASE_URL` ([Appendix E](appendix-e-doc-problems.md), item 37).
- `SESSION_ENCRYPTION_KEY`: it stands in for a missing `BETTER_AUTH_SECRET`, which production doesn't allow, so it's never read there.
- `BETTER_AUTH_URL` and `BETTER_AUTH_TRUSTED_ORIGINS`: the admin passes its own address, and LobbyStack's own list of trusted addresses is `AUTH_TRUSTED_ORIGINS`.
- `POSTHOG_KEY`, `POSTHOG_SOURCEMAP_API_KEY` and `POSTHOG_PROJECT_ID`: for developers. `POSTHOG_PROJECT_ID` falls back to a project that is presumably the original LobbyStack's (`apps/admin/next.config.ts:104`; inferred).

**Set somewhere else**

- `LOBBYSTACK_URL` and `LOBBYSTACK_API_KEY`, set together, and `LOBBYSTACK_BUSINESS`: the command line on a computer uses them in place of the profile it saved (`packages/cli/src/config.ts:93-106`). [6.7](part-6-first-run.md#67-optional-the-api-and-the-command-line) signs it in with `login` instead.
- `POLAR_SETUP_TOKEN` and `POLAR_READ_TOKEN`: `pnpm billing` on a computer takes Polar's setup token for `apply`, and a read token for `plan` and `verify`, from them, and asks for one, with typing hidden, when they're unset (`scripts/billing.ts:163-172`; [3.7](part-3-outside-services.md#37-optional-services), "[Selling plans](part-3-outside-services.md#selling-plans-polar)", steps 6 to 8). They never go on a service.
- `ADMIN_BASE_URL`, the `SMOKE_…` values, `REPLACEMENT_COMPOSE_PROJECT`, `CONFIRM_REPLACEMENT_RESTORE` and `CONFIRM_REPLACEMENT_RESTORE_DRILL`: typed on the same line as the check or script that reads them ([4.9](part-4-test-environment.md#49-smoke-test); [5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose), steps 26 and 27; [7.8](part-7-operations.md#78-restore-from-a-backup-and-practice-it)).
- The backup service's `BACKUP_DATABASE_URL`, `AWS_…` values, `SINGLE_SHOT_MODE`, `PG_VERSION`, `NODE_VERSION` and `SUPPORT_OBJECT_LOCK`: [5.2](part-5-production.md#52-production-on-railway), steps 18 and 20.

**Appendix A was checked against:** `.env.example`, `docker-compose.yml`, `Dockerfile.admin`, `Dockerfile.worker`, `Dockerfile.migrator`, `.railway/template.ts` (as a reference only), `scripts/generate-env.mjs`, `apps/admin/instrumentation.ts`, `apps/admin/next.config.ts`, `apps/admin/csp.ts`, `apps/admin/src/lib/auth.ts`, `apps/admin/src/lib/app-origins.ts`, `apps/admin/src/lib/api-helpers.ts`, `apps/admin/src/lib/polar-event.ts`, `apps/admin/src/lib/mcp/handler.ts`, `apps/admin/app/api/affiliate/route.ts`, `apps/admin/app/api/knowledge/embedding-status/route.ts`, `apps/worker/src/index.ts`, `apps/worker/src/handlers.ts`, `apps/worker/src/liveCalls.ts`, `packages/shared/src/productionSecrets.ts`, `packages/jobs/src/index.ts`, `packages/db/src/client.ts`, `packages/db/src/cli.ts`, `packages/domain/src/server/tenancy.ts`, `packages/domain/src/server/demos.ts`, `packages/domain/src/server/knowledge.ts`, `packages/providers/src/ai/embeddingProvider.ts`, `packages/providers/src/storage/provider.ts`, `packages/telemetry/src/node.ts`, `packages/cli/src/config.ts` and `mintlify/self-hosting/environment-variables.mdx`. The Polar token rows were checked again at `7d20322` against `docs/providers/polar.md`, `apps/admin/app/api/billing/portal/route.ts`, `apps/worker/src/index.ts` and `docker-compose.yml` (fork PR #74).
