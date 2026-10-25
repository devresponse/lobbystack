# Develop and test

How to work on the code: set up a checkout, run the checks a pull request needs, and avoid what trips them up. [Contributing](../../CONTRIBUTING.md) has the short version, `AGENTS.md` the rules for coding agents, and [part 2 of the deployment guide](../deployment/guide/part-2-local-development.md) a step-by-step local setup. Checked against `main` at `da1f548`.

## Set up a checkout

- Use Node 26, as CI does, and pnpm 10.30.3 (`packageManager` in `package.json`).
- `pnpm env:generate` writes `.env` with new random secrets. Keep your own keys and overrides in `.env.local`, which wins over `.env` and which Git and Docker both ignore.
- Build `@lobbystack/telemetry` before the first `pnpm dev`, and again after changing it: the admin loads it from its build output. In a fresh checkout, `pnpm build` once also builds the packages some tests import.
- `next dev` rewrites `apps/admin/next-env.d.ts`. Restore it before committing.
- To run the whole stack in Docker, debug in VS Code, or take real calls on your desktop through a tunnel, follow [run and debug on your desktop](../voice/local-debugging.md).

## Run the checks before a pull request

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

- After changing migrations, roles or row-level security, also run `pnpm db:check` and `pnpm db:verify-rls`.
- The database integration tests run with `pnpm test:reliability` and need `LOBBYSTACK_RELIABILITY_TEST_DATABASE_URL`, pointing at a dedicated database whose name contains `test`. Without it they skip. The admin's sign-in tests also need `LOBBYSTACK_AUTH_TEST_DATABASE_URL`, which only CI's database job sets, so set it when you change sign-in emails or the users table.
- `pnpm e2e:local` runs the browser tests against a local stack in Docker.
- The `replacement:*` checks commit their rows. After several runs on one database, `pnpm replacement:recovery` fails with "Outbox dispatcher did not claim the recovery message"; CI runs it on a fresh, seeded database, so reproduce it that way.
- When you change GPT-Live's instructions, the call controller or how calls end, run `pnpm voice:eval` before opening the pull request and `pnpm voice:call` against a test deployment before merging ([voice testing](../voice/testing.md)). Both need an OpenAI key.
- Every new telemetry event needs a test that it fires from its real code path.

CI runs on every pull request and every push to `main` ([overview](../project/overview.md#make-a-change)).

## Know what trips the checks up

- **The worker's docx heap test** (`apps/worker/src/documentExtraction.thread.test.ts`) can fail on a small machine. `pnpm test` runs packages in turn and stops at the first failure, so the admin's tests then never run: run them on their own with `pnpm --filter @lobbystack/admin test`, and say so in the pull request's testing notes.
- **Some browser tests never run in CI.** Specs such as the agent workflows, the demo operator and the startup performance tests skip unless the release readiness script (`scripts/release-readiness.ts`) prepares operator sessions (`PARITY_PORT_OPERATOR_STORAGE_STATE_*`), and the widget chat, password recovery, website import and demo-operator specs need their own `*_E2E=1` switches and a fake AI. Saved sessions survive between Playwright runs only when the auth, internal-service, widget, encryption and OTP secrets are pinned in the environment.
- **Timing-sensitive tests flake under load.** Wait on the condition, such as `vi.getTimerCount()`, rather than on time.
- **Trivy and CodeQL** can fail a pull request on things it didn't change ([overview](../project/overview.md#make-a-change)).

## Keep a transaction's queries in order

Never start several queries at once on one transaction, as `Promise.all` over `tx` does. A transaction is one pooled connection: `pg` queues the queries and prints a deprecation warning ("client already executing a query"), and its next major version will refuse them. Fork PR #48 removed 18 such places, and `scripts/transaction-queries.test.ts` now fails on any `Promise.all` or `Promise.allSettled` that starts two or more queries on a transaction (a parameter named `tx`, typed `DatabaseTransaction`, or the first parameter of a `*transaction(` callback). Await the queries one after the other: it costs the same round trips.

Parallel queries are fine on the pool, outside a transaction, since each gets its own connection. A test fixture that shares one transaction for everything turns them into the same problem, which is why `publicProfiles.integration.test.ts` wraps its transaction in `oneTransactionAtATime`. Take care with `runIdempotent`, which hands its transaction to idempotent v1 and MCP operations as `context.db`.

## Write integration tests that clean up

- Keep each test's rows in one transaction that rolls back, with the `rollbackTest` helper the integration test files define, so tests running in parallel don't see each other's data.
- `billingCatalog.integration.test.ts` commits catalog rows and deletes them afterwards. A rollback test that reads `billing_plans` or `billing_prices` takes `pg_advisory_xact_lock(hashtext('lobbystack.billing_catalog'))` first, as the billing catalog and code tests do since fork PR #67.

## Develop on Windows

- Line endings need no setting: `.gitattributes` checks every text file out with Linux line endings (LF), whatever Git for Windows' `core.autocrlf` says, because Postgres runs `docker/postgres/init/roles.sh` in Linux and bash fails on Windows line endings (CRLF). `scripts/line-endings.test.ts` fails if a shell script or `.env.example` would come out with CRLF. A clone made before fork PR #83 needs a `git pull`, and `docker compose down -v` if Postgres already started ([line endings on Windows](../voice/local-debugging.md#line-endings-on-windows)).
- Keep keys in `.env.local`, never in another untracked file: a `docker compose ... --build` sends the whole folder to Docker, and `.dockerignore` leaves out the `.env` files but not other files you keep there.
- Never add files with `git add -A` in a checkout that has untracked notes or scripts: add them by name.

## Update the docs

A change updates the docs in the same pull request ([keep this folder true](../README.md#keep-this-folder-true)): the feature page it changes, the [changelog](../project/changelog.md), [open items](../project/open-items.md) for anything it leaves to do after the deploy, and the [route catalog](../reference/routes.md) for a new page or route.
