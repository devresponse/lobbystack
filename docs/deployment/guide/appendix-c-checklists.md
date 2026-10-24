# Appendix C. Printable checklists

Print these, or copy them into a shared document, and tick each line as it's done. Each line names the section that explains it. Routine upkeep has its own calendar in [7.25](part-7-operations.md#725-routine-maintenance-calendar).

**Before you deploy an environment**

For the test environment ([Part 4](part-4-test-environment.md)), then again for production ([Part 5](part-5-production.md)):

- [ ] Whether the instance sells plans is decided, and so its `DEPLOYMENT_MODE`, before the first business exists ([1.3](part-1-prepare.md#13-decide-these-before-any-data-exists)).
- [ ] The address and the brand are decided: the brand is built into the dashboard from the address ([3.1](part-3-outside-services.md#31-choose-your-addresses), [3.6](part-3-outside-services.md#36-your-brand)).
- [ ] The fork is on GitHub with its checks turned on, and the commit to deploy shows a green check mark ([1.4](part-1-prepare.md#14-get-the-code)).
- [ ] The outside accounts are ready, and their values are on your worksheet ([3.8](part-3-outside-services.md#38-before-you-go-on), [Appendix D](appendix-d-worksheet.md)). Production has its own OpenAI project, Twilio subaccount, email key, Turnstile widget and Google client ([5.1](part-5-production.md#51-what-changes-from-the-test-environment)).
- [ ] The passwords and secrets are made and saved in the environment's password manager entry. Production's are all new ([4.3](part-4-test-environment.md#43-make-the-passwords-and-secrets); [5.2](part-5-production.md#52-production-on-railway), step 3).
- [ ] On Railway, the workspace is on the Pro plan, which sending email needs ([3.4](part-3-outside-services.md#34-email)).
- [ ] On a server: Ubuntu 24.04 on x86, with at least 2 vCPUs, 4 GB of memory and 80 GB of disk, the provider's backups and firewall on, and IPv6 not switched off ([5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose), steps 1 to 8).
- [ ] For production: the `production` branch is at the commit you tested ([5.2](part-5-production.md#52-production-on-railway), steps 1 and 2), your computer can push to the fork for releases ([1.4](part-1-prepare.md#14-get-the-code), step 8), and the decisions in [5.1](part-5-production.md#51-what-changes-from-the-test-environment) are made: how long a browser call may last, the website chat, what the greeting tells callers, and how long content is kept.

**Go-live**

The same list as [5.4](part-5-production.md#54-go-live-checklist). Go through it once production is set up, before you give its address to anyone.

*The version and the settings*

- [ ] Production runs a commit whose checks passed and which passed the smoke test on the test environment ([4.9](part-4-test-environment.md#49-smoke-test)). You've noted it and the date; `https://app.example.com/api/health/live` shows it as `"version"`.
- [ ] Every password and secret is new, production's password manager entry holds them all, and a second copy of `ENCRYPTION_KEY` and `OTP_HASH_SECRET` is kept elsewhere ([5.2](part-5-production.md#52-production-on-railway), step 3). On a server, the entry holds the whole `.env` file ([5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose), step 25).
- [ ] `DEPLOYMENT_MODE` on the admin and the worker is what you decided ([1.3](part-1-prepare.md#13-decide-these-before-any-data-exists)). On a server, `docker compose exec admin printenv DEPLOYMENT_MODE` shows it ([5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose), step 20).
- [ ] `https://app.example.com/api/health/ready` opens without a certificate warning and shows `"ok":true`, all three checks `ok`, and the brand you expect.
- [ ] The test environment uses none of production's accounts or keys, and production none of the test environment's ([5.1](part-5-production.md#51-what-changes-from-the-test-environment)).

*Sign-up and sign-in*

- [ ] `REQUIRE_EMAIL_VERIFICATION=true` is set on the admin, and your own sign-up asked for the email code ([6.1](part-6-first-run.md#61-create-your-account)).
- [ ] You signed up first, and you've decided who else may sign up ([6.1](part-6-first-run.md#61-create-your-account), [7.20](part-7-operations.md#720-decide-who-can-sign-up)).

*Calls, texts and email*

- [ ] OpenAI's webhook in production's project points at production's address, and a browser call and a phone call both worked ([4.8](part-4-test-environment.md#48-connect-the-providers-to-this-environment), [Part 6](part-6-first-run.md)).
- [ ] The business's number belongs to production's Twilio subaccount, and its texting registration is approved or under way ([3.3](part-3-outside-services.md#33-twilio)). A text to it showed up in **Messages** ([6.4](part-6-first-run.md#64-get-a-phone-number-and-make-the-first-calls)).
- [ ] The email code and an invitation arrived, from production's email key ([6.1](part-6-first-run.md#61-create-your-account), [6.6](part-6-first-run.md#66-invite-the-team)).
- [ ] Each business that takes calls has a greeting that tells callers what their laws require, such as that an AI answers and the call is recorded ([5.1](part-5-production.md#51-what-changes-from-the-test-environment)).
- [ ] An update doesn't cut calls off. On Railway, the worker has `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=1860`, so calls run on for up to 30 minutes ([4.6](part-4-test-environment.md#46-add-the-admin-and-the-worker), step 5). On a server, the override file gives the worker 45 seconds to say goodbye to each caller ([5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose), step 17).

*Data*

- [ ] Backups run, and a copy is kept outside Railway or off the server ([5.2](part-5-production.md#52-production-on-railway), steps 16 to 22, or [5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose), steps 27 and 28).
- [ ] A restore has been practiced: on a server, with the drill ([5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose), step 26); on Railway, on the test environment ([7.8](part-7-operations.md#78-restore-from-a-backup-and-practice-it)).
- [ ] You know how long content is kept ([5.1](part-5-production.md#51-what-changes-from-the-test-environment)), and who answers a request to delete someone's data ([7.9](part-7-operations.md#79-data-retention-and-deletion-requests)).

*Watching and money*

- [ ] An outside uptime check watches `https://app.example.com/api/health/ready`, and tells you by email or text when it fails ([5.2](part-5-production.md#52-production-on-railway), step 24, or [5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose), step 29).
- [ ] On Railway, its notifications reach you ([5.2](part-5-production.md#52-production-on-railway), step 23). On a server, someone checks the disk space and the backup log every month ([5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose)).
- [ ] Spending alerts are set at Railway or the server's provider, at OpenAI and at Twilio, with no hard limit at Railway ([5.2](part-5-production.md#52-production-on-railway), step 26), and Twilio's balance has room.
- [ ] Only if the instance sells plans: the admin and the worker each have a Polar token of their own, with only the scopes in [3.7](part-3-outside-services.md#37-optional-services), "[Selling plans](part-3-outside-services.md#selling-plans-polar)", step 3, or on a server one token with those nine, and no token on the instance has `webhooks:read`. A token made before fork PR #74 is deleted in Polar ([7.18](part-7-operations.md#718-rotate-secrets-and-keys)).
- [ ] Only if the instance sells plans: `pnpm billing verify --brand <brand> --polar live --profile production` ends `Result: in sync (exit 0).`, and the setup token is deleted in Polar ([3.7](part-3-outside-services.md#37-optional-services), "[Selling plans](part-3-outside-services.md#selling-plans-polar)", step 8). **Upgrade to Pro** under **Settings** > **Plan** shows the brand's prices in its currency, not in US dollars.

*People*

- [ ] Everyone who can open production, at Railway or on the server, on GitHub, at each provider and in the password manager, has a login of their own, and nobody else has one.
- [ ] Someone receives the alerts and knows what to check first ([7.14](part-7-operations.md#714-incident-basics-who-acts-what-to-check-first-how-to-tell-users)).
- [ ] If production will belong to a client, its accounts, its GitHub copy and its Railway project or server are in the client's name, or you've planned how each one moves ([5.5](part-5-production.md#55-hand-an-instance-over-to-a-client)).

**Every release**

From [7.1](part-7-operations.md#71-release-a-new-version):

- [ ] The commit shows a green check mark on GitHub, and the test environment runs it: its `/api/health/live` shows it as `"version"` (steps 1 and 2).
- [ ] On the test environment: sign-in, a browser call, a call to a test number, and a chat on a public profile page all work, plus whatever the change touches. A change to how calls behave also passed `pnpm voice:call` (step 3).
- [ ] The compare page is read (step 4). A change under `packages/db/migrations/` means [7.3](part-7-operations.md#73-database-migrations) is read first. Each new line in `.env.example` is understood, and the ones production needs are set before the release.
- [ ] The hour is chosen (step 5): on Railway, a quiet one if the database changes, and not 03:00 UTC; on a server, one when nobody calls, since an update ends the calls in progress.
- [ ] `production` is moved to the commit (step 6).
- [ ] On Railway: migrate's log ends with `RLS enabled and forced on <n> tables.`, and the admin's and the worker's newest deployments show **Active** (step 7).
- [ ] On a server: the backup ran first, the migrator ended with `Database migrations applied.`, and the checks in [5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose), steps 20 to 22, pass (step 8).
- [ ] `https://app.example.com/api/health/live` shows the new commit, `/api/health/ready` shows `"ok":true`, you can sign in, and a browser call works (step 9).
- [ ] The date, the commit ID and a line on what changed are added to your release list (step 10).

**When something breaks**

From [7.14](part-7-operations.md#714-incident-basics-who-acts-what-to-check-first-how-to-tell-users):

- [ ] Write down the time, what was reported and by whom, and keep notes as you go.
- [ ] Open `https://app.example.com/api/health/ready`, and note which check shows `"failed"`, or whether nothing answers.
- [ ] Look at the status pages of OpenAI, Twilio, and Railway or the server's provider ([7.10](part-7-operations.md#710-health-checks-and-uptime-monitoring)).
- [ ] Look at the release list. If a release went out just before the problem started, roll it back first ([7.5](part-7-operations.md#75-roll-back-a-bad-release)).
- [ ] Find the symptom in [7.14](part-7-operations.md#714-incident-basics-who-acts-what-to-check-first-how-to-tell-users)'s table or in [Part 8](part-8-troubleshooting.md)'s index, and follow its section. Change one thing at a time.
- [ ] Tell the businesses early: what doesn't work, since when, what they can do meanwhile, and when you'll write again.
- [ ] Once it's fixed, check production as in [7.1](part-7-operations.md#71-release-a-new-version), step 9, and call one business's number.
- [ ] Write to the businesses again: what happened, and what their callers may have missed.
- [ ] Write a short note: the times, the cause, what fixed it, and what would have shown it sooner. Keep it with the release list.
