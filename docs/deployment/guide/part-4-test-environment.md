# Part 4. Dev/test environment on Railway

**Status:** written on 2026-10-19 from the code on `main` at `d18f916` and from Railway's documentation as read on 2026-10-18. Nothing was deployed for this part and no Railway account was used, so the dashboard's labels come from Railway's docs. Where the docs don't name a control, it's marked *(name not confirmed)*. The first real run of these steps will settle them. The Polar lines in [4.6](#46-add-the-admin-and-the-worker), [4.8](#48-connect-the-providers-to-this-environment) and [4.9](#49-smoke-test) were updated on 2026-10-22 for fork PR #59 (`a44f995`), and [4.9](#49-smoke-test)'s plan change check was added for fork PR #60 (`a6ff674`), and its note on the plan step's prices for fork PR #61 (`b6ba2aa`). [4.6](#46-add-the-admin-and-the-worker) and [4.8](#48-connect-the-providers-to-this-environment) dropped the product IDs on 2026-10-23 for fork PR #66 (`d800141`), and [4.5](#45-add-the-migrate-service-and-set-up-the-database)'s first-run log gained the data repair lines the same day, checked at `fa0aa11`. [4.9](#49-smoke-test)'s check of a second business's checkout was added on 2026-10-24 for fork PR #72 (`cc0c65d`), and the Polar token lines in [4.6](#46-add-the-admin-and-the-worker) and [4.9](#49-smoke-test) and [4.9](#49-smoke-test)'s check of the billing portal the same day for fork PR #74 (`7d20322`). The brand lines in [4.6](#46-add-the-admin-and-the-worker) and [4.9](#49-smoke-test) were updated on 2026-10-27 for fork PR #87, from the code only.

This part builds the test environment on Railway, straight from the fork, in Railway's dashboard. At the end, LobbyStack runs at its own web address, connected to the test accounts from [Part 3](part-3-outside-services.md), and has been checked from sign-up to a phone call.

Before you start, have these ready:

