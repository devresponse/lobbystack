# Part 1. Prepare

**Status:** written on 2026-10-19, from the rest of this guide, the code on `main` at `d18f916`, and GitHub's documentation. The GitHub steps in [1.4](#14-get-the-code) haven't been tried. [1.3](#13-decide-these-before-any-data-exists)'s note on where the plans' numbers come from was added on 2026-10-22 for fork PR #62 (`a067534`).

Read this part before you open any account. It says which accounts you'll need, how to keep their keys, and which choices can't be undone once businesses use the instance.

## 1.1 Accounts you'll need

[Part 3](part-3-outside-services.md) opens most of these, one environment at a time. Give each person their own login at each one, and make sure someone can stand in for you ([7.14](part-7-operations.md#714-incident-basics-who-acts-what-to-check-first-how-to-tell-users)).

| Account | What it's for | Test | Production | Opened in |
| --- | --- | --- | --- | --- |
| GitHub | The fork, which Railway builds from, and releases | The same fork | The same fork | [1.4](#14-get-the-code) |
| A password manager | Every password, key and secret | Entries for test | Entries of its own | [1.2](#12-your-worksheet-and-keeping-secrets-safe) |
| Railway | Hosting | Yes, on the Pro plan | Yes, or your own server | [4.2](part-4-test-environment.md#42-create-the-account-and-the-project) |
| A domain | The instance's address | Optional | Yes | [3.1](part-3-outside-services.md#31-choose-your-addresses) |
| OpenAI | Calls, the chat's answers, knowledge search | A project | A project of its own | [3.2](part-3-outside-services.md#32-openai) |
| Twilio | Phone numbers, calls and texts | A subaccount | A subaccount of its own | [3.3](part-3-outside-services.md#33-twilio) |
| An email service, such as Resend | Sign-up codes, password resets, invitations, alerts | A key | A key of its own | [3.4](part-3-outside-services.md#34-email) |
| Cloudflare | Turnstile's sign-up check; on Railway, production's backup copies; optionally your DNS | A widget | A widget of its own, and the backup bucket | [3.5](part-3-outside-services.md#35-cloudflare-turnstile), [5.2](part-5-production.md#52-production-on-railway) |
| A server provider, such as Hetzner | Production on your own server | No | Only for [5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose) | [5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose) |
| An uptime check, such as UptimeRobot | Telling you when production stops answering | No | Yes | [5.2](part-5-production.md#52-production-on-railway), step 24 |
| Google Cloud | Google Calendar, and the map on public profile pages | Optional | Optional, a client of its own | [3.7](part-3-outside-services.md#37-optional-services) |
| Firecrawl | Importing a business's website | Optional | The same key | [3.7](part-3-outside-services.md#37-optional-services) |
| PostHog | Errors, analytics and logs | Optional | Recommended, a project of its own | [3.7](part-3-outside-services.md#37-optional-services) |
| Polar | Selling the Starter and Pro plans | Only if you sell plans ([1.3](#13-decide-these-before-any-data-exists)), in Polar's sandbox | Only if you sell plans | [3.7](part-3-outside-services.md#37-optional-services) |

- Your own computer needs none of these for [Part 2](part-2-local-development.md). An OpenAI key adds the chat and browser calls there ([2.1](part-2-local-development.md#21-what-works-on-your-computer)).
- Polar bills only `cloud` businesses, so you need it only when the instance sells plans ([1.3](#13-decide-these-before-any-data-exists)). A self-hosted business is on the unlimited `self_host` plan and never talks to Polar (`packages/domain/src/server/usage.ts:68-69`).
- Railway blocks outgoing email on its Free, Trial and Hobby plans, and LobbyStack sends email only over SMTP, so on Railway, email needs the Pro plan ([3.4](part-3-outside-services.md#34-email)).
- If production will belong to a client, the client opens production's accounts in their own name, and invites you ([5.5](part-5-production.md#55-hand-an-instance-over-to-a-client)).

## 1.2 Your worksheet, and keeping secrets safe

An instance runs on dozens of values: addresses, IDs, keys and passwords. Keep each in one of two places:

- **The worksheet,** [Appendix D](appendix-d-worksheet.md), for everything that isn't secret: names, addresses, IDs, dates, and who holds what. Copy its tables into a document of your own, one for each instance.
- **The password manager,** for everything that gives access: passwords, keys, tokens and secrets. The worksheet names the entry that holds each one, never the value: a worksheet gets printed, shared and left in folders.

1. Choose a password manager that can share entries with the other people who'll run the instance.
2. Keep each environment's keys and secrets in entries of their own, named after it, such as "LobbyStack test: Railway" ([4.3](part-4-test-environment.md#43-make-the-passwords-and-secrets)) and "LobbyStack production: Railway" ([5.2](part-5-production.md#52-production-on-railway), step 3), or "LobbyStack production: server" on your own server ([5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose), step 25). Production never reuses a test value.
3. Decide who holds the master copy: the person who controls the password manager, and at least one other person who can open production's entry. Whoever answers the alerts needs it too ([7.14](part-7-operations.md#714-incident-basics-who-acts-what-to-check-first-how-to-tell-users)). Write their names on the worksheet.
4. Keep the list of your releases, with the date, the commit and what changed, alongside the worksheet ([7.1](part-7-operations.md#71-release-a-new-version), step 10).

Never paste a password, key or secret into GitHub (an issue, a pull request, or a file in the code), a chat, an email, a ticket, a shared document or a screenshot. Paste it only into the password manager and into the provider's or Railway's settings. If one leaks anyway, replace it as [7.18](part-7-operations.md#718-rotate-secrets-and-keys) says.

Two values outlive all the others: `ENCRYPTION_KEY` and `OTP_HASH_SECRET`, values 8 and 12 in [4.3](part-4-test-environment.md#43-make-the-passwords-and-secrets). Changing the first breaks every business's API keys, connected assistants, calendar connections and webhook secrets, and changing the second breaks every saved PIN ([7.18](part-7-operations.md#718-rotate-secrets-and-keys)). No backup holds them, so keep a second copy of production's somewhere that losing the password manager can't take with it ([5.2](part-5-production.md#52-production-on-railway), step 3).

The passwords and secrets you make yourself are random values: [4.3](part-4-test-environment.md#43-make-the-passwords-and-secrets) shows how, with the password manager's generator or one command. On a server, `generate-env.mjs` makes them ([5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose), step 13).

## 1.3 Decide these before any data exists

Most settings can change later. These can't, or only with a lot of work, so decide them before the first business signs up, and write each one on your worksheet.

**1. Whether the instance sells plans.** `DEPLOYMENT_MODE`, set on the admin and the worker ([4.6](part-4-test-environment.md#46-add-the-admin-and-the-worker)), decides what each new business gets. A business keeps the mode it was created with, and only a change in the database moves it (`packages/domain/src/server/tenancy.ts:109`; [8.12](part-8-troubleshooting.md#812-a-business-on-the-free-plan-by-mistake) shows how).

- **It doesn't sell plans:** `self_hosted_standard`, this guide's default. Every business is on the unlimited `self_host` plan, gets a phone number without paying, texts from its own number, and needs no Polar account (`packages/domain/src/server/usage.ts:68-69`). You pay the providers for everyone's use ([7.13](part-7-operations.md#713-costs-and-usage-limits)).
- **It sells Starter and Pro:** `cloud`. New businesses start on the free plan, with 30 minutes of browser calls a month and their messages, transcripts and recordings kept for 30 days, and they get a phone number only once they pay through Polar (`packages/shared/src/billing.ts`, `packages/domain/src/server/phoneNumbers.ts:118`). Those are the plans built into the code. Once the brand's `billing.json` is applied ([3.7](part-3-outside-services.md#37-optional-services), "[Selling plans](part-3-outside-services.md#selling-plans-polar)", step 7), its plans count instead; AlloPlace's has the same numbers. Every cloud business sends its appointment texts, change codes and team alerts from one shared number, `TWILIO_ALERT_SMS_FROM`, which you buy and register yourself (`packages/domain/src/server/smsSender.ts:31-32`; [3.3](part-3-outside-services.md#33-twilio)). Replies typed in **Messages** still go from the business's own number. Polar has its own section ([3.7](part-3-outside-services.md#37-optional-services)).
- A missing variable, `development` or any other value also makes new businesses `cloud` ones, so set it either way. On a server, it goes in `.env` ([5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose), step 15).
- The steps in this guide work for both. Where they differ, they say so.

**2. Who owns production.** If the instance will belong to a client, build production in the client's accounts from the start. Phone numbers, their texting registrations and OpenAI's projects can't simply move later ([5.5](part-5-production.md#55-hand-an-instance-over-to-a-client)).

**3. Where production runs, and where its data lives.** On Railway or on your own server ([5.1](part-5-production.md#51-what-changes-from-the-test-environment), [5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose)). On Railway, pick the region nearest most callers before you add services ([4.2](part-4-test-environment.md#42-create-the-account-and-the-project), step 4): moving a service that has a volume takes it offline while the volume moves, and a bucket's region can't change at all ([4.4](part-4-test-environment.md#44-add-postgresql-redis-and-the-bucket), step 11). If the data must stay in the European Union, use Railway's EU West region or a server in the EU, give the backup bucket the European Union jurisdiction ([5.2](part-5-production.md#52-production-on-railway), step 17), and sign up for PostHog in its EU region ([3.7](part-3-outside-services.md#37-optional-services)). Neither of the last two can be changed later. OpenAI and Twilio still handle every call, wherever production runs; this guide doesn't cover their own regional options.

**4. The address and the brand.** Production's address, such as `app.example.com`, is built into the dashboard and picks its brand ([3.1](part-3-outside-services.md#31-choose-your-addresses), [3.6](part-3-outside-services.md#36-your-brand)). Each phone number keeps the texting address it was bought with, so a new address later means updating every number ([7.23](part-7-operations.md#723-change-the-domain-or-the-brand)). Use a subdomain of a domain that you, or your client, will keep.

**5. Where recordings and files are kept.** In a bucket on Railway, or on the server's own disk ([5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose)). Nothing moves files from one to the other, so never change it once there are files ([7.6](part-7-operations.md#76-change-a-setting-safely)).

**6. The two secrets that can't change.** `ENCRYPTION_KEY` and `OTP_HASH_SECRET` ([1.2](#12-your-worksheet-and-keeping-secrets-safe)). A backup of the database is useful only with the secrets that were in use when it was made, and with the files from the same moment: the database names each file, and the secrets unlock what it stores ([7.8](part-7-operations.md#78-restore-from-a-backup-and-practice-it)).

**7. Which PostgreSQL.** Keep the `pgvector/pgvector:pg16` image that this guide uses. To use Railway's own PostgreSQL instead, decide before production holds any data ([5.1](part-5-production.md#51-what-changes-from-the-test-environment)).

These can change later, with the steps in the sections named:

- The passwords and secrets, after a leak or when someone leaves ([7.18](part-7-operations.md#718-rotate-secrets-and-keys)). A new `BETTER_AUTH_SECRET` signs everyone out, but nothing stored is lost. The PostgreSQL passwords change inside PostgreSQL first, where [7.18](part-7-operations.md#718-rotate-secrets-and-keys) says so.
- Who may sign up ([7.20](part-7-operations.md#720-decide-who-can-sign-up)), how long content is kept ([7.9](part-7-operations.md#79-data-retention-and-deletion-requests)), how long browser calls may last, and whether businesses can add the website chat ([5.1](part-5-production.md#51-what-changes-from-the-test-environment)).
- The providers' keys ([7.18](part-7-operations.md#718-rotate-secrets-and-keys)), and the optional services ([3.7](part-3-outside-services.md#37-optional-services)).

## 1.4 Get the code

Deploy from the fork, `github.com/devresponse/lobbystack`. The original, `lobbystack/lobbystack`, is no longer available, though several docs still link to it ([Appendix E](appendix-e-doc-problems.md)).

Railway deploys each push only when a GitHub account linked to the Railway project can push to the repository ([Part 4](part-4-test-environment.md)), and production follows a branch that you move yourself ([5.2](part-5-production.md#52-production-on-railway)). So you need a copy you control:

- If your GitHub account owns `devresponse/lobbystack`, or can push to it, use it as it is, and go on with step 4.
- Otherwise, make your own copy, a **fork**, with steps 1 to 3.

**Make your own fork** *(not tried)*

1. Sign in to GitHub, open `github.com/devresponse/lobbystack`, and click **Fork** at the top right. The code is public, so any GitHub account can.
2. Under **Owner**, choose your own account, or your organization. Keep the name `lobbystack`, make sure **Copy the `main` branch only** is ticked, and click **Create fork**.
3. From now on, `github.com/<owner>/lobbystack` in this guide means your fork, with your account's name as `<owner>`. When you get the code in [2.3](part-2-local-development.md#23-get-the-code-and-create-your-settings-file), clone your fork, not `devresponse`'s: releases push from that copy ([7.1](part-7-operations.md#71-release-a-new-version)).

**Turn its checks on**

4. Open the fork's **Actions** tab. GitHub runs no checks in a new fork until its owner allows them, so click **I understand my workflows, go ahead and enable them** *(not tried)*. In `devresponse/lobbystack` itself, they're already on.
   - The checks then run on every push to `main`, and take about 10 minutes. Until they pass, a commit shows no green check mark, and [5.2](part-5-production.md#52-production-on-railway) and [7.1](part-7-operations.md#71-release-a-new-version) release only a commit that shows one.
   - They need no secrets of yours: the jobs that use secrets run only in the original repository, or when someone starts them by hand (`.github/workflows/ci.yml:172`, `.github/workflows/replacement-platform.yml:143`).
   - The original's automatic production release job (`migrate-production`) runs only in `lobbystack/lobbystack`, so in the fork nothing releases production for you (`.github/workflows/ci.yml:170-172`).

**Choose the version**

5. Deploy `main`: changes are merged into it once their checks pass. Production gets a branch of its own, `production`, which you move to each tested version ([5.2](part-5-production.md#52-production-on-railway), step 2; [7.1](part-7-operations.md#71-release-a-new-version)). Other branches in `devresponse/lobbystack`, such as `alloplace/r1`, belong to particular instances.
6. A version is a **commit**, named by its ID, such as `d18f916`: the first seven characters of a longer one. On `github.com/<owner>/lobbystack/commits/main`, a green check mark next to a commit means all its checks passed, and a red cross that one failed. Write down each version you put live, with the date ([7.1](part-7-operations.md#71-release-a-new-version), step 10). A running instance shows its own at `/api/health/live`, as `"version"` ([7.10](part-7-operations.md#710-health-checks-and-uptime-monitoring)).

**Keep your fork up to date**

7. New versions reach `devresponse/lobbystack` first. To bring them into your fork, open the fork's page on GitHub, open **Sync fork** above the list of files, read the commits it lists, and click **Update branch** *(not tried)*.
   - The update is a push to your `main`, so the test environment deploys it ([4.10](part-4-test-environment.md#410-keep-the-test-environment-up-to-date)) while the checks run on it. Release it to production only once both are fine ([7.1](part-7-operations.md#71-release-a-new-version)).
   - If GitHub offers a pull request instead, your `main` has changes of its own that clash with the new ones, such as your own brand ([3.6](part-3-outside-services.md#36-your-brand)). Ask someone technical to merge them, and to run `pnpm brands:build` again if `brands/` is involved *(inferred)*.

**Let your computer push to GitHub** *(not tried)*

8. Releases push from the copy of the code on your computer ([5.2](part-5-production.md#52-production-on-railway), step 2; [7.1](part-7-operations.md#71-release-a-new-version), step 6), and GitHub takes a push only from someone signed in to an account that can push to the repository. Once Git is installed ([2.2](part-2-local-development.md#22-install-the-tools)), set up the sign-in the way GitHub recommends:
   - **On Windows,** Git for Windows includes Git Credential Manager: the first push opens a browser window, where you sign in to GitHub.
   - **On a Mac or Linux,** install GitHub CLI (`cli.github.com`), run `gh auth login`, choose `HTTPS` when it asks which protocol Git should use, and answer `Y` when it asks whether to authenticate Git with your GitHub credentials.

**Not yet confirmed:**

- GitHub's labels on a new fork of `devresponse/lobbystack`, and whether **Update branch** starts the checks and Railway's deploy, as any other push to `main` does ([1.4](#14-get-the-code)).
- How the first push signs in, on each system ([1.4](#14-get-the-code), step 8).
- How long each part takes: nothing was timed beyond [Part 2](part-2-local-development.md) ([0.7](part-0-start-here.md#07-time-and-money)).
- What a real instance uses at Railway each month ([0.7](part-0-start-here.md#07-time-and-money), [4.1](part-4-test-environment.md#41-how-the-railway-project-is-laid-out)).

**Parts 0 and 1 were checked against:** `LICENSE`, `AGENTS.md`, `.env.example`, `docker-compose.yml`, `.railway/template.ts` and `.railway/railway.ts` (as a reference only), `.github/workflows/ci.yml`, `.github/workflows/replacement-platform.yml`, `.github/workflows/runtime-images.yml`, `docs/voice/runtime.md`, `apps/admin/app/api/webhooks/openai/live/route.ts`, `apps/admin/app/api/widget/chat/route.ts`, `packages/db/migrations/0000_roles.sql`, `packages/domain/src/server/tenancy.ts`, `packages/domain/src/server/usage.ts`, `packages/domain/src/server/phoneNumbers.ts`, `packages/domain/src/server/smsSender.ts`, `packages/shared/src/billing.ts`, `apps/worker/src/handlers.ts` and `scripts/write-brands.ts`, on `main` at `d18f916`, GitHub's documentation on forking, syncing a fork, workflows in forks and caching Git credentials, and Polar's fees and pricing pages, as read on 2026-10-19.
