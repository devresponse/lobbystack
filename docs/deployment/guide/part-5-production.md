# Part 5. Production environment

**Status:** written on 2026-10-19 from the code on `main` at `d18f916`, and from Railway's and the other providers' documentation as read that day. [5.1](#51-what-changes-from-the-test-environment)'s browser call length and [5.3](#53-alternative-production-on-your-own-server-with-docker-compose)'s goodbye time were updated on 2026-10-20 for fork PR #54 (`9b66d01`), and the Polar lines in [5.2](#52-production-on-railway), [5.3](#53-alternative-production-on-your-own-server-with-docker-compose) and [5.4](#54-go-live-checklist) on 2026-10-22 for fork PR #59 (`a44f995`), and [5.4](#54-go-live-checklist)'s again for fork PR #61 (`b6ba2aa`); [5.2](#52-production-on-railway) and [5.3](#53-alternative-production-on-your-own-server-with-docker-compose) dropped the product IDs on 2026-10-23 for fork PR #66 (`d800141`), and [5.2](#52-production-on-railway), [5.3](#53-alternative-production-on-your-own-server-with-docker-compose) and [5.5](#55-hand-an-instance-over-to-a-client) split the Polar token in two on 2026-10-24 for fork PR #74 (`7d20322`), and [5.4](#54-go-live-checklist) checks the two tokens since a review at `24e211d` the same day. [5.1](#51-what-changes-from-the-test-environment)'s lines on telling callers and on content kept, and [5.4](#54-go-live-checklist)'s line on telling callers, were updated on 2026-10-26 for fork PR #84. Nothing was deployed for this part and no account was used, so where a provider's docs don't name a control, it's marked *(name not confirmed)*.

Production is the copy of LobbyStack that real businesses and their callers use. It's built the same way as the test environment, so this part says what changes and sends you back to [Part 4](part-4-test-environment.md) for the rest.

**Before you start**

- The test environment works, and its smoke test passed ([4.9](part-4-test-environment.md#49-smoke-test)) on the commit you'll put live. Note that commit.
- Production's own outside accounts and keys, made by repeating [Part 3](part-3-outside-services.md) for production ([5.1](#51-what-changes-from-the-test-environment) lists what's new), in their own password manager entry, such as "LobbyStack production".
- Your own domain, and production's address from [3.1](part-3-outside-services.md#31-choose-your-addresses), such as `app.example.com`.
- A choice of where production runs: on Railway, as a second environment in the test environment's project ([5.2](#52-production-on-railway), this guide's main path), or on a server you rent, with Docker Compose ([5.3](#53-alternative-production-on-your-own-server-with-docker-compose)).

## 5.1 What changes from the test environment

Everything this table doesn't list stays as [Part 4](part-4-test-environment.md) set it: the same six services with the same names, Dockerfiles, commands, health checks and variable blocks.

| | Test | Production | Why |
| --- | --- | --- | --- |
| Address | Railway's, or a test subdomain | A subdomain of your own domain, such as `app.example.com` | The dashboard tells each browser to use only HTTPS on its address and every address below it, for a year (`apps/admin/proxy.ts:57`). On a bare domain such as `example.com`, that would cover all its subdomains. |
| Code | `main`, deployed on every push | A `production` branch that you move to a tested commit ([5.2](#52-production-on-railway), [7.1](part-7-operations.md#71-release-a-new-version)) | Nothing reaches customers before you've tried it on test |
| Passwords and secrets | 13 values ([4.3](part-4-test-environment.md#43-make-the-passwords-and-secrets)) | 13 new ones | With shared values, each environment would accept the other's sign-ins and codes |
| Outside accounts | Test's | Production's own (below) | Test calls, test bills and test mistakes stay out of production |
| Sign-up | The email code can be skipped | `REQUIRE_EMAIL_VERIFICATION=true`, and a decision about who may sign up ([6.1](part-6-first-run.md#61-create-your-account)) | Otherwise anyone can use the instance with an address they don't own |
| Backups | Optional | Scheduled backups, plus a copy kept somewhere else ([5.2](#52-production-on-railway), [5.3](#53-alternative-production-on-your-own-server-with-docker-compose)) | A backup kept in the same place goes with it: Railway's disappear with the project |
| Watching | Optional | An outside uptime check, Railway's notifications ([5.2](#52-production-on-railway)), and PostHog's error reports ([3.7](part-3-outside-services.md#37-optional-services)) | Once a deploy is live, nothing else checks that the dashboard still answers |
| Spending | Alerts | Alerts at Railway, OpenAI and Twilio, and no hard limit at Railway | Railway's hard limit takes every service offline, calls included |
| Test data | Anything | Real businesses only | Nothing deletes an account or a business ([6.1](part-6-first-run.md#61-create-your-account)), so a test business stays forever |

On Railway, calls keep running through a deploy in both environments: [Part 4](part-4-test-environment.md) already sets `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=1860` on the worker. On your own server, an update ends calls in progress with a goodbye instead ([5.3](#53-alternative-production-on-your-own-server-with-docker-compose)).

**Production's outside accounts**

| Service | What production gets | How |
| --- | --- | --- |
| OpenAI | A project of its own, such as "LobbyStack production", with its own key, spending limit and webhook. The organization, its credit and its usage tier are shared | [3.2](part-3-outside-services.md#32-openai) |
| Twilio | A subaccount of its own, such as "LobbyStack production", with its own trunk pointed at production's OpenAI project. Its numbers need their own texting registration ([3.3](part-3-outside-services.md#33-twilio), steps 14 to 17) | [3.3](part-3-outside-services.md#33-twilio) |
| Email | The same sending domain, with a new key | [3.4](part-3-outside-services.md#34-email) |
| Turnstile | A widget of its own, listing production's host name | [3.5](part-3-outside-services.md#35-cloudflare-turnstile) |
| Google Calendar | A new client in the same Google Cloud project, with production's redirect address, and your domain under **Authorized domains** | [3.7](part-3-outside-services.md#37-optional-services) |
| The map on public profiles | Production's address added to the key's websites | [3.7](part-3-outside-services.md#37-optional-services) |
| Firecrawl | Nothing new: one key serves both | [3.7](part-3-outside-services.md#37-optional-services) |
| PostHog | A project of its own | [3.7](part-3-outside-services.md#37-optional-services) |
| Polar, only if the instance sells plans | A live organization instead of the sandbox. Polar's review can take up to 14 days, so start early | [3.7](part-3-outside-services.md#37-optional-services) |

If production will go to a client, the client opens these accounts in their own name instead, and invites you ([5.5](#55-hand-an-instance-over-to-a-client)).

**Decide these before going live**

- **How long a browser call may last.** Browser calls, dashboard test calls and website visitors' calls alike, end after 30 minutes, as phone calls do. Shortly before the end, the receptionist tells the caller that time is nearly up, then says goodbye. To keep browser calls shorter, set `WEB_CALL_MAX_DURATION_MS` on the admin, in milliseconds, below `1800000` (30 minutes). Phone calls end at 30 minutes whatever you set (`packages/shared/src/index.ts:30-34`). On a copy older than `9b66d01` (fork PR #54), browser calls end after 5 minutes, with no warning, unless you set it.
- **Website chat.** Keep `WIDGET_KEY_ISSUANCE_ENABLED=true` only if businesses will put the chat on their websites. Without it, nobody can create a new chat widget, and existing ones keep working (`apps/admin/app/api/widget-keys/route.ts:39`).
- **Telling callers.** Every call is recorded, and no setting turns that off. Since fork PR #84, right after the greeting every call says "You're speaking with an AI assistant, and this call is recorded and transcribed.", in the language calls open in, unless the business turns **Tell callers about AI and recording** off in **AI settings**. Each business checks that this says what its callers' laws require, and puts anything more into its greeting before it goes live ([5.4](#54-go-live-checklist)). On a copy older than fork PR #84, nothing tells callers, and the default greeting is only "Thanks for calling <business>."
- **How long content is kept.** On an instance that doesn't sell plans, and on the paid plans, messages and follow-ups are kept 365 days and call transcripts and recordings 90 days; the free plan keeps everything 30 days. After that, an hourly clean-up deletes transcripts and recordings, and blanks messages and follow-ups (`packages/shared/src/billing.ts:197-221`, `packages/domain/src/server/privacy.ts:16-41`). A business that turns on AI debug traces keeps them 30 days on every plan ([7.9](part-7-operations.md#79-data-retention-and-deletion-requests)). The email after each call (fork PR #84) holds a summary and a link unless a business chooses **Summary and the whole conversation**; then copies of the conversation stay in its team's mailboxes, where the clean-up can't reach them ([email](../../features/email.md#email-the-team-after-each-call)). [7.9](part-7-operations.md#79-data-retention-and-deletion-requests) covers changing these periods.

**Which PostgreSQL**

Keep the `pgvector/pgvector:pg16` image from [4.4](part-4-test-environment.md#44-add-postgresql-redis-and-the-bucket). Railway's own PostgreSQL adds three things on the Pro plan: restoring the database to any minute of about the last four weeks, a high-availability setup with standby copies, and one-click upgrades to a newer PostgreSQL. But it would make production different from the test environment, the project's checks and Docker Compose; its database is named `railway`; a restore to a past minute creates a new service that someone technical has to swap in; and LobbyStack is tested on PostgreSQL 16 only. If you want it anyway, decide before production holds any data, and move the test environment to it first, so every change is tried on it.

## 5.2 Production on Railway

Production goes into the same Railway project as the test environment, as an environment of its own. It gets its own copy of every service, with its own data, bucket and private network.

- Everyone in the project can open both environments, production's passwords and keys included: Railway limits people to some environments only on its Enterprise plan.
- One Railway workspace pays for both, so its Pro plan covers production too.

**Production in a project of its own.** When someone should work on test but not see production, or production will go to a client ([5.5](#55-hand-an-instance-over-to-a-client)), give production a project of its own instead. Do steps 1 to 3 below, then [4.2](part-4-test-environment.md#42-create-the-account-and-the-project), step 4, to the end of [4.8](part-4-test-environment.md#48-connect-the-providers-to-this-environment) in the new project, with these changes:

- Skip [4.2](part-4-test-environment.md#42-create-the-account-and-the-project), step 10, so the environment keeps its name, `production`.
- In [4.3](part-4-test-environment.md#43-make-the-passwords-and-secrets), use the values from step 3.
- Wherever [Part 4](part-4-test-environment.md) says the branch `main`, choose `production`.
- Use production's own accounts, keys and address, as in step 9's table, and add `REQUIRE_EMAIL_VERIFICATION=true` to the admin.

Then carry on from step 16 below.

**Put the tested version on a `production` branch**

1. On GitHub, open your fork's commits on `main`, at `github.com/<owner>/lobbystack/commits/main`, and find the commit you tested ([4.9](part-4-test-environment.md#49-smoke-test), step 10). It should show a green check mark: its checks passed ([1.4](part-1-prepare.md#14-get-the-code)).
2. Create the `production` branch at exactly that commit, in one of these ways:
   - **On GitHub:** next to the commit, click **Browse repository at this point** (the `<>` button). In the branch menu at the top left, type `production` and choose the option that creates the branch *(its wording not confirmed)*.
   - **From the copy of the code on your computer ([Part 2](part-2-local-development.md)):** `git fetch origin`, then `git push origin <commit ID>:refs/heads/production`.

   Every later release moves this branch to another tested commit ([7.1](part-7-operations.md#71-release-a-new-version)). Never commit to it directly, and don't merge pull requests into it: GitHub's merge buttons all make new commits, which the checks never ran on.

**Make the passwords and secrets**

3. Make 13 new values, as in [4.3](part-4-test-environment.md#43-make-the-passwords-and-secrets), and keep them in their own password manager entry, such as "LobbyStack production: Railway". Never reuse a test value.
   - Values 8 and 12, `ENCRYPTION_KEY` and `OTP_HASH_SECRET`, must stay the same once production is in use, short of a leak ([7.18](part-7-operations.md#718-rotate-secrets-and-keys)), and no backup holds them. Keep a second copy where losing the password manager can't take it with it.

**Create the environment**

4. In the project, check that the environment menu at the top says `test`. Open it, choose **+ New Environment**, then **Duplicate Environment**, and name the new environment `production` *(whether it copies the environment you're in or asks which one: not confirmed; copy `test`)*.
   - **If [4.2](part-4-test-environment.md#42-create-the-account-and-the-project) left an empty `production` environment,** use that one instead: switch to it in the environment menu, click **Sync** at the top of the canvas, and choose `test`. Each service arrives marked **New**.
   - Either way, Railway copies every service with its settings and its variables, values included, and gives production new, empty databases, volumes, a bucket of its own and its own private network.
5. **Don't click Deploy yet.** Everything arrives as staged changes, and nothing runs until you deploy them. First change what was copied, in steps 6 to 9.
6. Check that the environment menu now says `production`. From here on, every change applies only to the environment it shows.

**Point production at the `production` branch**

7. On `migrate`, `admin` and `worker`, open **Settings**, and in the source settings *(**Service Source**; the branch field's name not confirmed)* change the branch from `main` to `production`. Otherwise production's first deploy builds `main`.
   - Leave **Wait for CI** off, as on test. You move `production` only to a commit whose checks have passed, and pushes to `production` start no checks of their own (`.github/workflows/ci.yml:3-9`).
8. Open `admin` > **Settings** > **Networking**. If it lists the test environment's address or domain, remove it from production *(whether a copy brings addresses along: not confirmed)*. An address that's new to production, ending in `.up.railway.app`, can stay: LobbyStack answers only at `APP_BASE_URL`.

**Replace the copied values**

9. Open each service's **Variables** > **RAW Editor**, change the values in this table, and save. Leave every other line as it is: each `${{…}}` reference now points at production's own services, and `SITE_URL`, `AUTH_TRUSTED_ORIGINS`, the two Twilio addresses and `GOOGLE_REDIRECT_URI` follow `APP_BASE_URL` by themselves.

   | Service | Replace | With |
   | --- | --- | --- |
   | `Postgres` | `POSTGRES_PASSWORD` and the four `LOBBYSTACK_…_PASSWORD` lines | Production's values 1 to 5 |
   | `Redis` | `REDIS_PASSWORD` | Value 6 |
   | `migrate` | Nothing, unless you added PostHog's two `OTEL_` lines ([3.7](part-3-outside-services.md#37-optional-services)) | Production's PostHog values |
   | `admin` | The seven secrets, `BETTER_AUTH_SECRET` to `WIDGET_SESSION_SECRET` | Values 7 to 13 ([4.3](part-4-test-environment.md#43-make-the-passwords-and-secrets)) |
   | | `APP_BASE_URL` | Production's address, typed out, with no slash at the end: `APP_BASE_URL=https://app.example.com` |
   | | `OPENAI_API_KEY` | Production's key ([3.2](part-3-outside-services.md#32-openai)) |
   | | `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` | Production's subaccount ([3.3](part-3-outside-services.md#33-twilio)) |
   | | `NEXT_PUBLIC_TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` | Production's widget ([3.5](part-3-outside-services.md#35-cloudflare-turnstile)) |
   | | `OPENAI_WEBHOOK_SECRET`, and `POLAR_WEBHOOK_SECRET` if it's there | Delete both lines for now: production's webhooks come in step 15 |
   | | `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, if they're there | Production's client ([3.7](part-3-outside-services.md#37-optional-services)) |
   | | PostHog's values, if they're there | Production's project ([3.7](part-3-outside-services.md#37-optional-services)) |
   | | Only if the instance sells plans: `TWILIO_ALERT_SMS_FROM`, `POLAR_ACCESS_TOKEN` and `POLAR_ORGANIZATION_ID` | Production's shared number ([3.3](part-3-outside-services.md#33-twilio), step 18), and the live organization's admin token and ID ([3.7](part-3-outside-services.md#37-optional-services), "[Selling plans](part-3-outside-services.md#selling-plans-polar)", steps 3 and 4). Delete the `POLAR_API_BASE_URL` line: empty means Polar's live service. If the four `POLAR_…_PRODUCT_ID` lines are still there, delete them too, here and on the worker: no environment needs them (fork PR #66) |
   | | `PLATFORM_API_KEYS`, if it's there | Delete it, or the test environment's platform keys would work on production too. Production gets its own in step 15 |
   | | `BRAND_PRESET`, if it's there | Delete it when a brand claims production's domain ([3.6](part-3-outside-services.md#36-your-brand)); on the worker too |
   | `worker` | `TWILIO_SIP_TRUNK_SID` | Production's trunk ([3.3](part-3-outside-services.md#33-twilio)) |
   | | `SMTP_PASSWORD` | Production's email key ([3.4](part-3-outside-services.md#34-email)). `EMAIL_FROM` can stay |
   | | Only if the instance sells plans: `POLAR_ACCESS_TOKEN` | The live organization's worker token ([3.7](part-3-outside-services.md#37-optional-services), "[Selling plans](part-3-outside-services.md#selling-plans-polar)", step 3). Since fork PR #74 it's a value of its own, not a reference, so it still holds the test environment's token |
   | | PostHog's values, if they're there | Production's project ([3.7](part-3-outside-services.md#37-optional-services)) |

   Then add this line to the admin:

   ```dotenv
   REQUIRE_EMAIL_VERIFICATION=true
   ```

   and `WEB_CALL_MAX_DURATION_MS`, or remove `WIDGET_KEY_ISSUANCE_ENABLED`, if you decided so in [5.1](#51-what-changes-from-the-test-environment).
10. Before you deploy, compare each key with production's entry in your password manager. A key that matches the test entry instead means a test value is still there.

**Deploy**

11. Click **Deploy** on the banner. Railway creates production's services and deploys them together. Postgres and Redis go first, because the others refer to them, but the admin and the worker don't wait for migrate.
12. Open migrate's deployment and read its log: it should print the five kinds of lines in [4.5](part-4-test-environment.md#45-add-the-migrate-service-and-set-up-the-database), step 6, ending with `RLS enabled and forced on <n> tables.`
13. While migrate runs, the admin and the worker may fail or restart: no database role can sign in until migrate has finished ([4.6](part-4-test-environment.md#46-add-the-admin-and-the-worker), "If the first deploy fails"). Once migrate has succeeded, check that each one's newest deployment shows **Active**. If one doesn't, open that deployment's menu (the three dots) and choose **Redeploy**. Then check the admin's log as in [4.6](part-4-test-environment.md#46-add-the-admin-and-the-worker), step 10: the `[brand]` line names production's brand.

**Add the domain**

14. Add production's domain to the admin as in [4.7](part-4-test-environment.md#47-use-your-own-domain-optional), steps 1 and 2: **+ Custom Domain**, your address, port `3000`, then the two DNS records, with Cloudflare's proxy off. No variable changes and no rebuild: `APP_BASE_URL` already names it. Once the domain shows its green check mark, open `https://app.example.com/api/health/ready`: it should show `"ok":true` and your brand.

**Connect the providers**

15. Do [4.8](part-4-test-environment.md#48-connect-the-providers-to-this-environment) with production's values: OpenAI's webhook in production's project, to `https://app.example.com/api/webhooks/openai/live`, with its secret added to the admin as `OPENAI_WEBHOOK_SECRET`; the Turnstile widget's host name; production's Google client; the map key's websites; and, only if the instance sells plans, the shared number's incoming-text address and an operator's platform key of production's own, as `PLATFORM_API_KEYS`. Click **Deploy** once for all of them.
    - **Only if the instance sells plans,** then do [4.8](part-4-test-environment.md#48-connect-the-providers-to-this-environment), step 7, with production's account and the live organization. Sign the command line in as a profile of its own, `pnpm lobbystack login --profile production --url https://app.example.com --key-stdin`, make the setup token in the live organization, and use `--polar live --profile production` in place of `--polar sandbox` in each `pnpm billing` command, from a copy of the code at the commit production runs. The file it saves says `POLAR_API_BASE_URL=https://api.polar.sh`, which means the same as no line: leave it out.

**Turn on backups**

16. Open `Postgres` > **Backups**, click **Edit schedule**, and tick **Daily**, **Weekly** and **Monthly**. Railway then keeps each daily backup for 6 days, each weekly one for 27 days and each monthly one for 89 days, about 13 copies in all. Backups are a Pro feature, and cost the volume's rate for the space they take.
    - Redis needs none: it holds nothing that PostgreSQL doesn't, only jobs that are waiting to run ([7.7](part-7-operations.md#77-back-up-the-database-and-files)).
    - Railway doesn't back up the bucket, which holds call recordings and uploaded files. [7.7](part-7-operations.md#77-back-up-the-database-and-files) covers copying it.

**Keep a copy outside Railway**

Railway's backups stay inside the project, so they go with it if the project or the volume is ever deleted. A copy every night in a bucket at Cloudflare, where Turnstile already is ([3.5](part-3-outside-services.md#35-cloudflare-turnstile)), covers that. Cloudflare's R2 storage is free for the first 10 GB a month, which a small instance stays within, but Cloudflare asks for a card or PayPal before it turns R2 on.

17. In Cloudflare, open **Storage & databases** > **R2** > **Overview**, and finish the sign-up for R2 if it asks. Click **Create bucket**, name it `lobbystack-production-backups`, keep the **Standard** storage class, and click **Create bucket**. The bucket is private, and should stay so: the copies hold every business's data.
    - The location is picked near you. If the data must stay in the European Union, choose **Specify jurisdiction** > **European Union** instead. That can't be changed later, and it adds `.eu` to the address in step 19.
18. Have Cloudflare delete old copies: in the bucket's **Settings**, under **Object Lifecycle Rules**, click **Add rule**, have it delete objects 30 days after they're made *(the fields' names not confirmed)*, and click **Save changes**.
    - Optionally, under **Bucket lock rules**, add a rule that locks every object for 14 days. Then not even someone who steals the key in step 19 can delete the last two weeks of copies. With a lock, R2 may also want a checksum on each upload, which the template sends only with `SUPPORT_OBJECT_LOCK=true` *(not confirmed)*: if step 22 shows the upload failing, add that line to the service's variables.
19. Make a key that can reach this bucket only. On R2's **Overview** page, click **Manage** next to **API Tokens**, and create an **Account API token**, which keeps working after the person who made it leaves the Cloudflare account. Give it **Object Read & Write**, choose **Apply to specific buckets only** and the bucket, and create it. Save these three in production's password manager entry: the **Access Key ID**, the **Secret Access Key** (shown only once), and the S3 address, `https://<account ID>.r2.cloudflarestorage.com`.
    - Leave the token without an end date, or put its end date in your maintenance calendar ([7.25](part-7-operations.md#725-routine-maintenance-calendar)): an expired token stops the copies.
20. In Railway, check that the environment menu says `production`. Click the create button, choose **Template**, and pick **Postgres S3 backups**, by Railway Templates *(the search's wording not confirmed)*. Its deploy screen asks for `BACKUP_DATABASE_URL`: give it the value in the first line below, and deploy. Then open the new service's **Variables** > **RAW Editor** and replace everything in it with this block, putting the values from step 19 in the `<…>`:

    ```dotenv
    BACKUP_DATABASE_URL=postgresql://postgres:${{Postgres.POSTGRES_PASSWORD}}@${{Postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/lobbystack
    AWS_S3_BUCKET=lobbystack-production-backups
    AWS_S3_ENDPOINT=<the S3 address>
    AWS_ACCESS_KEY_ID=<the Access Key ID>
    AWS_SECRET_ACCESS_KEY=<the Secret Access Key>
    AWS_S3_REGION=auto
    AWS_S3_FORCE_PATH_STYLE=false
    SINGLE_SHOT_MODE=true
    PG_VERSION=16
    NODE_VERSION=22
    ```

    - The template points its `AWS_` lines at a new Railway bucket in the same project, which would go with the project. That bucket is called `Bucket`, like LobbyStack's own, so check that no line still says `${{Bucket.`. If the template added a bucket, leave it alone rather than risk deleting LobbyStack's, which holds the recordings: it stays empty.
    - `PG_VERSION=16` matches production's PostgreSQL. With the template's `17`, the copies couldn't be read back into PostgreSQL 16.
    - The copy signs in as `postgres` on purpose. With one of LobbyStack's limited roles it would miss most of the data and still report success.
21. In the same service's **Settings**, set **Cron Schedule** to `0 3 * * *`, which runs it at 03:00 UTC every night, and the restart policy to **Never**. Click **Deploy**.
    - Choose an hour without releases: a migration waits for the copy to finish, and the dashboard's requests queue behind it.
22. The next day, open the service's **Cron Runs** tab and the run's log *(it may also run once right after the deploy)*. The log should start with `pg_dump (PostgreSQL) 16.` and end with `Database backup complete, exiting...`, and the bucket should hold a file such as `backup-2026-10-20T03-00-12-345Z.tar.gz`.
    - A log that says `Potential warnings detected` means the copy may be incomplete, even though the run shows success. Find out why before you rely on it.
    - Practice restoring a copy on the test environment ([7.8](part-7-operations.md#78-restore-from-a-backup-and-practice-it)). Only a restore proves a copy is complete.

**Watch it**

23. Turn on Railway's notifications: open `railway.com/account/notifications`, and keep failed builds, crashed deployments and usage alerts on **Email & In-App**. Each person who should hear about production sets their own.
    - Railway emails about a crash only after 10 failed restarts, and stops checking a service's health once its deploy is live. So it doesn't notice an admin that stops answering. Step 24 does.
24. Have a service at another company check production every few minutes. UptimeRobot's free plan does it, and its terms allow business use:
    1. Sign up at `uptimerobot.com` with the email address that should get the alerts. On the free plan, alerts go only to that address and to UptimeRobot's phone app.
    2. Click **+ Add New Monitor** and choose the **Keyword** type. Name it, such as "LobbyStack production".
    3. Enter the URL `https://app.example.com/api/health/ready`, the keyword `"ok":true`, and the condition **keyword does not exist**, which raises the alarm when the keyword goes missing *(the labels as UptimeRobot's help pages give them)*.
    4. Keep the 5-minute interval, check that your email is among the alert contacts, and click **Create monitor**. Install UptimeRobot's phone app and sign in, to get the alerts there too.

    It notices a dashboard that stops answering, and a database, Redis or bucket that the dashboard can't reach. It can't see the worker, which has no public address: a stopped worker shows up as Railway's crash notice (step 23) and as calls nobody answers ([7.10](part-7-operations.md#710-health-checks-and-uptime-monitoring)).
25. On production's **Observability** tab, add a **Disk usage** widget for the Postgres volume and a **RAM** widget for the worker, and on each, open the three-dot menu and choose **Add monitor**, such as disk above 80% *(the widgets' names not confirmed)*. A full volume stops the database. Monitors email you, and need the Pro plan.

**Spending**

26. Railway's usage alert covers the whole workspace, so both environments ([4.2](part-4-test-environment.md#42-create-the-account-and-the-project), step 3). Raise its **Custom email alert** to cover both, and leave **Hard limit** empty: at the hard limit Railway takes every service offline, production's calls included. Give production's OpenAI project a monthly limit with room to spare, and alerts below it ([3.2](part-3-outside-services.md#32-openai)), and keep Twilio's balance topped up ([3.3](part-3-outside-services.md#33-twilio)).

**The first run**

27. Do [Part 6](part-6-first-run.md) on production, with your real first business. Don't make a test business here: nothing deletes it ([6.1](part-6-first-run.md#61-create-your-account)).
    - [Part 6](part-6-first-run.md) covers what the smoke test ([4.9](part-4-test-environment.md#49-smoke-test)) checked: sign-up and the email code, a browser call, a phone number, a phone call and a text. The number you buy is the business's real one.
    - Note the commit on the admin's deployment, and the date: that's production's version. `https://app.example.com/api/health/live` shows the same commit as `"version"`.
28. Go through the go-live checklist ([5.4](#54-go-live-checklist)).

**From now on**

- **Releases:** move `production` to a newer tested commit ([7.1](part-7-operations.md#71-release-a-new-version)). Pushes to `main` reach the test environment only.
- **Don't use Sync from test again.** It copies test's values over production's, passwords and keys included. If you do use it, discard each of those lines under **Details** on the staged-changes banner before you deploy. Change production by hand instead.
- **Don't use Deploy Latest Commit on production.** Railway's pages disagree on whether it builds the branch the service follows or GitHub's default branch, `main`. Release by moving the branch.
- **A deploy of Postgres or Redis takes it away for up to about 2 minutes,** because a service with a volume can't run two copies at once. That happens when you change one of their variables, restore a backup, or when Railway moves the service to another machine, which it sometimes does on its own. Change them when few people call.

**Not yet confirmed:**

- Whether **Duplicate Environment** copies the environment you're in or asks which one, and whether a copy or a Sync brings the test environment's addresses and backup schedules along.
- Whether a Sync into an empty environment copies exactly what a duplicate does.
- The name of the branch field in a service's source settings, and whether **Wait for CI** appears at all for a branch the fork's checks don't run on.
- GitHub's exact wording for creating a branch from the branch menu.
- Whether the template's deploy screen lets you change its variables before it deploys, whether it adds a bucket of its own and what it names it, whether its service runs once right after the deploy, and whether a failed run emails anyone. Adding the template to the test environment first settles all four.
- The names of R2's lifecycle fields, of the Observability widgets, and of UptimeRobot's controls, which come from their help pages.

**[5.1](#51-what-changes-from-the-test-environment) and [5.2](#52-production-on-railway) were checked against:** `.railway/railway.ts` and `.railway/README.md` (as a reference only), `.github/workflows/ci.yml`, `apps/admin/proxy.ts`, `apps/admin/src/lib/auth.ts`, `apps/admin/src/lib/app-origins.ts`, `apps/admin/app/api/health/`, `apps/worker/src/index.ts`, `apps/worker/src/liveCalls.ts`, `packages/shared/src/index.ts`, `packages/shared/src/billing.ts`, `packages/domain/src/server/contentRetentionPolicy.ts` and `packages/db/src/cli.ts`, and Railway's documentation. [5.2](#52-production-on-railway)'s Polar token rows were checked at `7d20322` against `docs/providers/polar.md` (fork PR #74).

## 5.3 Alternative: production on your own server with Docker Compose

**Not yet tried:** nothing in this section has been run on a server. It's written from the code, and from Docker's, Caddy's, Let's Encrypt's, Ubuntu's and the providers' documentation as read on 2026-10-19.

One rented Linux server runs everything, with the same Docker Compose setup as Way B in [2.5](part-2-local-development.md#25-way-b-run-everything-in-docker): PostgreSQL, Redis, the migrations, the admin, the worker, and Caddy, which gets the HTTPS certificate. Recordings and uploaded files stay on the server's disk. It costs less than Railway, but you keep the server updated, backed up and with enough disk space, and every step is a command typed over SSH.

What's different from Railway:

- Each update and each nightly backup stops the worker. Calls in progress hear a goodbye, and new calls fail until it's back, so do both when nobody calls. Railway keeps calls running through a deploy.
- Nothing watches the server for you, so the outside uptime check (step 29) matters even more.
- Keep trying each release on the test environment first ([Part 4](part-4-test-environment.md)). It runs on Railway, but the code is the same.

**Before you start**

- The `production` branch exists, at the commit you tested ([5.2](#52-production-on-railway), steps 1 and 2).
- Production's own outside accounts, and the decisions in [5.1](#51-what-changes-from-the-test-environment).
- Your domain, and production's address, such as `app.example.com` ([3.1](part-3-outside-services.md#31-choose-your-addresses)).

**Rent the server**

1. Choose a plan with Ubuntu 24.04 LTS on Intel or AMD (x86) processors, with at least 2 vCPUs, 4 GB of memory and 80 GB of disk. 4 vCPUs and 8 GB are safer: nobody has measured how much memory the first build needs. The images have never been built on Arm processors.

   | Provider | 2 vCPUs, 4 GB | 4 vCPUs, 8 GB | Its own backups | Sending email |
   | --- | --- | --- | --- | --- |
   | Hetzner, in Germany or Finland | CX23, €5.49 a month, but only 40 GB of disk | CX33, €8.49, 80 GB | 20% of the server's price; daily, the last 7 kept | Port 587 works |
   | Hetzner, in the USA | CPX21 (3 vCPUs), €31.99, 80 GB | CPX31, €62.49, 160 GB | The same | Port 587 works |
   | DigitalOcean | $24, 80 GB | $48, 160 GB | 20% weekly, or 30% daily | Ports 25, 465 and 587 are blocked: use port 2587 (step 15) |
   | Vultr | $20, 80 GB | $40, 160 GB | 20% | Port 587 works |

   Prices as listed on 2026-10-19. Hetzner's leave out VAT and the IPv4 address, about €0.50 a month; DigitalOcean's include the address. In Europe, Hetzner's CX33 comes to about €11 a month with its address and backups. Pick a location near most of the callers.
2. If you have no SSH key yet, make one on your computer: `ssh-keygen -t ed25519 -C "lobbystack"`. Press Enter to keep the suggested file, and choose a passphrase. Add the contents of the `.pub` file it made to the provider (at Hetzner, the project's **Security** > **Add SSH Key**), and pick that key when you create the server. PowerShell on Windows 10 and 11 has the same command *(not confirmed)*.
3. Create the server with Ubuntu 24.04, your SSH key and the provider's backups turned on. Write its IPv4 address in your worksheet.
4. Create the provider's firewall, attach it to the server, and give it these inbound rules only: TCP 22, TCP 80, TCP 443 and UDP 443. Hetzner's and DigitalOcean's firewalls are free.
   - Use the provider's firewall, not Ubuntu's own (`ufw`): Docker opens the ports it publishes past `ufw`, while the provider's firewall stops traffic before it reaches the server.
   - DigitalOcean's firewall also blocks outgoing traffic that no rule allows. Keep outgoing rules that allow everything *(whether it adds them for you: not confirmed)*.

**Point the domain at it**

5. At your DNS provider ([3.1](part-3-outside-services.md#31-choose-your-addresses)), add one **A** record: production's name, such as `app`, pointing at the server's IPv4 address. Don't add an AAAA record, and with Cloudflare, set the record to **DNS only**.
   - Caddy asks Let's Encrypt for the certificate as soon as it starts (step 19), and Let's Encrypt allows only 5 failed tries an hour and 5 certificates a week for the same name. So wait until the record works: `nslookup app.example.com` on your computer should show the server's address.

**Prepare the server**

6. Sign in from your computer: `ssh root@<the server's IP address>`. These steps run as root, the user these providers set up, so no command needs `sudo`. On a server where you sign in as another user, run `sudo -i` first.
7. Install the updates, and restart if they ask for it:

   ```sh
   apt update && apt upgrade -y
   test -f /var/run/reboot-required && reboot
   ```

   After a restart, wait a minute and sign in again.
8. Check that IPv6 wasn't switched off when the server started: `test -e /proc/net/if_inet6 && echo "IPv6 is available"`. If it prints nothing, the worker will crash with `listen EAFNOSUPPORT`, because it listens on IPv6 (`apps/worker/src/health.ts:34`). Choose another image then. None of these providers' Ubuntu images is known to do this.
9. Install Docker from Docker's own repository (from Docker's install page, without `sudo`):

   ```sh
   apt install -y ca-certificates curl
   install -m 0755 -d /etc/apt/keyrings
   curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
   chmod a+r /etc/apt/keyrings/docker.asc
   tee /etc/apt/sources.list.d/docker.sources <<EOF
   Types: deb
   URIs: https://download.docker.com/linux/ubuntu
   Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
   Components: stable
   Architectures: $(dpkg --print-architecture)
   Signed-By: /etc/apt/keyrings/docker.asc
   EOF
   apt update
   apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
   docker run --rm hello-world
   ```

   The last command prints "Hello from Docker!".
10. Before any of LobbyStack's containers exists, have Docker rotate its logs. Otherwise it keeps every log line until the disk is full, and the setting applies only to containers created after it.

    ```sh
    cat /etc/docker/daemon.json
    echo '{"log-driver": "local"}' > /etc/docker/daemon.json
    systemctl restart docker
    ```

    If the first command shows settings, add the `log-driver` line to them instead of running the second.
11. On a server with 4 GB of memory, add 4 GB of swap space, so the build doesn't run out of memory:

    ```sh
    fallocate -l 4G /swapfile
    chmod 0600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    echo '/swapfile swap swap defaults 0 0' >> /etc/fstab
    free -h
    ```

    The `Swap:` line should now show about `4.0Gi`.

**Get the code and make the settings file**

12. Get the fork and switch to the `production` branch:

    ```sh
    apt install -y git perl
    cd /root
    git clone https://github.com/<owner>/lobbystack.git
    cd lobbystack
    git checkout production
    ```

    - Keep the folder's name, `lobbystack`: Docker names everything it creates after it, and the backup commands below use that name.
    - `perl` brings `shasum`, which the backups need.
    - The fork `devresponse/lobbystack` is public, so cloning needs no sign-in. A private fork needs a GitHub token, which this guide doesn't cover.
13. Make the settings file, `.env`, with every password and secret already filled in. This runs the generator ([2.3](part-2-local-development.md#23-get-the-code-and-create-your-settings-file)) with Node.js from Docker, so nothing else needs installing:

    ```sh
    docker run --rm -v "$PWD":/app -w /app node:26-bookworm-slim node scripts/generate-env.mjs
    ```

    It prints `Wrote .env with <n> generated secrets.`
14. Open the file with `nano .env`. In nano, Ctrl+W searches, Ctrl+O and Enter save, and Ctrl+X closes.
15. Change these lines, using production's values from [Part 3](part-3-outside-services.md), and leave every other line as it is:

    | Line | Set to |
    | --- | --- |
    | `APP_BASE_URL` | Production's address, with no slash at the end, such as `https://app.example.com` |
    | `APP_HOSTNAME` | The same address without `https://`, such as `app.example.com` |
    | `HTTP_BIND_ADDRESS` | `0.0.0.0`. The file has no such line: add it at the end |
    | `TRUSTED_CLIENT_IP_HEADER` | `x-real-ip` |
    | `REQUIRE_EMAIL_VERIFICATION` | `true` |
    | `WIDGET_KEY_ISSUANCE_ENABLED` | `true`, if businesses will put the chat on their websites ([5.1](#51-what-changes-from-the-test-environment)) |
    | `OPENAI_API_KEY` | Production's key ([3.2](part-3-outside-services.md#32-openai)) |
    | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_SIP_TRUNK_SID` | Production's subaccount and trunk ([3.3](part-3-outside-services.md#33-twilio)) |
    | `TWILIO_SMS_WEBHOOK_URL` | `https://app.example.com/api/webhooks/twilio/sms`, with your address |
    | `TWILIO_STATUS_CALLBACK_URL` | `https://app.example.com/api/webhooks/twilio/status`, with your address |
    | `NEXT_PUBLIC_TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` | Production's widget ([3.5](part-3-outside-services.md#35-cloudflare-turnstile)) |
    | `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USERNAME`, `SMTP_PASSWORD` and `EMAIL_FROM` | Production's email values ([3.4](part-3-outside-services.md#34-email)), as on Railway's worker ([4.6](part-4-test-environment.md#46-add-the-admin-and-the-worker), step 5). On DigitalOcean, `SMTP_PORT=2587` with Resend, because port 587 is blocked there |
    | `DEPLOYMENT_MODE` | Keep `self_hosted_standard`, or `cloud` if the instance sells plans ([1.3](part-1-prepare.md#13-decide-these-before-any-data-exists)) |
    | The optional lines in [4.6](part-4-test-environment.md#46-add-the-admin-and-the-worker), step 6 | As there, when they apply. They're all in the file already, except `WEB_CALL_MAX_DURATION_MS` ([5.1](#51-what-changes-from-the-test-environment)): add it at the end if you need it. On an instance that sells plans, the one `POLAR_ACCESS_TOKEN` line serves both the admin and the worker, so its token needs all nine scopes ([3.7](part-3-outside-services.md#37-optional-services), "[Selling plans](part-3-outside-services.md#selling-plans-polar)", step 3) |
    | PostHog's lines, if you use it | Production's project ([3.7](part-3-outside-services.md#37-optional-services)), `NEXT_PUBLIC_POSTHOG_HOST` included: as it stands, it names the original LobbyStack's PostHog address |

    - The webhook secrets and Google Calendar's lines come in step 23, once the address works.
    - **Don't change `POSTGRES_PASSWORD` or the six `LOBBYSTACK_…_PASSWORD` lines at the top in `.env` alone once the instance has started.** PostgreSQL stores them when it first starts, nothing updates them later, and the admin and the worker would then be locked out. To change one, change it inside PostgreSQL first ([7.18](part-7-operations.md#718-rotate-secrets-and-keys)).
    - `APP_BASE_URL`, `BRAND_PRESET`, `NEXT_PUBLIC_TURNSTILE_SITE_KEY` and the `NEXT_PUBLIC_POSTHOG_` lines are built into the dashboard, so set them now, before the first build.

**Add two files of your own**

16. Create the file for HTTPS with `nano docker/caddy/Caddyfile.production`, and put in it:

    ```caddyfile
    {$APP_HOSTNAME} {
      reverse_proxy admin:3000 {
        header_up X-Real-IP {remote_host}
      }
    }
    ```

    - The repository's own Caddyfile serves plain HTTP only. With this one, Caddy gets a certificate from Let's Encrypt for `APP_HOSTNAME`, renews it, and sends `http://` visitors to `https://`. It needs no email address.
    - The `header_up` line hands each visitor's IP address to the admin, where `TRUSTED_CLIENT_IP_HEADER=x-real-ip` looks for it. Without this file, leave `TRUSTED_CLIENT_IP_HEADER` empty, because visitors could then fake the header (`apps/admin/src/lib/trusted-client-ip.ts`).
17. Create `docker-compose.override.yml` in the same folder as `docker-compose.yml` (`nano docker-compose.override.yml`), with:

    ```yaml
    services:
      admin:
        environment:
          DEPLOYMENT_MODE: ${DEPLOYMENT_MODE:-self_hosted_standard}
          FEEDBACK_TO_EMAIL: ${FEEDBACK_TO_EMAIL:-}
          WEB_CALL_MAX_DURATION_MS: ${WEB_CALL_MAX_DURATION_MS:-}
      worker:
        environment:
          DEPLOYMENT_MODE: ${DEPLOYMENT_MODE:-self_hosted_standard}
          LIVE_DRAIN_TIMEOUT_MS: ${LIVE_DRAIN_TIMEOUT_MS:-}
        stop_grace_period: 45s
      caddy:
        volumes:
          - ./docker/caddy/Caddyfile.production:/etc/caddy/Caddyfile:ro
        ports:
          - "443:443"
          - "443:443/udp"
        healthcheck:
          test: ["CMD", "wget", "-q", "-O", "/dev/null", "http://admin:3000/api/health/live"]
    ```

    Docker Compose reads this file along with `docker-compose.yml`. It:
    - hands the admin and the worker three optional `.env` lines that `docker-compose.yml` leaves out, and `DEPLOYMENT_MODE`, which `docker-compose.yml` itself passes only since `7893d2e`: without it, every new business would become a `cloud` one ([1.3](part-1-prepare.md#13-decide-these-before-any-data-exists));
    - gives the worker 45 seconds to end its calls when it stops, instead of Docker's 10, so each caller hears a goodbye and each call's record is saved. The worker needs up to 40 seconds for that, or 30 on a copy older than `9b66d01` (`packages/agent-core/src/live/callController.ts:314-316`);
    - has Caddy use the new Caddyfile and answer on port 443;
    - has Caddy check the admin directly, because its own check would now be sent on to the HTTPS address.

    Git doesn't track either of your two files, so updates leave them alone. Don't edit `docker-compose.yml` or the original Caddyfile instead: an update could then stop at `git pull`.
18. Check that Docker Compose reads your file:

    ```sh
    docker compose config --quiet && echo OK
    docker compose config | grep -E 'DEPLOYMENT_MODE|stop_grace_period|Caddyfile|443'
    ```

    The first command prints `OK`. The second should show two `DEPLOYMENT_MODE` lines, `stop_grace_period: 45s`, the `Caddyfile.production` line and port 443. If they're missing, check the file's name and folder. Don't run `docker compose config` on its own where others can see your screen: it prints every secret.

**Build and start**

19. On a server with 8 GB of memory, build and start everything with one command:

    ```sh
    SERVICE_VERSION=$(git rev-parse --short HEAD) docker compose up -d --build
    ```

    On 4 GB, build one image at a time instead, so the three builds don't run at once:

    ```sh
    export SERVICE_VERSION=$(git rev-parse --short HEAD)
    docker compose build migrator
    docker compose build worker
    docker compose build admin
    docker compose up -d
    ```

    - `SERVICE_VERSION` records the commit in the images, so `/api/health/live` shows which version runs. Without it, it shows `development`.
    - The first build takes several minutes. Then PostgreSQL creates the database and its roles, with the passwords from `.env`; the migrator builds the tables and stops; the admin and the worker start; and once the admin is healthy, Caddy starts and gets the certificate.

**Check it**

20. Run:

    ```sh
    docker compose ps -a
    docker compose logs migrator | tail -n 3
    curl -fsS http://127.0.0.1:13000/api/health/ready
    curl -fsS http://127.0.0.1:13002/health/ready
    docker compose exec admin printenv DEPLOYMENT_MODE
    ```

    - `ps -a` shows every service as `running (healthy)`, except the migrator, which shows `Exited (0)`.
    - The migrator's log ends with `Database migrations applied.`
    - The admin's health address prints `{"ok":true,…}` with `"database":"ok"`, `"storage":"ok"` and `"redis":"ok"`; the worker's prints `{"ok":true,"ready":true,…}`. These use the ports in `.env`, 13000 and 13002.
    - The last command prints `self_hosted_standard`, or `cloud` if you chose it. Anything else, or nothing, means that `.env`'s `DEPLOYMENT_MODE` line is wrong or, on a copy older than `7893d2e`, that the override file isn't read: fix that before anyone signs up.
21. Open `https://app.example.com/api/health/ready` in your browser. It should load without a certificate warning and show `"ok":true`.
    - If it doesn't, `docker compose logs caddy` shows why. When it shows certificate errors, stop Caddy with `docker compose stop caddy`, fix the DNS record or the firewall, and start it again with `docker compose start caddy`, so failed tries don't use up Let's Encrypt's limits.
22. Check the database the way Railway's migrate service does on every deploy ([4.5](part-4-test-environment.md#45-add-the-migrate-service-and-set-up-the-database)):

    ```sh
    docker compose run --rm migrator node_modules/.bin/tsx dist/cli.js check
    docker compose run --rm -e VERIFY_RLS_BEHAVIOR=true migrator node_modules/.bin/tsx dist/cli.js verify-rls
    ```

    The first prints a line that starts with `{"ok":true`, and the second ends with `RLS enabled and forced on <n> tables.` The second adds two test businesses and removes them again within one transaction, so it's safe on a database in use (`packages/db/src/cli.ts:367-431`).

**Connect the providers**

23. Do [4.8](part-4-test-environment.md#48-connect-the-providers-to-this-environment) with production's values, writing each one into `.env` instead of Railway's variables: the OpenAI webhook in production's project, to `https://app.example.com/api/webhooks/openai/live`, with its secret as `OPENAI_WEBHOOK_SECRET`; the Turnstile widget's host name; production's Google client, with `GOOGLE_REDIRECT_URI=https://app.example.com/api/calendar/google/callback`; the map key's websites; and, only if the instance sells plans, the shared number's incoming-text address and an operator's platform key of production's own, as `PLATFORM_API_KEYS`.
24. Apply the new lines with `docker compose up -d`, which restarts what they changed. A value built into the dashboard (step 15) needs `SERVICE_VERSION=$(git rev-parse --short HEAD) docker compose up -d --build` instead.
    - **Only if the instance sells plans,** then set Polar up as in [5.2](#52-production-on-railway), step 15, but write `POLAR_WEBHOOK_SECRET` from the file `pnpm billing apply` saves into `.env`, and apply them with `docker compose up -d` in place of **Deploy**.
25. Save the finished `.env` in production's password manager entry, such as "LobbyStack production: server", as a secure note: `cat .env` shows it. It's the only copy of the database passwords and the secrets, and the backups don't include it. Keep a second copy of `ENCRYPTION_KEY` and `OTP_HASH_SECRET` as in [5.2](#52-production-on-railway), step 3.

**Backups**

26. Practice a restore once, now, while the instance is still empty:

    ```sh
    REPLACEMENT_COMPOSE_PROJECT=lobbystack CONFIRM_REPLACEMENT_RESTORE_DRILL=1 bash scripts/replacement-restore-drill.sh
    ```

    It writes a test row and a test file, backs up, deletes both, restores the backup, and checks that both came back. It stops the admin and the worker while it runs, and ends with `replacement-restore-postgres: ok` and `replacement-restore-storage: ok`. Don't run it once the instance is in use: its restore throws away everything written while it ran.
27. Schedule a backup every night. Run `crontab -e` (if it asks for an editor, choose nano), and add these two lines at the end:

    ```text
    30 3 * * * REPLACEMENT_COMPOSE_PROJECT=lobbystack bash /root/lobbystack/scripts/replacement-backup.sh >> /var/log/lobbystack-backup.log 2>&1
    30 4 * * * find /root/lobbystack/.replacement-backups -mindepth 1 -maxdepth 1 -type d -mtime +7 -exec rm -rf {} +
    ```

    - The first line makes a backup at 03:30 every night, in the server's time zone, usually UTC (`timedatectl` shows it), into a new folder under `/root/lobbystack/.replacement-backups/`. Each night's run ends its log, `/var/log/lobbystack-backup.log`, with `Replacement backup created: <folder>`.
    - The second deletes backups older than about a week.
    - **While it runs, the backup stops the admin and the worker**: the dashboard, the chat and calls are down until it finishes. Pick an hour when nobody calls.
    - Each backup holds the database and a full copy of the recordings and uploaded files, so a week of them takes room: `df -h /` shows what's free.
    - The backup doesn't include `.env` (step 25), and it can't copy an outside bucket: keep `STORAGE_PROVIDER=local`.
28. Keep copies off the server too:
    - The provider's backups (step 3) copy the whole server every day or week, these folders included. They stay with the same provider and account, though.
    - So once a week, download the newest backup to a computer you control. On that computer:

      ```sh
      ssh root@<the server's IP address> ls /root/lobbystack/.replacement-backups
      scp -r root@<the server's IP address>:/root/lobbystack/.replacement-backups/<the last folder listed> .
      ```

      The folders are named by date and time, so the last one listed is the newest. Keep the copies on an encrypted disk: they hold every business's data.

**Watching and spending**

29. Set up the outside uptime check as in [5.2](#52-production-on-railway), step 24: nothing else watches the server. Give production's OpenAI project a monthly limit and alerts, and keep Twilio's balance topped up, as in [5.2](#52-production-on-railway), step 26.

**The first run**

30. Do [Part 6](part-6-first-run.md) on production, with your real first business, as in [5.2](#52-production-on-railway), step 27. `https://app.example.com/api/health/live` shows the commit that runs as `"version"`.
31. Go through the go-live checklist ([5.4](#54-go-live-checklist)).

**From now on**

- **Updates:** once `production` has moved to a newer tested commit ([7.1](part-7-operations.md#71-release-a-new-version)), at an hour when nobody calls:

  ```sh
  cd /root/lobbystack
  REPLACEMENT_COMPOSE_PROJECT=lobbystack bash scripts/replacement-backup.sh
  git pull --ff-only
  export SERVICE_VERSION=$(git rev-parse --short HEAD)
  docker compose build
  docker compose run --rm migrator
  docker compose up -d
  ```

  Then do the checks in steps 20 to 22. Docker builds while the old version keeps running, and the migrator applies the new migrations before anything is replaced. If it fails, stop there: the old version keeps running ([7.3](part-7-operations.md#73-database-migrations)). On 4 GB, build one image at a time as in step 19.
- **Rolling back:** once `production` has moved back to the earlier commit on GitHub ([7.5](part-7-operations.md#75-roll-back-a-bad-release)), run `git fetch origin`, then `git reset --hard origin/production`, then `SERVICE_VERSION=$(git rev-parse --short HEAD) docker compose up -d --build`. `.env` and your two files stay as they are. Migrations that already ran stay applied ([7.3](part-7-operations.md#73-database-migrations)).
- **The server's own updates:** Ubuntu installs security updates by itself every day, but never restarts. When `/var/run/reboot-required` exists, run `reboot` at a quiet hour; LobbyStack starts again by itself. Docker's own packages update only with `apt update && apt upgrade -y`, which restarts LobbyStack too. [7.25](part-7-operations.md#725-routine-maintenance-calendar) puts these in a monthly routine.
- **Disk space:** check `df -h /` every month. After updates, `docker image prune -f` deletes the old images.
- **Never run `docker compose down -v` or `docker volume prune --all`.** They delete the database, the recordings and the certificate, and Let's Encrypt gives out only 5 certificates a week for the same name.
- **Changing a setting:** edit `.env`, then run `docker compose up -d`, or the `--build` command for a value built into the dashboard (step 15).

**Not yet confirmed:**

- Everything in this section, which has not been run on a server.
- How much memory and disk the build needs, so whether 4 GB with swap is enough, and whether the images build on Arm.
- That Docker Compose reads `docker-compose.override.yml` on its own (step 18 shows it), and whether the backup's stop of the worker waits the 45 seconds.
- How long a backup keeps the instance down. It grows with the recordings, which are stereo WAV files of about 2 to 6 MB a minute, depending on a sample rate the code doesn't set.
- Whether the providers' Ubuntu images come with git and perl, and whether DigitalOcean's firewall adds outgoing rules by itself.
- The weekly download in step 28, and how long it takes once the recordings add up.

**[5.3](#53-alternative-production-on-your-own-server-with-docker-compose) was checked against:** `docker-compose.yml`, `docker/caddy/Caddyfile`, `docker/postgres/init/roles.sh`, the three Dockerfiles, `.env.example`, `.dockerignore`, `scripts/generate-env.mjs`, `scripts/replacement-backup.sh`, `scripts/replacement-restore.sh`, `scripts/replacement-restore-drill.sh`, `apps/worker/src/health.ts`, `apps/worker/src/liveCalls.ts`, `apps/admin/src/lib/trusted-client-ip.ts`, `apps/admin/src/lib/release-version.ts`, `apps/admin/app/api/voice/live/session/route.ts` and `packages/db/src/cli.ts`, and the documentation named above. Step 15's note on the Polar token was checked at `7d20322` against `docker-compose.yml` and `docs/providers/polar.md` (fork PR #74).

## 5.4 Go-live checklist

Go through this list once production is set up, before you give its address to anyone. Each line says where it's done. [Appendix C](appendix-c-checklists.md) has the same list to print.

**The version and the settings**

- [ ] Production runs a commit whose checks passed and which passed the smoke test on the test environment ([4.9](part-4-test-environment.md#49-smoke-test)). You've noted it and the date; `https://app.example.com/api/health/live` shows it as `"version"`.
- [ ] Every password and secret is new, production's password manager entry holds them all, and a second copy of `ENCRYPTION_KEY` and `OTP_HASH_SECRET` is kept elsewhere ([5.2](#52-production-on-railway), step 3). On a server, the entry holds the whole `.env` file ([5.3](#53-alternative-production-on-your-own-server-with-docker-compose), step 25).
- [ ] `DEPLOYMENT_MODE` on the admin and the worker is what you decided ([1.3](part-1-prepare.md#13-decide-these-before-any-data-exists)). On a server, `docker compose exec admin printenv DEPLOYMENT_MODE` shows it ([5.3](#53-alternative-production-on-your-own-server-with-docker-compose), step 20).
- [ ] `https://app.example.com/api/health/ready` opens without a certificate warning and shows `"ok":true`, all three checks `ok`, and the brand you expect.
- [ ] The test environment uses none of production's accounts or keys, and production none of the test environment's ([5.1](#51-what-changes-from-the-test-environment)).

**Sign-up and sign-in**

- [ ] `REQUIRE_EMAIL_VERIFICATION=true` is set on the admin, and your own sign-up asked for the email code ([6.1](part-6-first-run.md#61-create-your-account)).
- [ ] You signed up first, and you've decided who else may sign up ([6.1](part-6-first-run.md#61-create-your-account), [7.20](part-7-operations.md#720-decide-who-can-sign-up)).

**Calls, texts and email**

- [ ] OpenAI's webhook in production's project points at production's address, and a browser call and a phone call both worked ([4.8](part-4-test-environment.md#48-connect-the-providers-to-this-environment), [Part 6](part-6-first-run.md)).
- [ ] The business's number belongs to production's Twilio subaccount, and its texting registration is approved or under way ([3.3](part-3-outside-services.md#33-twilio)). A text to it showed up in **Messages** ([6.4](part-6-first-run.md#64-get-a-phone-number-and-make-the-first-calls)).
- [ ] The email code and an invitation arrived, from production's email key ([6.1](part-6-first-run.md#61-create-your-account), [6.6](part-6-first-run.md#66-invite-the-team)).
- [ ] Each business that takes calls tells callers what their laws require: the notice after the greeting says that an AI answers and the call is recorded and transcribed, unless the business turned it off, and anything more is in its greeting ([5.1](#51-what-changes-from-the-test-environment)).
- [ ] An update doesn't cut calls off. On Railway, the worker has `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=1860`, so calls run on for up to 30 minutes ([4.6](part-4-test-environment.md#46-add-the-admin-and-the-worker), step 5). On a server, the override file gives the worker 45 seconds to say goodbye to each caller ([5.3](#53-alternative-production-on-your-own-server-with-docker-compose), step 17).

**Data**

- [ ] Backups run, and a copy is kept outside Railway or off the server ([5.2](#52-production-on-railway), steps 16 to 22, or [5.3](#53-alternative-production-on-your-own-server-with-docker-compose), steps 27 and 28).
- [ ] A restore has been practiced: on a server, with the drill ([5.3](#53-alternative-production-on-your-own-server-with-docker-compose), step 26); on Railway, on the test environment ([7.8](part-7-operations.md#78-restore-from-a-backup-and-practice-it)).
- [ ] You know how long content is kept ([5.1](#51-what-changes-from-the-test-environment)), and who answers a request to delete someone's data ([7.9](part-7-operations.md#79-data-retention-and-deletion-requests)).

**Watching and money**

- [ ] An outside uptime check watches `https://app.example.com/api/health/ready`, and tells you by email or text when it fails ([5.2](#52-production-on-railway), step 24, or [5.3](#53-alternative-production-on-your-own-server-with-docker-compose), step 29).
- [ ] On Railway, its notifications reach you ([5.2](#52-production-on-railway), step 23). On a server, someone checks the disk space and the backup log every month ([5.3](#53-alternative-production-on-your-own-server-with-docker-compose)).
- [ ] Spending alerts are set at Railway or the server's provider, at OpenAI and at Twilio, with no hard limit at Railway ([5.2](#52-production-on-railway), step 26), and Twilio's balance has room.
- [ ] Only if the instance sells plans: the admin and the worker each have a Polar token of their own, with only the scopes in [3.7](part-3-outside-services.md#37-optional-services), "[Selling plans](part-3-outside-services.md#selling-plans-polar)", step 3, or on a server one token with those nine, and no token on the instance has `webhooks:read`. A token made before fork PR #74 is deleted in Polar ([7.18](part-7-operations.md#718-rotate-secrets-and-keys)).
- [ ] Only if the instance sells plans: `pnpm billing verify --brand <brand> --polar live --profile production` ends `Result: in sync (exit 0).`, and the setup token is deleted in Polar ([3.7](part-3-outside-services.md#37-optional-services), "[Selling plans](part-3-outside-services.md#selling-plans-polar)", step 8). **Upgrade to Pro** under **Settings** > **Plan** shows the brand's prices in its currency, not in US dollars.

**People**

- [ ] Everyone who can open production, at Railway or on the server, on GitHub, at each provider and in the password manager, has a login of their own, and nobody else has one.
- [ ] Someone receives the alerts and knows what to check first ([7.14](part-7-operations.md#714-incident-basics-who-acts-what-to-check-first-how-to-tell-users)).
- [ ] If production will belong to a client, its accounts, its GitHub copy and its Railway project or server are in the client's name, or you've planned how each one moves ([5.5](#55-hand-an-instance-over-to-a-client)).

## 5.5 Hand an instance over to a client

When you set LobbyStack up for someone else, such as a business or a group of businesses, they should end up owning production: the bills in their name, the keys in their hands, and able to carry on without you. Your own test environment can stay yours.

**Plan it before you build production.** Railway can move a whole project to someone else, and a server can change owner, but most outside accounts can't, and what's in them doesn't follow by itself:

- Twilio moves phone numbers to an unrelated account only through its support team, when the owners of both accounts ask. The numbers arrive without their settings, and their US texting registration stays behind, so their texts stop for the weeks a new registration takes ([3.3](part-3-outside-services.md#33-twilio), step 14). A subaccount, which [Part 3](part-3-outside-services.md) makes for each environment, can never change owner.
- OpenAI documents no way to move a project to another organization, and its keys don't move between organizations.
- Railway's credits stay with your account, and a domain bought through Railway can't move to another workspace yet.
- Production's address is hard to change later: each phone number keeps the texting address it was bought with ([7.23](part-7-operations.md#723-change-the-domain-or-the-brand)). So give production an address on a domain the client owns.

So the simplest handover moves nothing: the client opens production's accounts in their own name, and you work in them as an invited member.

**Build production in the client's accounts**

1. The client registers the domain, if they don't have it yet, and signs up at each service production uses ([5.1](#51-what-changes-from-the-test-environment)), with their own email and card. Railway allows one account per person and can't change an account's owner, so don't sign up on the client's behalf.
2. The client invites you to each one, with a role that can set it up:

   | Service | Your role while you set it up |
   | --- | --- |
   | Railway | **Admin** of the client's workspace, once they're on Pro: only Pro workspaces can add people *(where they add you: probably the workspace's **People** page)* |
   | OpenAI | **Owner** of the organization (**People** > **Members** > **Add member**): only owners can create projects |
   | Twilio | **Administrator** |
   | Email (Resend) | **Admin** of the client's team |
   | Cloudflare | **Super Administrator** (**Members** > **Invite members**) |
   | Google Cloud | **Owner** of a project the client creates for production (**IAM & Admin** > **IAM** > **Grant Access**) |
   | Polar, only if the instance sells plans | **Admin**: the client creates the live organization, passes Polar's review as its owner and connects their own payout account, since the money goes to whoever owns that |

3. On GitHub, create a free organization for the client *(the **+** menu at the top right, **New organization**; not confirmed)*. Copy your fork into it: on your fork's page, click **Fork**, and choose the organization as the owner. Then install Railway's GitHub app on the organization ([4.2](part-4-test-environment.md#42-create-the-account-and-the-project), steps 5 to 7). Production deploys from this copy, so at handover the client becomes the organization's owner and the code doesn't move. Releases go through this copy too ([7.1](part-7-operations.md#71-release-a-new-version)): the **Sync fork** button on its page brings its `main` up to date with yours.
4. Build production as [5.2](#52-production-on-railway) or [5.3](#53-alternative-production-on-your-own-server-with-docker-compose) says, from that copy, with these differences:
   - On Railway, production gets a project of its own in the client's workspace ([5.2](#52-production-on-railway), "Production in a project of its own"). The client then pays for production only, and your test environment stays in your project.
   - At Twilio, everything production uses, from the subaccount to the trunk, the numbers and the texting registration, is made in the client's account.
   - At OpenAI, make production's key for a service account ([3.2](part-3-outside-services.md#32-openai), step 8). A key in your own name may stop working when you leave.
   - Email goes out from the client's domain, in the client's team. Your test environment then sends from a domain of yours: Resend lets a domain be in only one team at a time.
   - The backup bucket's token is an **Account API token** ([5.2](#52-production-on-railway), step 19). One made by your own user stops when you leave the client's Cloudflare account.
   - Production's Google sign-in client and map key go in the client's Google Cloud project, not in your test environment's as [5.1](#51-what-changes-from-the-test-environment) says. Every business's calendar connection belongs to that sign-in client, so replacing it later disconnects them all.
5. Keep production's password manager entry where the client can open it, such as a shared vault of theirs.
6. At handover, do "Finish the handover" below. Nothing has to move, so nothing stops working. If you'll keep looking after production, keep the roles you need, and remove only the rest.

**If production is already in your accounts: Railway**

1. The client signs up at Railway, upgrades to Pro and adds you to their workspace as an **Admin**. **Transfer Project** lists only workspaces you belong to.
2. If the code should be theirs too, move your fork to the client's GitHub first (GitHub, below), and install Railway's GitHub app there with access to it ([4.2](part-4-test-environment.md#42-create-the-account-and-the-project), steps 5 to 7).
3. A transfer moves the whole project, `test` included, and `test`'s variables hold your test accounts' keys. So first build a new test environment with [Part 4](part-4-test-environment.md) in a project of yours, then delete `test` from this one *(where: probably **Settings** > **Environments**; not confirmed)*.
4. Open the project's **Settings**, click **Transfer Project**, and choose the client's workspace. According to Railway's forum, the project moves as it is, without stopping: its services, variables, volumes, deployment history and `.up.railway.app` addresses. From then on the client's workspace pays for it.
5. If the code moved to the client's GitHub, open **Settings** > **Source** on migrate, the admin and the worker, disconnect the repository and connect the client's: Railway loses track of a repository that moves. Then check each one's branch and automatic deploys, and that **Wait for CI** is still off ([5.2](#52-production-on-railway), step 7). On Railway's forum, one person never got this working and another needed Railway's support, so leave time for it.
6. Check that `https://app.example.com/api/health/ready` still shows `"ok":true`. The next release ([7.1](part-7-operations.md#71-release-a-new-version)) shows whether automatic deploys still work.
7. The client checks that everything else came along, since Railway doesn't document it: the domain ([5.2](#52-production-on-railway), step 14), the backup schedule (step 16), the backup service and its last run (steps 20 to 22) and the monitors (step 25). Their own notifications (step 23) and spending alerts (step 26) don't come with the project: they set those up themselves.
8. Production holds callers' names, numbers and conversations, so the client may want to sign Railway's data processing agreement, which Railway offers online (`railway.com/legal/dpa`).

**If production is already in your accounts: your own server**

The server's disk holds `.env` with every secret, the database, the recordings and Caddy's certificate, so whoever receives the server receives all of them.

- **Hetzner:** the client opens a Hetzner account and a project, and adds you to it (the project's **Security** > **Members** > **Add member**). Open your server's menu, choose **Transfer to Project**, and choose the client's project. From then on the server is the client's, on the client's bill. Hetzner doesn't say whether its IP address, backups, snapshots and firewall go with it: check each, re-create the firewall if it's missing ([5.3](#53-alternative-production-on-your-own-server-with-docker-compose), step 4), and change the A record if the address changed ([5.3](#53-alternative-production-on-your-own-server-with-docker-compose), step 5).
- **DigitalOcean:** a Droplet can't change owner, but a snapshot of it can.
  1. At a quiet hour, stop LobbyStack, so nothing is written after the snapshot: `cd /root/lobbystack && docker compose stop`.
  2. Take a snapshot of the Droplet *(the button's name not confirmed)*. Then open **Backups & Snapshots** > **Snapshots**, open the snapshot's **More** menu, choose **Transfer Snapshot**, enter the client's email and click **Request Transfer**. The snapshot moves to the client; you don't keep a copy.
  3. The client accepts it and creates a Droplet from it. The new Droplet has a new IP address: change the A record to it ([5.3](#53-alternative-production-on-your-own-server-with-docker-compose), step 5), create the firewall (step 4), turn on its backups (step 28), then you sign in to it, since your key is still on its disk, and start LobbyStack: `cd /root/lobbystack && docker compose up -d`.
  4. Once `https://app.example.com/api/health/ready` shows `"ok":true` from the new Droplet, destroy the old one, which still holds every secret and all the data.
- **Vultr:** not checked.

**If production is already in your accounts: everything else**

Do these at a quiet hour, and put each new value on production as you go: on Railway as in [4.10](part-4-test-environment.md#410-keep-the-test-environment-up-to-date), on a server in `.env` as in [5.3](#53-alternative-production-on-your-own-server-with-docker-compose), step 24.

- **Twilio.** Numbers move to another account only when the owners of both accounts ask Twilio Support, and they arrive with none of their settings. Before anything moves, the client opens and upgrades their own account ([3.3](part-3-outside-services.md#33-twilio), steps 1 to 3), gets any regulatory bundle approved there, registers their texting brand and campaign ([3.3](part-3-outside-services.md#33-twilio), steps 14 to 17), which takes weeks, and builds a trunk to production's OpenAI project ([3.3](part-3-outside-services.md#33-twilio), steps 7 to 12). Then both of you ask Twilio Support to move the numbers, with the numbers, both Account SIDs and the time you want. Right after the move:
  1. Add each number to the client's trunk *(where: the trunk's **Numbers** page; not confirmed)*, and set its **A message comes in** address as in [3.3](part-3-outside-services.md#33-twilio), step 20. Until then, calls to it fail.
  2. Change `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_SIP_TRUNK_SID` to the client's values in one deploy. Twilio signs every text with the account's token, so the admin refuses the moved numbers' texts until then.
  3. Run `pnpm smoke:production` with the client's values ([4.9](part-4-test-environment.md#49-smoke-test)). It checks each number's trunk and texting address.

  If you opened a Twilio account for this client alone, its owner can change instead, and nothing moves: ask Twilio Support for an account owner change, or use Twilio Organizations when you both use company email domains.
- **OpenAI.** A project can't move to another organization, and OpenAI makes a second organization for you only on request, so the client opens their own: credit, a production project, a key made for a service account, the webhook and a spending limit ([3.2](part-3-outside-services.md#32-openai)). The project ID changes, so the client's trunk gets the new address ([3.3](part-3-outside-services.md#33-twilio), step 11). Then change `OPENAI_API_KEY` and `OPENAI_WEBHOOK_SECRET` in one deploy. Only if your organization holds nothing but this instance, hand all of it over instead: add the client as an **Owner** (**People** > **Members** > **Add member**), let them put in their own card, and click **Leave** on your own row. Production's key must then belong to a service account, so make a new one, change `OPENAI_API_KEY`, try a call, and delete the old key.
- **Email.** If production's domain has a Resend team of its own, invite the client as **Admin** (the team's **Members** > **Invite**), let them add their payment details, and choose **Leave Team** next to your name. If the team also holds other domains, delete production's domain from it, and the client adds it to their own team ([3.4](part-3-outside-services.md#34-email)). That needs new DNS records, and email stops until they're verified. Either way, the client then makes a new sending key for `SMTP_PASSWORD` on the worker, since you've seen the old one.
- **Cloudflare** holds the domain's DNS ([3.1](part-3-outside-services.md#31-choose-your-addresses)), the Turnstile widget ([3.5](part-3-outside-services.md#35-cloudflare-turnstile)) and, on Railway, the backup bucket ([5.2](#52-production-on-railway), step 17). If your Cloudflare account holds only this instance, invite the client as **Super Administrator** (**Members** > **Invite members**), then leave (the three-dot menu on your own row, **Leave account**): everything stays where it is. Otherwise the client opens their own account, and each part moves on its own:
  - **The DNS:** export the domain's records, turn off DNSSEC if it's on, and have the client add the domain to their account, with the same records: Railway's two ([3.1](part-3-outside-services.md#31-choose-your-addresses)) or the server's A record ([5.3](#53-alternative-production-on-your-own-server-with-docker-compose), step 5), and the email service's ([3.4](part-3-outside-services.md#34-email)), all **DNS only**. Then the domain's nameservers change at the registrar to the two Cloudflare gives the client, and the client clicks **Re-check now** on the domain's **Overview**.
  - **A domain registered with Cloudflare:** move the registration to the client's account first (the domain's **Manage Domain** page, **Configuration** tab, **Start**; the client accepts it within five days), and only then change the registrant to the client. The other way round, a 60-day lock stops the move.
  - **Turnstile:** the client makes a new widget ([3.5](part-3-outside-services.md#35-cloudflare-turnstile)), and both of its keys change in one deploy. The site key is built into the dashboard, so that deploy rebuilds it.
  - **The backup bucket:** the client makes their own ([5.2](#52-production-on-railway), steps 17 to 19), and the backup service gets the four new `AWS_` values (step 20). Delete the old bucket once theirs holds a few nights of copies.
- **Google Cloud.** A project changes hands through its roles: the project, its sign-in client and the map key stay where they are. Don't move production to a new project instead: a new sign-in client disconnects every business's calendar, and each would have to click **Connect Google** again. If the project also holds your test environment's sign-in client, hand the whole project over anyway, and make a new project for your test environment ([3.7](part-3-outside-services.md#37-optional-services)), where only test calendars need connecting again.
  1. Open **IAM & Admin** > **IAM**, click **Grant Access**, enter the client's Google account, pick the role **Owner** and click **Save**. The client accepts the invitation Google emails them.
  2. If the project has the map key, move its bill. The client creates a billing account of their own and gives you the **Billing Account User** role on it. Then, in **Billing**, open the project's **Actions** menu, choose **Change billing**, pick the client's billing account and click **Set account**. Don't turn billing off in between: Google would stop the map.
  3. Signed in as themselves, the client puts their own address in **User support email** and **Developer contact information**, under **Google Auth platform** > **Branding**.
  4. Under **Clients**, open production's sign-in client and click **Add Secret**. Put the new secret in `GOOGLE_CLIENT_SECRET` and deploy, then **Disable** the old secret, and delete it once calendars still sync. The client ID stays the same, so connected calendars keep working.
  5. Remove your own role: in **IAM**, open your row with **Edit principal**, click **Delete** next to **Owner**, and click **Save**. Google allows this only once the client has accepted.

  The map key needs nothing more: it stays with the project, and the page shows it to every visitor anyway.
- **Polar,** only if the instance sells plans. Only Polar Support can change an organization's owner. Invite the client (**Settings** > **Members** > **Invite**), make them an **Admin** (the three-dot menu on their row, **Change role**), and have them verify their identity under **Finance** > **Account**. Once no payout is pending, email `support@polar.sh` from your account's address to ask for the ownership transfer. The money goes to whoever owns the payout account, so the client connects their own (**Finance** > **Account** > **Manage payout accounts**). Then you leave (the three-dot menu on your own row, **Leave organization**), and the client makes new tokens for the admin's and the worker's `POLAR_ACCESS_TOKEN`, or the one on a server, and a new webhook secret for `POLAR_WEBHOOK_SECRET`.
- **GitHub.** If other instances deploy from your fork, don't transfer it: they would lose it too. Give the client a copy of their own instead (step 3 of "Build production in the client's accounts"). If the fork serves this client alone, transfer it: open its **Settings**, click **Transfer** under **Danger Zone** at the bottom, give the client's account or organization as the new owner, type the repository's name and click **I understand, transfer this repository**.
  - The client's account mustn't already have a repository named `lobbystack` or another fork of LobbyStack, and a transfer to a personal account must be accepted within a day.
  - Issues, settings and secrets come along, and the old address redirects to the new one. GitHub keeps you on as a collaborator, so the client removes you (**Settings** > **Collaborators & teams** > **Remove**).
  - Either way, production then follows the new repository: on Railway, connect it to the services (step 5 of the Railway steps above); on a server, run `cd /root/lobbystack && git remote set-url origin https://github.com/<the new owner>/lobbystack.git`.
- **The domain**, if it's yours: move it to the client at your registrar. A domain bought through Railway can only go to another registrar, not to another workspace, and not in its first 60 days.
- **PostHog, Firecrawl and the uptime check** weren't checked. The client makes their own, and production's values change: PostHog's ([3.7](part-3-outside-services.md#37-optional-services)), `FIRECRAWL_API_KEY` on the worker ([3.7](part-3-outside-services.md#37-optional-services)), and the uptime check ([5.2](#52-production-on-railway), step 24).

**Finish the handover**

1. **Hand over each business.** For each business you created on production, run `pnpm lobbystack team transfer-owner <the client's email>` with a key for that business ([6.7](part-6-first-run.md#67-optional-the-api-and-the-command-line)). The client accepts the emailed link with a verified account and becomes the owner, and you leave the business's team. The business's API keys you made stop working at the same moment. Your own account stays, with no business: nothing deletes an account ([6.1](part-6-first-run.md#61-create-your-account)).
2. **Platform keys:** delete your entries from `PLATFORM_API_KEYS` on the admin, and deploy ([6.7](part-6-first-run.md#67-optional-the-api-and-the-command-line)).
3. **GitHub:** if the code is in an organization you made for the client, invite them to it as an owner (its **People** page, **Invite member**, with the owner role; the invitation lasts 7 days), and leave it once they've joined (your GitHub **Settings** > **Organizations** > **Leave**). On Railway, the client's account must be linked to their GitHub account, as it is when they sign up with **Continue with GitHub** ([4.2](part-4-test-environment.md#42-create-the-account-and-the-project), step 1): Railway deploys a push only when someone in the project has a linked GitHub account that can write to the repository.
4. **The secrets:** give the client production's password manager entry, with the second copy of `ENCRYPTION_KEY` and `OTP_HASH_SECRET` ([5.2](#52-production-on-railway), step 3), and on a server the whole `.env` file ([5.3](#53-alternative-production-on-your-own-server-with-docker-compose), step 25). You made these values, so you know them. Two of them must stay the same, short of a leak; [7.18](part-7-operations.md#718-rotate-secrets-and-keys) says what changing each one does.
5. **The server's sign-in:** the client makes an SSH key as in [5.3](#53-alternative-production-on-your-own-server-with-docker-compose), step 2, with their own name after `-C`, and sends you the contents of its `.pub` file. Add it on the server with `echo '<the contents>' >> /root/.ssh/authorized_keys`. Once they've signed in with it, open the file with `nano /root/.ssh/authorized_keys`, put the cursor on your own line, the one that ends with `lobbystack`, press Ctrl+K to delete it, and save with Ctrl+O, Enter and Ctrl+X.
6. **Your logins:** the client removes you, or you leave, at each service. At Railway, the client lowers you to **Viewer** or removes you, and turns on **Require 2FA** in the workspace's people settings, so everyone needs a second sign-in step. Do the same at OpenAI, Twilio, the email service, Cloudflare, Google Cloud and Polar, and in the password manager.
7. **Watching and spending:** the client sets up their own uptime check ([5.2](#52-production-on-railway), step 24, or [5.3](#53-alternative-production-on-your-own-server-with-docker-compose), step 29) and spending alerts ([5.2](#52-production-on-railway), step 26), and you delete yours.
8. **Copies:** delete what you still hold of the client's data: downloaded backups ([5.3](#53-alternative-production-on-your-own-server-with-docker-compose), step 28), the old backup bucket once theirs works, any copy of `.env`, and on DigitalOcean the old Droplet.

**Not yet confirmed:**

- What a Railway transfer keeps besides the services, variables and volumes: the custom domain, the bucket's files, the backups and their schedule, the monitors and the project's members. Railway's docs don't say; one test transfer of a small project would. Railway's forum says a project moved from Hobby keeps Hobby's limits until each service is redeployed; whether a move between two Pro workspaces needs that too isn't known.
- Whether a Twilio number keeps its ID when Twilio Support moves it. LobbyStack keeps that ID to release the number (`packages/providers/src/twilio/twilioProvider.ts:119-141`), so if it changes, releasing or replacing the number probably fails (inferred).
- Whether Hetzner moves a server's IP address, backups, snapshots and firewall with it.
- Whether OpenAI's webhook and its secret survive a change of the organization's owners, and whether a Resend key belongs to the team or to the person who made it.
- Whether a Polar Admin who isn't the owner can switch the payout account, and how long Polar Support takes.
- How long Google's invitation to become an Owner lasts, and the label of GitHub's owner role in its invitation form.
- Whether Railway keeps deploying when only the GitHub organization's owners change. It should, since the repository doesn't move, but it hasn't been tried.

**[5.5](#55-hand-an-instance-over-to-a-client) was checked against:** `packages/cli/src/commands.ts:296`, `packages/shared/src/publicApi/operations.ts:158`, `packages/providers/src/twilio/twilioProvider.ts`, `apps/worker/src/handlers.ts:942-962`, `apps/admin/app/api/webhooks/twilio/status/route.ts`, `packages/providers/src/google/calendar.ts:42-49` and `scripts/production-smoke.ts`, on `main` at `d18f916`, and Railway's, Hetzner's, DigitalOcean's, Twilio's, OpenAI's, Resend's, Cloudflare's, Polar's, Google's and GitHub's documentation as read on 2026-10-19, with Railway's community forum where its docs say nothing. The Polar tokens were brought up to date at `7d20322` from `docs/providers/polar.md` (fork PR #74).
