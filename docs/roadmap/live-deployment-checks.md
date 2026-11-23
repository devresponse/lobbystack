# Check every live deployment after each deploy

Nothing checks a deployment once Railway has deployed it. The push gate runs the migrations, row-level security and Playwright journeys on CI's own database before the deploy, and `pnpm release:check --staging` needs the database's and Redis's addresses, so neither can run against a live deployment. After a deploy, someone runs `pnpm smoke:production` by hand ([guide 4.9](../deployment/guide/part-4-test-environment.md#49-smoke-test)) or reads the health and fleet addresses ([observability](../features/observability.md)). The design of 2026-11-23 proposes test businesses on each deployment, made and kept in step through the v1 API, and a runner that GitHub Actions starts when Railway reports a deploy, on a schedule and by hand. Every check goes through the deployment's public addresses: nobody signs in to its database.

- **Status:** designed; waiting on six decisions.
- **Effort:** about 15 to 21 days in 7 pull requests. The first, the runner with the smoke suite against today's code, takes about 3 days and changes nothing on the server.

## Know what it would check

46 checks in three suites. A deploy counts as validated when every critical check of the smoke and standard suites passes on the commit it runs, within 30 minutes of Railway's report. A deep-suite failure is an incident to fix, not a failed deploy, since it depends on outside networks the deploy didn't touch.

| Suite | When | Takes | What it covers |
| --- | --- | --- | --- |
| Smoke | Hourly and after each deploy | About 2 minutes | Every admin and worker copy on the deployed commit, the migrations, readiness, the certificate, the public pages, the webhook routes refusing unsigned requests, and the settings. Reads only |
| Standard | After each deploy and by hand | About 8 minutes | Each provider's key, by one read-only question; tenant isolation on the live database; every queue; webhooks, live updates and knowledge indexing; a booking; a website chat; a message taken. Writes only to the test businesses |
| Deep | Nightly and by hand | About 15 minutes | A browser call, a phone call between the test businesses' own numbers, texts, an email, a PDF and a website page read into knowledge. Under $1 a night |

AI answers vary, so each AI journey asks for a fact found nowhere else and passes on 2 tries of 3. A check retries once after a network error or a 5xx.

## Know the test businesses

- **Two canaries,** Live check A and Live check B, owned by one account the operator controls and signs up by hand, since sign-up's Turnstile check stops scripts. That account's first business, which can't be deleted, holds nothing, so the canaries can be deleted and made again around it.
- **A platform key of their own,** with partner access, so the API refuses it every other business. It makes the canaries and keeps them in step with a manifest in the repository through `lobbystack onboard`, and has no billing scope.
- **A `synthetic` flag** on `businesses`, set only for businesses a key marked `"synthetic": true` in `PLATFORM_API_KEYS` makes. Such a business starts on a managed plan, so nothing reaches Polar or Stripe; has analytics off; stays out of the control panel's totals, the finance export and the usage rollups; and keeps its content for 7 days.
- **B is the other tenant:** A's key sent with B's ID must get 403. With a number each, B's number also places the test call to A's.
- **What a run makes carries the run's ID,** and a nightly job deletes what's older than 7 days from synthetic businesses only.

## Know what the server would gain

Five additions behind one token, `LIVE_CHECKS_TOKEN`, off until it's set, like `FLEET_STATUS_TOKEN`; each route answers 404 without it.

- **A self-check:** each provider asked one read-only question with the deployment's own keys, and the live schema, row-level security and migration journal compared with the code's. It returns results and fingerprints, never values, and asks every worker copy too.
- **A sink** for the canaries' webhooks, which checks their signatures.
- **A pass for the canaries' website chat** in place of Turnstile, for synthetic businesses only, signed with the token and valid for 5 minutes. The widget's other limits still apply.
- **A ping job** on each queue.
- **A record of each run,** which the control panel's System health shows.

## Know how it runs

- **After a deploy:** `.github/workflows/live-checks.yml` runs on Railway's `deployment_status` events, waits until every admin and worker copy reports the deployed commit, then runs smoke and standard. A deployment built from another repository runs the same workflow in that repository.
- **On a schedule and by hand:** smoke hourly, deep nightly, and **Run workflow**. GitHub runs these only from the default branch, so the workflow file has to be on `main` (a decision below).
- **Results:** the job summary, a commit status `live-checks/<deployment>` on the deployed commit, the deployment's own record of the run, and an alert when a deployment turns red and when it recovers.
- **Nothing rolls back by itself.** A runbook says what to try, including when rolling back past a migration is safe.
- **Between runs:** an uptime monitor on `/api/health/ready` and the fleet address, which item 6 of [open items](../project/open-items.md#do-these-on-the-demo-after-deploys) still asks for, and Railway's project webhook for failed and crashed deploys.

## Keep it safe

- **No real charges:** the managed plan, and a runner that may call only a fixed list of operations, with no billing write, number purchase or invitation on it, checked by a test.
- **No messages to real people:** only the canaries' own numbers and the operator's mailbox are used; transfers are off; booking confirmations go to a canary's number or nowhere.
- **Writes only to the canaries:** the API refuses the key elsewhere, and the runner refuses any business that isn't synthetic.
- **A kill switch:** a repository variable pauses a deployment's runs; unsetting the token turns the routes off; removing the key's entry stops every call made with it.
- **Secrets:** each deployment's in a GitHub Environment of its own, none of which opens a customer's business.

## Know the plan

| Pull request | Delivers | Days |
| --- | --- | --- |
| 1 | The runner, `pnpm live-checks`, and the smoke suite against today's code | 2 to 3 |
| 2 | The GitHub workflow, commit statuses and alerts | 1 to 2 |
| 3 | The self-check, queue pings and run records | 3 |
| 4 | The `synthetic` flag, the canaries' key, provisioning, and keeping canaries out of the numbers | 3 |
| 5 | The standard suite, the webhook sink and the website chat pass | 3 to 4 |
| 6 | The deep suite: calls, texts, email and documents | 2 to 4 |
| 7 | The control panel's card, the outside watchers, and the other deployments | 1 to 2 |

3 and 4 can be built side by side once 1 is in.

## Know a finding on the way

During a rollout, old and new worker copies take jobs from the same queues, and a new admin can run beside old workers. An old copy that takes a job type added in the release answers "Worker handler is not configured" (`apps/worker/src/handlers.ts`), and the job's attempts run out in about 15 seconds (`packages/jobs/src/index.ts`), so the job is lost to the failed list. Pull request 3 makes the worker defer a job type it doesn't know, for up to an hour, without spending an attempt.

## Decide these

- Which deployment gets canaries first. Recommended: a test deployment, then production after a month of quiet runs.
- The canary account's mailbox. Recommended: a new mailbox on the operator's domain, with a plus address per deployment.
- Two phone numbers per deployment, about $2.30 a month plus the nightly calls. Without them the phone call and the texts are skipped.
- Where alerts go: a Slack or Discord channel, which take the same webhook, or email.
- Whether a red run may roll a deploy back by itself. Recommended: no.
- Whether the workflow file may go on `main` and `alloplace/r1` for the schedules and **Run workflow**. Recommended: yes.

Checked against `develop/r2` at `dd7966c` (2026-11-23).