- [Part 3](part-3-outside-services.md)'s values for the test environment ([3.8](part-3-outside-services.md#38-before-you-go-on)), in your password manager.
- The GitHub account that owns the fork, or one that can push to it. Railway deploys a push only when someone in the Railway project has linked a GitHub account with write access to the repository.
- A version of the fork whose checks passed on GitHub ([1.4](part-1-prepare.md#14-get-the-code)).

The sections follow the order in which Railway must deploy things, so do them from top to bottom.

## 4.1 How the Railway project is laid out

One Railway project holds the instance. Its `test` environment runs six services:

| Service | What it does | Built from | Public address? | Keeps its data on |
| --- | --- | --- | --- | --- |
| `Postgres` | The database | The image `pgvector/pgvector:pg16` | No | A volume |
| `Redis` | Queues, rate limits, live updates | The image `redis:7-alpine` | No | A volume |
| `Bucket` | Call recordings and uploaded files | A Railway bucket | No: only the admin and the worker reach it, with its keys | The bucket |
| `migrate` | Creates and updates the database, then stops | The fork, `Dockerfile.migrator` | No | Nothing |
| `admin` | The dashboard, sign-in, the API, the website widget, and the addresses Twilio and OpenAI call | The fork, `Dockerfile.admin` | Yes, the only one | Nothing |
| `worker` | Background jobs, email, texts, and each live call | The fork, `Dockerfile.worker` | No | Nothing |

- **Use exactly these names.** The services find each other through references that name the service, such as `${{Postgres.LOBBYSTACK_APP_PASSWORD}}`. If you name a service differently, change every reference to it. A service's name is shared by all environments, so renaming it in one renames it in the others.
- **Production goes in the same project later,** as its own environment ([Part 5](part-5-production.md)), with its own copy of all six services and its own data, network and bucket. Everyone in the project can open every environment: Railway limits people to some environments only on its Enterprise plan. Use a separate project when production needs different people, or when the instance will go to a client ([5.5](part-5-production.md#55-hand-an-instance-over-to-a-client)).
- **The fork's `.railway/` folder is only a reference.** Its files describe the original LobbyStack's own projects, and the settings below come from them. Railway doesn't read them when it deploys, and `railway.ts` refuses every project but the original's (`.railway/README.md`).
- **No service sleeps.** Leave **Serverless** off on every service, as it starts. The worker checks the database for work every half second (`apps/worker/src/outboxDispatcher.ts:102`), so it would never sleep anyway, and it keeps PostgreSQL and Redis busy too.

**What it costs**, at Railway's prices on 2026-10-18:

- The **Pro** plan costs $20 a month and includes $20 of usage. Hobby, at $5 a month, blocks the worker's email ([3.4](part-3-outside-services.md#34-email)). The free plan can't hold this project: after the trial it allows 3 services and 1 volume per project.
- Usage costs $10 per GB of memory a month, $20 per vCPU a month, $0.15 per GB stored on a volume a month, $0.015 per GB in a bucket a month, and $0.05 per GB sent out to the internet. Builds, and traffic between your services, cost nothing.
- An estimate from 2026-10-14 put a lightly used deployment at about $8 to $20 of usage a month, so a quiet test environment should stay within Pro's included $20. Nobody has measured it yet.

## 4.2 Create the account and the project

**The account**

1. Open `railway.com`, click **Login**, and choose **Continue with GitHub**. Sign in with the GitHub account that owns the fork, or one that can push to it.
   - Railway checks a new account against the GitHub account's age and activity. Until it's verified, it's on a "Limited Trial", which limits outgoing network access. Upgrading, in the next step, lifts that.
2. Upgrade to **Pro** *(button name not confirmed)*. It takes effect at once.
3. Set a spending alert. Open `railway.com/workspace/usage`, click **Set Usage Limits**, and under **Compute Usage** set a **Custom email alert**, such as $30.
   - Leave **Hard limit** empty for a test environment. At the hard limit Railway takes every service offline, and the lowest limit it accepts is $10.
4. Before you add any service, choose your preferred region in your workspace's settings, at `railway.com/workspace` (Railway's pages call it both **Account Settings** and **Workspace Settings**), so each new service starts there. Pick the one nearest most of your callers:

   | Region | Location |
   | --- | --- |
   | US West | California |
   | US East | Virginia, where the original LobbyStack ran |
   | EU West | Amsterdam |
   | Southeast Asia | Singapore |

   Each service's settings show its region, so check it on each service you add. Moving a service with a volume to another region later takes it offline while the volume moves.

**Give Railway access to the fork**

5. Open `github.com/apps/railway-app/installations/new`.
6. Choose the account that owns the fork, choose **Only select repositories**, and pick `lobbystack` under **Select repositories**.
7. Click **Install**. If the fork belongs to an organization, GitHub may show **Install and request** instead, and one of the organization's owners approves it.

**The project and its environment**

8. In Railway, click **+ New Project** (or press Ctrl+K, Cmd+K on a Mac) and choose **Empty project**.
   - Don't choose **GitHub repo**. Railway would then create a service for each package in the code, with build settings it guesses, and they don't build LobbyStack.
9. Open the project's **Settings**, give it a name such as "LobbyStack", and click **Update**.
10. Railway creates every project with one environment, named `production`. Rename it to `test` *(where: probably **Settings** > **Environments**; not confirmed)*.
    - If you can't find the rename, create an empty environment instead: open the environment menu at the top, choose **+ New Environment**, then **Empty Environment**, and name it `test`. Work in `test`, and leave `production` empty: [5.2](part-5-production.md#52-production-on-railway), step 4, fills it.
11. Check that the environment menu at the top says `test`. Every change you make applies only to the environment shown there, so check it again at the start of each section.
12. Leave PR environments off (**Settings** > **Environments**). Otherwise each pull request gets its own copy of this environment, secrets included.
13. Don't turn on Railway's tracing. It would hand the services `OTEL_*` settings, and LobbyStack would start sending its logs and metrics to Railway.

## 4.3 Make the passwords and secrets

The services need 13 random values. Railway can't make them for you: its `${{secret()}}` generator works only in templates, which this guide doesn't use. Make them yourself, and keep them in your password manager in one entry, such as "LobbyStack test: Railway".

| # | Value | Goes on |
| --- | --- | --- |
| 1 | `POSTGRES_PASSWORD` | Postgres |
| 2 | `LOBBYSTACK_AUTH_PASSWORD` | Postgres |
| 3 | `LOBBYSTACK_APP_PASSWORD` | Postgres |
| 4 | `LOBBYSTACK_WORKER_PASSWORD` | Postgres |
| 5 | `LOBBYSTACK_DISPATCHER_PASSWORD` | Postgres |
| 6 | `REDIS_PASSWORD` | Redis |
| 7 | `BETTER_AUTH_SECRET` | admin |
| 8 | `ENCRYPTION_KEY` | admin; the worker refers to it |
| 9 | `INTERNAL_SERVICE_SECRET` | admin |
| 10 | `INTERNAL_SERVICE_TOKEN` | admin; the worker refers to it |
| 11 | `NUMBER_CLAIM_TOKEN_SECRET` | admin |
| 12 | `OTP_HASH_SECRET` | admin; the worker refers to it |
| 13 | `WIDGET_SESSION_SECRET` | admin |

Make each value in one of these ways:

- **Your password manager's generator,** set to 64 characters, with letters and digits only. Leave symbols out: characters such as `@`, `/`, `:` and `#` break the database addresses these values go into.
- **On a Mac, on Linux, or in Git Bash on Windows:** `openssl rand -hex 32`
- **Anywhere Node.js is installed ([2.2](part-2-local-development.md#22-install-the-tools)):** `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

Each command prints a new 64-character value every time, the same kind `pnpm env:generate` makes ([2.3](part-2-local-development.md#23-get-the-code-and-create-your-settings-file)).

- Use a new value on every line, and new ones again for production. Never reuse a test value in production.
- Change values 8 and 12 only after a leak: value 8 breaks every business's API keys, connected assistants, calendar connections and webhook secrets, and value 12 every saved PIN ([7.18](part-7-operations.md#718-rotate-secrets-and-keys)). PostgreSQL reads value 1 only when it first starts ([4.4](#44-add-postgresql-redis-and-the-bucket)).
- Save each value in the password manager as you make it, and copy it from there into Railway. Don't keep the values in a file or send them in a chat.

The database has seven LobbyStack roles, but only four of them sign in while the services run: auth, app, worker and dispatcher (`packages/db/migrations/0000_roles.sql`, `packages/db/src/cli.ts:61-85`). The hosted template also makes passwords for the migrator and readonly roles, which nothing uses, so this guide leaves them out.

## 4.4 Add PostgreSQL, Redis and the bucket

These three hold the data, so they go first.

**PostgreSQL**

1. On the project's canvas, click the create button *(**+ New** or **Create**; name not confirmed)* and choose **Docker Image**.
2. In **Image name**, enter `pgvector/pgvector:pg16` and press Enter. This is PostgreSQL 16 with pgvector, the image that Docker Compose and the original LobbyStack use.
   - Railway's own PostgreSQL (**Database** > **PostgreSQL**) now includes pgvector too, and on the Pro plan can restore the database to any moment since that was turned on. But its database is named `railway`, not `lobbystack`, and it may run a newer version of PostgreSQL, so the database addresses in this part would change. Production keeps this image too ([5.1](part-5-production.md#51-what-changes-from-the-test-environment)).
3. Rename the service to `Postgres`: right-click it and choose the rename option *(name not confirmed)*.
4. Right-click the service, choose **Attach Volume**, and set the volume's mount path to `/var/lib/postgresql/data`.
5. Open the service's **Variables** tab and click **RAW Editor**. Paste this block, replace each `<value N>` with value N from [4.3](#43-make-the-passwords-and-secrets), and save *(button name not confirmed)*:

   ```dotenv
   PGDATA=/var/lib/postgresql/data/pgdata
   POSTGRES_DB=lobbystack
   POSTGRES_USER=postgres
   POSTGRES_PASSWORD=<value 1>
   LOBBYSTACK_AUTH_PASSWORD=<value 2>
   LOBBYSTACK_APP_PASSWORD=<value 3>
   LOBBYSTACK_WORKER_PASSWORD=<value 4>
   LOBBYSTACK_DISPATCHER_PASSWORD=<value 5>
   ```

   - `PGDATA` keeps the database in a folder inside the volume. PostgreSQL won't start in a folder that already holds something, and a new volume holds a `lost+found` folder.
   - PostgreSQL reads `POSTGRES_PASSWORD` only on its very first start, while the volume is empty. Changing it afterwards doesn't change the database's password; it only breaks the migrate service, and the nightly copy once you have one ([5.2](part-5-production.md#52-production-on-railway), step 20). To change it, follow [7.18](part-7-operations.md#718-rotate-secrets-and-keys).
   - PostgreSQL itself ignores the four `LOBBYSTACK_` passwords. They're kept here so the other services all refer to one copy, and the migrate service hands them to the database's roles ([4.5](#45-add-the-migrate-service-and-set-up-the-database)). It does so on every run, so a changed value takes effect at the next deploy ([7.18](part-7-operations.md#718-rotate-secrets-and-keys)).
6. Leave the start command empty, so the image starts PostgreSQL its own way.

**Redis**

7. Create another **Docker Image** service, with the image `redis:7-alpine`, and rename it `Redis`.
8. Attach a volume with the mount path `/data`.
9. In **Variables** > **RAW Editor**, paste this line and replace `<value 6>`:

   ```dotenv
   REDIS_PASSWORD=<value 6>
   ```

10. In the service's **Settings**, under **Deploy**, set the start command *(name not confirmed)* to exactly:

    ```sh
    sh -c 'exec redis-server --bind :: 0.0.0.0 --appendonly yes --maxmemory-policy noeviction --requirepass "$REDIS_PASSWORD"'
    ```

    It makes Redis require the password, keep its data on the volume, and, when its memory is full, refuse new data instead of silently dropping queued jobs.

**The bucket**

11. Click the create button and choose **Bucket**. Choose the region of your services, because a bucket's region can't be changed later: US West is `sjc`, US East `iad`, EU West `ams` and Southeast Asia `sin` *(the picker's wording not confirmed)*. Name it `Bucket`.

**Deploy them**

12. Click **Deploy** on the banner at the top of the canvas, which counts your staged changes. Nothing you set in Railway takes effect until you deploy it this way.
13. Wait until:
    - `Postgres` and `Redis` are running, and each one's log says it's ready to accept connections;
    - the bucket's **Credentials** tab shows its keys.

Railway backs up a volume only once you set a schedule for it, on the Pro plan. Production gets one in [5.2](part-5-production.md#52-production-on-railway), step 16; on the test environment it's optional. Leave automatic image updates off on `Postgres` and `Redis`, as they start: [7.22](part-7-operations.md#722-upgrade-pinned-versions) covers upgrading them.

## 4.5 Add the migrate service and set up the database

The migrate service builds the database's tables and access rules, gives the four roles their passwords, and checks the result. It runs once on each deploy, then stops. The admin and the worker refuse to start until it has succeeded, and Railway doesn't wait for it on its own, so it gets a step of its own.

1. Click the create button and choose **Empty Service**. Rename it `migrate`, and click **Deploy** on the banner to create it.
2. In **Variables** > **RAW Editor**, paste this block. There's nothing to replace: every value refers to `Postgres`.

   ```dotenv
   RAILWAY_DOCKERFILE_PATH=Dockerfile.migrator
   NODE_ENV=production
   DATABASE_URL=postgresql://postgres:${{Postgres.POSTGRES_PASSWORD}}@${{Postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/lobbystack
   LOBBYSTACK_AUTH_PASSWORD=${{Postgres.LOBBYSTACK_AUTH_PASSWORD}}
   LOBBYSTACK_APP_PASSWORD=${{Postgres.LOBBYSTACK_APP_PASSWORD}}
   LOBBYSTACK_WORKER_PASSWORD=${{Postgres.LOBBYSTACK_WORKER_PASSWORD}}
   LOBBYSTACK_DISPATCHER_PASSWORD=${{Postgres.LOBBYSTACK_DISPATCHER_PASSWORD}}
   ```

   - `RAILWAY_DOCKERFILE_PATH` tells Railway which of the fork's three Dockerfiles builds this service. The fork has no file named plain `Dockerfile`, so without this line Railway would guess how to build the code, and get it wrong.
   - The migrate service signs in as the database's administrator, `postgres`, because only the administrator can add pgvector to the database. The admin and the worker sign in with the limited roles.
3. In **Settings**:
   - Leave **Root Directory** at `/`.
   - Under **Deploy**, set the pre-deploy command *(name not confirmed)* to exactly:

     ```sh
     sh -c 'node_modules/.bin/tsx dist/cli.js migrate && node_modules/.bin/tsx dist/cli.js bootstrap && node_modules/.bin/tsx dist/cli.js check && VERIFY_RLS_BEHAVIOR=true node_modules/.bin/tsx dist/cli.js verify-rls'
     ```

     and the start command to `true`.
   - Set the restart policy to **Never**, and leave **Healthcheck Path** empty.
   - Leave **Watch Paths** empty, so every change to `main` rebuilds the service. Builds cost nothing, and an empty list can't miss a change. `.railway/template.ts` has the original's lists, if you'd rather rebuild less often.
   - Leave **Wait for CI** off. With it on, each deploy waits until every one of the fork's checks has passed, and a failed check skips the deploy.

   The four steps run in turn, and each starts only if the one before succeeded: `migrate` builds the tables and roles, `bootstrap` gives the four roles their passwords, `check` signs in, and `verify-rls` checks every table's access rules. As a pre-deploy command, a failure fails the whole deployment where you can see it; the start command `true` then does nothing and stops (`.railway/railway.ts:231-237`). The image's own start command runs only the first step, which leaves every role unable to sign in (`Dockerfile.migrator:43`).
4. Under **Settings** > **Source**, click **Connect Repo**, choose your fork, such as `devresponse/lobbystack`, and check that the branch is `main` *(the branch setting's name not confirmed)*.
   - If Railway offers to import suggested variables from the repository's `.env.example`, don't: they're placeholders for running on your own computer.
5. Click **Deploy** on the banner. Railway builds the service from the fork, which takes a few minutes, and then runs the pre-deploy command.
6. Open the deployment and read its log *(where the pre-deploy output appears: not confirmed)*. A first run prints, in this order:
   1. `Applied migration <file>.`, about a hundred times, once per file, with a line here and there from a file that repairs data, saying what it changed, such as `Promo codes: 0 uses by a business recorded.`;
   2. `Database migrations applied.`
   3. `Database role logins configured for 4 roles.`
   4. a line that starts with `{"ok":true` and ends with `"role":"lobbystack_migrator"}`. It names that role although it signed in as `postgres`, which is expected;
   5. `RLS enabled and forced on <n> tables.`

   The deployment then shows that it finished *(as **Completed** or **Success**; not confirmed which)*. A failure ends the log with an error, and the deployment shows **Failed**. When a migration fails, the log ends with `Failed query:`, that file's SQL and `params: `, and the reason is only in the `Postgres` service's log ([7.3](part-7-operations.md#73-database-migrations)). Fix the cause, then deploy migrate again: open its newest deployment's menu (the three dots) and choose **Redeploy**.

Later runs print `Skipping already-applied migration <file>.` for each file already applied, set the passwords again and repeat the checks, so running migrate again is always safe.

## 4.6 Add the admin and the worker

**Create both services, and the address**

1. Create two more **Empty Service** services, rename them `admin` and `worker`, and click **Deploy** on the banner to create them. Each one's variables refer to the other, so both must exist before you fill them in.
2. Give the admin its address now, before its first build: the address is built into the dashboard, and it picks the brand ([3.6](part-3-outside-services.md#36-your-brand)). Open `admin` > **Settings** > **Networking** > **Public Networking**, click **Generate Domain**, and choose or type port `3000`. Railway gives an address ending in `.up.railway.app`. Write it in your worksheet: it's your test address, unless you add your own domain in [4.7](#47-use-your-own-domain-optional).
   - If Railway doesn't offer **Generate Domain** yet, carry on and generate it right after step 9. That first build had no address, so build the admin again once the domain exists: open the command menu (Ctrl+K, Cmd+K on a Mac) and choose **Deploy Latest Commit**, which always rebuilds.
3. Don't give the worker an address. The admin hands it each call over Railway's private network, and nothing else should reach it.

**The admin's variables**

4. In `admin` > **Variables** > **RAW Editor**, paste this block. Replace each `<value N>` with value N from [4.3](#43-make-the-passwords-and-secrets), and each other `<…>` with the value from the [Part 3](part-3-outside-services.md) section it names:

   ```dotenv
   RAILWAY_DOCKERFILE_PATH=Dockerfile.admin
   NODE_ENV=production
   DEPLOYMENT_MODE=self_hosted_standard
   PORT=3000
   HOSTNAME=::
   APP_BASE_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}
   SITE_URL=${{APP_BASE_URL}}
   AUTH_TRUSTED_ORIGINS=${{APP_BASE_URL}}
   TRUSTED_CLIENT_IP_HEADER=x-real-ip
   LIVE_PROTOTYPE_ENABLED=true
   WIDGET_KEY_ISSUANCE_ENABLED=true
   WORKER_INTERNAL_URL=http://${{worker.RAILWAY_PRIVATE_DOMAIN}}:3002
   DATABASE_URL=postgresql://lobbystack_app:${{Postgres.LOBBYSTACK_APP_PASSWORD}}@${{Postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/lobbystack
   LOBBYSTACK_AUTH_PASSWORD=${{Postgres.LOBBYSTACK_AUTH_PASSWORD}}
   LOBBYSTACK_WORKER_PASSWORD=${{Postgres.LOBBYSTACK_WORKER_PASSWORD}}
   LOBBYSTACK_DISPATCHER_PASSWORD=${{Postgres.LOBBYSTACK_DISPATCHER_PASSWORD}}
   REDIS_URL=redis://default:${{Redis.REDIS_PASSWORD}}@${{Redis.RAILWAY_PRIVATE_DOMAIN}}:6379
   STORAGE_PROVIDER=s3
   S3_BUCKET=${{Bucket.BUCKET}}
   S3_ENDPOINT=${{Bucket.ENDPOINT}}
   S3_REGION=${{Bucket.REGION}}
   S3_ACCESS_KEY_ID=${{Bucket.ACCESS_KEY_ID}}
   S3_SECRET_ACCESS_KEY=${{Bucket.SECRET_ACCESS_KEY}}
   S3_FORCE_PATH_STYLE=false
   BETTER_AUTH_SECRET=<value 7>
   ENCRYPTION_KEY=<value 8>
   INTERNAL_SERVICE_SECRET=<value 9>
   INTERNAL_SERVICE_TOKEN=<value 10>
   NUMBER_CLAIM_TOKEN_SECRET=<value 11>
   OTP_HASH_SECRET=<value 12>
   WIDGET_SESSION_SECRET=<value 13>
   OPENAI_API_KEY=<the sk- key, 3.2>
   TWILIO_ACCOUNT_SID=<the AC value, 3.3>
   TWILIO_AUTH_TOKEN=<the Auth Token, 3.3>
   TWILIO_SMS_WEBHOOK_URL=${{APP_BASE_URL}}/api/webhooks/twilio/sms
   TWILIO_STATUS_CALLBACK_URL=${{APP_BASE_URL}}/api/webhooks/twilio/status
   NEXT_PUBLIC_TURNSTILE_SITE_KEY=<the Site Key, 3.5>
   TURNSTILE_SECRET_KEY=<the Secret Key, 3.5>
   ```

   What the less obvious lines do:
   - `APP_BASE_URL` takes the admin's Railway address. `SITE_URL`, `AUTH_TRUSTED_ORIGINS` and the two Twilio addresses follow it, so when the address changes ([4.7](#47-use-your-own-domain-optional)), one edit changes them all.
   - `HOSTNAME=::` lets Railway's private network reach the admin over IPv6 as well as IPv4.
   - `TRUSTED_CLIENT_IP_HEADER` tells the admin where Railway puts each visitor's IP address ([3.1](part-3-outside-services.md#31-choose-your-addresses)).
   - `LIVE_PROTOTYPE_ENABLED` turns calls on. `WIDGET_KEY_ISSUANCE_ENABLED` lets businesses create website chat widgets, which are refused without it.
   - `WORKER_INTERNAL_URL` is the worker's private address, where the admin hands it each call.
   - The admin signs in to the database as `lobbystack_app`. At start, it also checks that it can sign in as the auth, worker and dispatcher roles, with the three passwords below that line.

**The worker's variables**

5. In `worker` > **Variables** > **RAW Editor**, paste this block, and replace the four values from [Part 3](part-3-outside-services.md):

   ```dotenv
   RAILWAY_DOCKERFILE_PATH=Dockerfile.worker
   NODE_ENV=production
   DEPLOYMENT_MODE=self_hosted_standard
   PORT=3002
   LIVE_PROTOTYPE_ENABLED=true
   RAILWAY_DEPLOYMENT_DRAINING_SECONDS=1860
   APP_BASE_URL=${{admin.APP_BASE_URL}}
   DATABASE_URL=postgresql://lobbystack_worker:${{Postgres.LOBBYSTACK_WORKER_PASSWORD}}@${{Postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/lobbystack
   LOBBYSTACK_DISPATCHER_PASSWORD=${{Postgres.LOBBYSTACK_DISPATCHER_PASSWORD}}
   REDIS_URL=redis://default:${{Redis.REDIS_PASSWORD}}@${{Redis.RAILWAY_PRIVATE_DOMAIN}}:6379
   STORAGE_PROVIDER=s3
   S3_BUCKET=${{Bucket.BUCKET}}
   S3_ENDPOINT=${{Bucket.ENDPOINT}}
   S3_REGION=${{Bucket.REGION}}
   S3_ACCESS_KEY_ID=${{Bucket.ACCESS_KEY_ID}}
   S3_SECRET_ACCESS_KEY=${{Bucket.SECRET_ACCESS_KEY}}
   S3_FORCE_PATH_STYLE=false
   ENCRYPTION_KEY=${{admin.ENCRYPTION_KEY}}
   OTP_HASH_SECRET=${{admin.OTP_HASH_SECRET}}
   INTERNAL_SERVICE_TOKEN=${{admin.INTERNAL_SERVICE_TOKEN}}
   OPENAI_API_KEY=${{admin.OPENAI_API_KEY}}
   TWILIO_ACCOUNT_SID=${{admin.TWILIO_ACCOUNT_SID}}
   TWILIO_AUTH_TOKEN=${{admin.TWILIO_AUTH_TOKEN}}
   TWILIO_STATUS_CALLBACK_URL=${{admin.TWILIO_STATUS_CALLBACK_URL}}
   TWILIO_SIP_TRUNK_SID=<the TK value, 3.3>
   SMTP_HOST=smtp.resend.com
   SMTP_PORT=587
   SMTP_SECURE=false
   SMTP_USERNAME=resend
   SMTP_PASSWORD=<the re_ key, 3.4>
   EMAIL_FROM=<the sender address, 3.4>
   ```

   - The worker takes each value it shares with the admin from the admin, as in `${{admin.ENCRYPTION_KEY}}`, so the two can never differ.
   - With `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=1860`, calls in progress get up to about 30 minutes to finish when a deploy replaces the worker, instead of being cut off. Railway reads the same line as its own draining time. It costs nothing when no call is active (`apps/worker/src/liveCalls.ts:156-162`, `docs/voice/runtime.md:196`).
   - With an email service other than Resend, use its values from [3.4](part-3-outside-services.md#34-email).

**Lines to add or change in some cases**

6. Add these before the first build, when they apply:

   | When | Add | On |
   | --- | --- | --- |
   | The instance sells plans ([1.3](part-1-prepare.md#13-decide-these-before-any-data-exists)) | Change `DEPLOYMENT_MODE` to `cloud`. Add `TWILIO_ALERT_SMS_FROM=<the shared number, 3.3 step 18>`, and Polar's `POLAR_ACCESS_TOKEN` (the admin's token), `POLAR_ORGANIZATION_ID` and `POLAR_API_BASE_URL` from [3.7](part-3-outside-services.md#37-optional-services), "[Selling plans](part-3-outside-services.md#selling-plans-polar)". The webhook secret comes in [4.8](#48-connect-the-providers-to-this-environment) | The admin. On the worker, change `DEPLOYMENT_MODE` too, and add the same names as references, such as `TWILIO_ALERT_SMS_FROM=${{admin.TWILIO_ALERT_SMS_FROM}}`, except `POLAR_ACCESS_TOKEN`: since fork PR #74 the worker's is a token of its own, typed in ([3.7](part-3-outside-services.md#37-optional-services), "[Selling plans](part-3-outside-services.md#selling-plans-polar)", step 3) |
   | No brand claims your address, and it should show another brand than AlloPlace, the only one in the code besides LobbyStack ([3.6](part-3-outside-services.md#36-your-brand)) | `BRAND_PRESET=<the brand's folder name>`, such as `lobbystack` | admin and worker |
   | You use PostHog ([3.7](part-3-outside-services.md#37-optional-services)) | The values in [3.7](part-3-outside-services.md#37-optional-services)'s PostHog table | The services that table names |
   | You use website import ([3.7](part-3-outside-services.md#37-optional-services)) | `FIRECRAWL_API_KEY=<the fc- key>` | worker |
   | You use the map on public profile pages ([3.7](part-3-outside-services.md#37-optional-services)) | `GOOGLE_MAPS_EMBED_API_KEY=<the AIza key>` | admin |
   | Browser calls should open with a recorded greeting | `LIVE_RECORDED_GREETING=true` | admin |
   | Replies to LobbyStack's emails should reach a real inbox ([3.4](part-3-outside-services.md#34-email)) | `EMAIL_REPLY_TO=<the address>` | worker |
   | Feedback sent from the dashboard should reach you ([3.4](part-3-outside-services.md#34-email)) | `FEEDBACK_TO_EMAIL=<your address>` | admin |

   - If you skipped Twilio in [Part 3](part-3-outside-services.md), delete every line that starts with `TWILIO_`. Phone calls and texts then don't work, but everything else does.
   - The Google Calendar values and the webhook secrets come in [4.8](#48-connect-the-providers-to-this-environment), once the address works.

**Settings, and the first build**

7. In each of the two services' **Settings**:
   - Leave **Root Directory** at `/`.
   - Under **Deploy**, leave the start command empty, so each image starts its own way. Set **Healthcheck Path** to `/api/health/ready` on the admin and `/health/ready` on the worker. Leave the health check's timeout at 300 seconds, and the restart policy as it is.
   - Leave **Watch Paths** empty and **Wait for CI** off, as on migrate ([4.5](#45-add-the-migrate-service-and-set-up-the-database)).
8. On each of them, **Settings** > **Source** > **Connect Repo**: the same fork and the branch `main`, as for migrate.
9. Click **Deploy** on the banner. Railway builds both and starts them together. The admin's build takes several minutes.

**Check that both are up**

10. In the admin's log, look for these lines, in this order:
    1. `▲ Next.js` with its version, then `✓ Ready in …`. These come before the start-up checks, so on their own they prove nothing.
    2. On Railway's address, `[brand] alloplace (only brand), shown as AlloPlace`: no brand claims `up.railway.app`, so the only brand besides LobbyStack stands in. With `BRAND_PRESET`, the line says `(preset)` and names that brand. `[brand] lobbystack (default), shown as LobbyStack`, followed by a warning starting `[brand] brand.unmatched:`, means no brand file applies: the code then has no brand besides LobbyStack, or several and `BRAND_PRESET` picks none.
    3. No line starting `An error occurred while loading instrumentation hook:`. That line means a start-up check failed, and the words after it say which (see the table below).

    The deployment then shows **Active**, which means Railway's health check passed.
11. Open `https://<your address>/api/health/ready`. It should show `"ok":true`, with `"database":"ok"`, `"storage":"ok"` and `"redis":"ok"`, and its `"brand"` names the brand the dashboard shows.
12. The worker has no address to open. Its deployment shows **Active** once its own health check passes; its log has a `[brand]` line and no error.

**If the first deploy fails**

| What you see | Why | What to do |
| --- | --- | --- |
| A build fails at once, without running the Dockerfile | `RAILWAY_DOCKERFILE_PATH` is missing or misspelled | Fix it in the service's variables, then click **Deploy** |
| migrate fails with `password authentication failed for user "postgres"` | `POSTGRES_PASSWORD` changed after PostgreSQL first started | Put the first value back, or set the new value inside PostgreSQL ([7.18](part-7-operations.md#718-rotate-secrets-and-keys)). On a new environment with no data, you can instead wipe the Postgres volume (the volume's **Settings** > **Wipe Volume**) and deploy migrate again |
| The admin or the worker keeps restarting, and its log shows `<NAME> is required in production.` | That secret is missing | Add it ([4.3](#43-make-the-passwords-and-secrets)) |
| … or `<NAME> must be at least 32 characters and must not use a placeholder value in production.` | A `<value N>` was left in, or the value is too short | Replace it with a generated value |
| … or `password authentication failed for user "lobbystack_…"`, or `role "lobbystack_…" is not permitted to log in` | migrate hasn't succeeded yet, or a role's password reference is wrong | Check migrate's newest deployment ([4.5](#45-add-the-migrate-service-and-set-up-the-database)), then deploy the admin and the worker again |
| … or `Database role assertion failed: expected unprivileged lobbystack_<role>.` | That role's password line is missing, so the service signed in as another role | Add the missing `LOBBYSTACK_<ROLE>_PASSWORD` line |
| The worker's deployment fails its health check after 5 minutes, with a storage error in its log | The `S3_` lines don't reach the bucket | Check that they say `Bucket`, and that the bucket's **Credentials** tab shows keys |
| `/api/health/ready` shows `"storage":"failed"` or `"redis":"failed"` | The admin's `S3_` lines or its `REDIS_URL` line | Check those lines |
| Sign-in says "Incorrect email or password" although the password is right | The dashboard is open at another address than `APP_BASE_URL`, or the admin's running deployment started before its domain existed | Use the exact address. If that's not it, build the admin again (step 2) |

## 4.7 Use your own domain (optional)

Skip this section to keep Railway's address. Otherwise do it now, before any business gets a phone number: LobbyStack writes the texting address onto each number when it buys it, and numbers bought earlier keep the old address until you change it ([7.23](part-7-operations.md#723-change-the-domain-or-the-brand)).

1. In `admin` > **Settings** > **Networking** > **Public Networking**, click **+ Custom Domain**, type the address you chose in [3.1](part-3-outside-services.md#31-choose-your-addresses), such as `test.example.com`, and set the port to `3000`.
2. Create the two DNS records Railway shows ([3.1](part-3-outside-services.md#31-choose-your-addresses), step 3), and wait for the green check mark next to the domain.
3. In `admin` > **Variables**, change `APP_BASE_URL` to the new address, typed out, with no slash at the end: `APP_BASE_URL=https://test.example.com`. The admin's other addresses and the worker's `APP_BASE_URL` follow it.
4. Click **Deploy** on the banner. This rebuilds the admin with the new address, and so with the new address's brand.
   - Check that the worker deployed again too. If its newest deployment is older than the admin's, deploy it as well *(whether one change deploys both isn't confirmed)*.
   - Use the banner's **Deploy**, not **Restart**, or **Redeploy** on an older deployment: those can reuse the old build and its old address.
5. Open `https://test.example.com/api/health/ready` and check that `"brand"` names the brand you expect.

From now on, sign-in works only at the new address. At Railway's address it says "Incorrect email or password" ([3.1](part-3-outside-services.md#31-choose-your-addresses)). On a brand's own domain, an address that starts with `test` or `dev` adds "(test)" or "(dev)" to the app's name and asks search engines not to list its pages (`packages/shared/src/brands/resolve.ts:84-95`).

## 4.8 Connect the providers to this environment

Now that the address works, finish the [Part 3](part-3-outside-services.md) steps marked **After [4.7](#47-use-your-own-domain-optional)**, listed in [3.8](part-3-outside-services.md#38-before-you-go-on). Use your final address, `https://<your address>`, everywhere. If you added your own domain, its DNS records are already done ([4.7](#47-use-your-own-domain-optional)).

1. **OpenAI:** create the incoming-call webhook ([3.2](part-3-outside-services.md#32-openai), steps 14 to 16). Then add its secret to the admin:

   ```dotenv
   OPENAI_WEBHOOK_SECRET=<the whole whsec_ value>
   ```

2. **Turnstile:** with Railway's address, add its host name to the widget ([3.5](part-3-outside-services.md#35-cloudflare-turnstile), step 4). With your own domain, check that it's on the widget's list.
3. **Google Calendar (optional):** finish the steps in [3.7](part-3-outside-services.md#37-optional-services); with Railway's address, steps 4 and 6 to 8 wait until now. Then add these to the admin:

   ```dotenv
   GOOGLE_CLIENT_ID=<the client ID>
   GOOGLE_CLIENT_SECRET=<the client secret>
   GOOGLE_REDIRECT_URI=${{APP_BASE_URL}}/api/calendar/google/callback
   ```

   and these to the worker, which skips calendar updates without them:

   ```dotenv
   GOOGLE_CLIENT_ID=${{admin.GOOGLE_CLIENT_ID}}
   GOOGLE_CLIENT_SECRET=${{admin.GOOGLE_CLIENT_SECRET}}
   GOOGLE_REDIRECT_URI=${{admin.GOOGLE_REDIRECT_URI}}
   ```

4. **The map (optional):** add `https://<your address>/*` to the key's websites ([3.7](part-3-outside-services.md#37-optional-services)).
5. **Only if the instance sells plans:** set the shared number's incoming-text address ([3.3](part-3-outside-services.md#33-twilio), step 20), and add an operator's platform key to the admin as `PLATFORM_API_KEYS` ([3.7](part-3-outside-services.md#37-optional-services), "[Selling plans](part-3-outside-services.md#selling-plans-polar)", step 5).
6. Click **Deploy** on the banner once, for all of these together.
7. **Only if the instance sells plans,** once that deploy is done: finish [3.7](part-3-outside-services.md#37-optional-services), "[Selling plans](part-3-outside-services.md#selling-plans-polar)", steps 5 to 8. You sign up and sign the command line in, `pnpm billing apply` makes Polar's products and webhook, and one more deploy adds `POLAR_WEBHOOK_SECRET`.

## 4.9 Smoke test

Check each part of the environment once, in this order, with test data only. Each step says what it proves.

1. **Sign up.** Open `https://<your address>/en/signup` and create your account. The Turnstile check passes on its own, or asks you to tick a box. An email with a 6-digit code arrives: enter it.
   - Proves: the admin, the database, Turnstile, and the worker's email.
   - No email? The worker's log says why. Check the SMTP lines ([3.4](part-3-outside-services.md#34-email)), and that Railway is on Pro. Meanwhile you can sign in at `https://<your address>/en/login` with the same email and password, as on your computer ([2.6](part-2-local-development.md#26-sign-in-for-the-first-time-and-create-a-test-business)).
   - On an instance that sells plans, you signed up in [4.8](#48-connect-the-providers-to-this-environment), step 7, so go on to step 2.
2. **Onboarding.** Go through the steps in [6.3](part-6-first-run.md#63-set-up-the-first-business). The brand step ([6.2](part-6-first-run.md#62-the-brand-step)) appears only when no brand file applies, which with AlloPlace in the code never happens.
   - On an instance that doesn't sell plans, choose **Start free** on the plan step: the business stays unlimited whatever the page lists.
   - On an instance that sells plans, choose **Starter** instead. The plan step shows the brand's prices in its currency, such as CA$30 for AlloPlace, because [4.8](#48-connect-the-providers-to-this-environment), step 7 ran `pnpm billing apply`; prices in US dollars mean it didn't. Polar's sandbox checkout opens, where test cards move no money ([3.7](part-3-outside-services.md#37-optional-services)), and the number step follows.
   - On an instance that sells plans, check a plan change too, once onboarding is done: open **Settings** > **Plan**, click **Upgrade to Pro**, then **Upgrade to Pro** on the Pro card. The dialog says your subscription changes instead of a checkout opening. The page shows Pro once Polar confirms it, and Polar charges the test card the difference. "Plan changes aren't set up here yet." means the worker's token lacks `subscriptions:write` ([3.7](part-3-outside-services.md#37-optional-services), "[Selling plans](part-3-outside-services.md#selling-plans-polar)", step 3). This hasn't been tried against Polar's sandbox yet.
   - On an instance that sells plans, check a second business's checkout as well: click your business's name at the top of the sidebar, then **Create Business** ([6.6](part-6-first-run.md#66-invite-the-team)), and choose **Starter** on its plan step. Polar already has your email for the first business, so the step asks for a **Billing email** for this one: enter another address of yours, click **Continue**, and Polar's checkout opens. In Polar, each business should then be a customer of its own, with its own subscription *(Polar's screens: not confirmed)*. This came with fork PR #72 and hasn't been tried against Polar's sandbox yet.
   - On an instance that sells plans, check the billing portal too, which since fork PR #74 runs on the admin's own token: under **Settings** > **Plan**, click **Manage subscription**, and Polar's customer portal opens. "Unable to open the customer portal." usually means the admin's `POLAR_ACCESS_TOKEN` is missing or lacks `customer_sessions:write` ([3.7](part-3-outside-services.md#37-optional-services), "[Selling plans](part-3-outside-services.md#selling-plans-polar)", step 3). This hasn't been tried against Polar's sandbox yet.
3. **Make the business bookable.** Add one service and your opening hours ([6.3](part-6-first-run.md#63-set-up-the-first-business)).
4. **A browser call.** Click **Test Call** (or **Start a call** under **Getting started**) and talk to the receptionist. Ask it for your opening hours.
   - Proves: OpenAI, and the admin handing the call to the worker over the private network.
5. **Website chat.** Open **Settings** > **Website widget**. Under **Allowed origins**, enter your own website's address, or `https://example.com` if you have none, and click **Create widget key**. Then open **Settings** > **Public profile**: under **Chat**, choose the widget, turn on **Published**, click **Save**, then **Open page**. Ask the chat a question.
   - Proves: the chat's AI and the widget. The page works whatever the widget's allowed origins are, because it's on your own address.
6. **Buy a test number.** Open **Settings** > **Phone Number** and click **Get number**. Choose the country, type an area code, click **Search**, then **Select** next to a number. It spins for up to 2 minutes, then "Phone number added." appears ([6.4](part-6-first-run.md#64-get-a-phone-number-and-make-the-first-calls)).
   - Twilio charges its monthly fee from now on ($1.15 a month for a US or Canadian local number), until the number is released. Only the command line can release it ([6.7](part-6-first-run.md#67-optional-the-api-and-the-command-line)).
   - Proves: Twilio, the SIP trunk and `NUMBER_CLAIM_TOKEN_SECRET`. If it fails, [6.4](part-6-first-run.md#64-get-a-phone-number-and-make-the-first-calls) says what each message means and where the reason is logged.
7. **A phone call.** Call the number from your own phone. The receptionist answers and greets you, and afterwards the call is listed in **Calls**.
   - Proves: the trunk, OpenAI's webhook and its secret, and that your OpenAI project takes phone calls. If it rings with no answer, check whether OpenAI's webhook page shows a delivery ([3.2](part-3-outside-services.md#32-openai), "Phone calls (SIP)").
8. **A text.** Send a text to the number. It appears in **Messages**, and your phone number becomes a contact.
   - The receptionist doesn't answer texts; people reply from **Messages**. A reply reaches a US phone only once the number's texting registration is approved ([3.3](part-3-outside-services.md#33-twilio), step 14).
9. **Google Calendar (optional).** Open **Integrations**, click **Connect Google** and allow access. Book a test appointment by chat or by phone, and check that it appears in the calendar.
10. **Note what passed:** the commit Railway shows on the admin's deployment, and the date.

**The automatic check (optional)**

For anyone comfortable with a terminal: `pnpm smoke:production` checks the address, each number's settings at Twilio, and sign-in, from the copy of the code on your computer ([Part 2](part-2-local-development.md)). It reads no settings file, so give it its values on the same line:

```sh
ADMIN_BASE_URL=https://<your address> \
TWILIO_ACCOUNT_SID=<the AC value> TWILIO_AUTH_TOKEN=<the Auth Token> TWILIO_SIP_TRUNK_SID=<the TK value> \
SMOKE_EXPECTED_NUMBERS=<the test number, such as +15145550123> \
pnpm smoke:production
```

- It prints `ok` or `FAIL` for each check, then `production smoke passed` when all pass. On Windows, run it in Git Bash.
- Always set `ADMIN_BASE_URL` and `SMOKE_EXPECTED_NUMBERS`: without them, it checks the original LobbyStack's address and phone numbers.
- Without the Twilio values it stops before checking anything, and without the trunk SID every number fails.
- Its sign-in check uses a made-up account and passes when sign-in is refused, which a wrong address also causes. For a real sign-in, add `SMOKE_LOGIN_EMAIL` and `SMOKE_LOGIN_PASSWORD` with a test account.
- The Auth Token stays in your terminal's history, so run this only on your own computer.

The test environment is also where `pnpm voice:call` places its scripted test calls before a change to how calls behave merges ([2.8](part-2-local-development.md#28-run-the-checks-before-you-ship-a-change), `docs/voice/testing.md`).

## 4.10 Keep the test environment up to date

- **Every push to `main` deploys** migrate, the admin and the worker, each on its own: Railway doesn't make the other two wait for migrate. After a change to the database, new code can briefly run against the old tables. If something fails right after such a push, check that migrate's newest deployment succeeded, then deploy the admin and the worker again.
- **If you deploy your own fork,** bring in each new version of LobbyStack by syncing it ([1.4](part-1-prepare.md#14-get-the-code), step 7). The sync is a push to `main`, so it deploys here like any other.
- **A push by someone whose GitHub account isn't linked to a member of the Railway project** waits for approval: open the deployment and click **Approve**.
- **To stop automatic deploys for a while,** click **Disable** next to automatic deploys in the source settings of migrate, the admin and the worker, and **Enable** to turn them back on *(the section's name not confirmed)*; [7.2](part-7-operations.md#72-pause-automatic-deploys) covers when.
- **To change a setting,** edit the variable and click **Deploy** on the banner, which rebuilds the service. The address, the brand, the Turnstile site key, PostHog's dashboard values, `STORAGE_PROVIDER` and the `S3_` values are built into the admin, so only a rebuild applies a change to them; **Restart** reuses the old build ([7.6](part-7-operations.md#76-change-a-setting-safely)).
- **To pause the environment** while nobody uses it for weeks: on the admin, the worker, Redis and Postgres, open the newest deployment's menu (the three dots) and choose **Remove**. That stops their running costs. The volumes, the bucket and the variables stay, and still cost a little for what they hold. Calls and texts to the test numbers go unanswered meanwhile, and the numbers keep costing their monthly fee. To start again, deploy in the first order: Postgres and Redis, then migrate, then the admin and the worker *(how to start an image service that has no deployment isn't confirmed)*.
- **To start over with empty data:**
  1. Release the test numbers first, or they stay in your Twilio account, billed every month. The dashboard has no button for it: use the command line ([6.7](part-6-first-run.md#67-optional-the-api-and-the-command-line)). Or, since the wipe deletes LobbyStack's record of the numbers anyway, release them in Twilio's console *(menu path not confirmed)*.
  2. Wipe the Postgres volume and the Redis volume: each volume's **Settings** > **Wipe Volume**. This also deletes their backups.
  3. Deploy migrate, then the admin and the worker. The bucket keeps its files; delete them from its **Files** view if you want it empty.

## 4.11 Later: set it all up with one command

Not built. The 2026-10-14 research recommended a Railway definition and a set-up script kept in the fork, which would do [4.2](#42-create-the-account-and-the-project) to [4.6](#46-add-the-admin-and-the-worker) from about six values and one sign-up per instance. Until it exists, follow this part by hand. Don't run `railway config apply` from the fork: its definition targets the original LobbyStack's project (`.railway/railway.ts:5-7`).

**Not yet confirmed:**

- Where the dashboard renames an environment ([4.2](#42-create-the-account-and-the-project)).
- Whether **Generate Domain** works on a service that has never deployed, and how it asks for the port ([4.6](#46-add-the-admin-and-the-worker)).
- Whether a finished migrate deployment shows **Completed** or **Success**, and where the pre-deploy command's output appears ([4.5](#45-add-the-migrate-service-and-set-up-the-database)).
- Whether a variable change on the admin also redeploys the worker that refers to it, and whether such a deploy builds the commit that's running or the branch's newest ([4.7](#47-use-your-own-domain-optional)).
- Several control names: the create button, the rename option, the RAW Editor's save button, the start-command, pre-deploy and branch settings, the upgrade button and the region setting.
- Whether references to sealed variables work. Until that's known, this guide seals nothing, although Railway can hide a variable's value for good.

**Checked against:** `.railway/template.ts`, `.railway/railway.ts` and `.railway/README.md` (as a reference only), `Dockerfile.admin`, `Dockerfile.worker`, `Dockerfile.migrator`, `packages/db/src/cli.ts`, `packages/db/src/client.ts`, `packages/db/migrations/0000_roles.sql`, `packages/shared/src/productionSecrets.ts`, `packages/shared/src/brands/resolve.ts`, `packages/providers/src/storage/`, `apps/admin/instrumentation.ts`, `apps/admin/next.config.ts`, `apps/admin/src/lib/startup-role-assertion.ts`, `apps/admin/app/api/health/ready/route.ts`, `apps/admin/src/lib/widget-keys.ts`, `apps/admin/src/components/live-widget-settings-surface.tsx`, `apps/admin/src/components/onboarding-plan-surface.tsx`, `packages/domain/src/server/onboarding.ts`, `packages/domain/src/server/sms.ts`, `apps/worker/src/index.ts`, `apps/worker/src/health.ts`, `apps/worker/src/liveCalls.ts`, `apps/worker/src/outboxDispatcher.ts`, `scripts/production-smoke.ts`, `scripts/staging-start.sh`, `scripts/staging-stop.sh`, `docs/deployment/railway.md` and `docs/voice/runtime.md`, and the dashboard's English labels in `apps/admin/public/locales/en/`. [4.9](#49-smoke-test)'s check of a second business's checkout was checked at `cc0c65d` against `apps/admin/src/components/onboarding-plan-surface.tsx` and `billing-email-form.tsx`, and `apps/worker/src/handlers.ts` (fork PR #72). The Polar token lines in [4.6](#46-add-the-admin-and-the-worker) and [4.9](#49-smoke-test) and [4.9](#49-smoke-test)'s check of the billing portal were checked at `7d20322` against `docs/providers/polar.md`, `apps/admin/app/api/billing/portal/route.ts`, `apps/admin/src/components/live-plan-surface.tsx` and `packages/domain/src/server/billingAccess.ts` (fork PR #74). The brand lines in [4.6](#46-add-the-admin-and-the-worker) and [4.9](#49-smoke-test) were checked against `packages/shared/src/brands/resolve.ts` and `apps/admin/src/lib/onboarding-branding.ts` (fork PR #87).
