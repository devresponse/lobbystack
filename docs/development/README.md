# Develop and test

How to work on the code: set up a checkout, run the checks a pull request needs, and avoid what trips them up. [Contributing](../../CONTRIBUTING.md) has the short version, `AGENTS.md` the rules for coding agents, and [part 2 of the deployment guide](../deployment/guide/part-2-local-development.md) a step-by-step local setup. Checked against `main` at `da1f548`.

## Set up a checkout

- Use Node 26, as CI does, and pnpm 12.15.0 (`packageManager` in `package.json`).
- `pnpm env:generate` writes `.env` with new random secrets. Keep your own keys and overrides in `.env.local`, which wins over `.env` and which Git and Docker both ignore.
- Build `@lobbystack/telemetry` before the first `pnpm dev`, and again after changing it: the admin loads it from its build output. In a fresh checkout, `pnpm build` once also builds the packages some tests import.
- Git ignores `apps/admin/next-env.d.ts`. Next writes it whenever `next dev`, `next build` or `next typegen` runs, and the admin's `typecheck` script runs `next typegen` before `tsc`, so a fresh checkout and CI get it too.
- To run the whole stack in Docker, debug in VS Code, or take real calls on your desktop through a tunnel, follow [run and debug on your desktop](../voice/local-debugging.md).

## Run the checks before a pull request

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

- After changing migrations, roles or row-level security, also run `pnpm db:check`, `pnpm db:compare-schema` and `pnpm db:verify-rls`, and `pnpm db:freeze-migrations` when you add a migration file ("[Change the schema in two places](#change-the-schema-in-two-places)").
- The public API's rate limit is tested against a real Redis when `REDIS_TEST_URL` is set, as CI's database job does; without it that one test skips.
- The database integration tests run with `pnpm test:reliability` and need `LOBBYSTACK_RELIABILITY_TEST_DATABASE_URL`, pointing at a dedicated database whose name contains `test`. Without it they skip. The admin's sign-in tests also need `LOBBYSTACK_AUTH_TEST_DATABASE_URL`, which only CI's database job sets, so set it when you change sign-in emails or the users table.
- `pnpm e2e:local` runs the browser tests against a local stack in Docker.
- The `replacement:*` checks commit their rows. After several runs on one database, `pnpm replacement:recovery` fails with "Outbox dispatcher did not claim the recovery message"; CI runs it on a fresh, seeded database, so reproduce it that way.
- When you change GPT-Live's instructions, the call controller or how calls end, run `pnpm voice:eval` before opening the pull request and `pnpm voice:call` against a test deployment before merging ([voice testing](../voice/testing.md)). Both need an OpenAI key.
- Every new telemetry event needs a test that it fires from its real code path.
- A call from a server to another service needs a time limit: Node's `fetch` has none short of 300 seconds. Use `fetchWithTimeout` (`@lobbystack/shared`), which gives a call 15 seconds unless you pass another limit, or write a `signal` in the `fetch` call. Since fork PR #189, `scripts/outbound-fetch.test.ts` fails on a `fetch` without one in the worker, the admin's `app/api` and the server packages (the technical audit's AUDIT-023). The admin's `src/` isn't read, since its browser code calls `fetch` too.
- A log line's own keys are `level` and `message`, so `logEvent` doesn't compile with a field of either name: call it `detail`, or what it is ([telemetry](../telemetry/architecture.md#follow-one-call)).

CI runs on every pull request and every push to `main`, to a release branch such as `releases/r2` or to a development branch such as `develop/r2` ([overview](../project/overview.md#make-a-change)).

## Search for what the person typed

Text from a search box goes through `searchPattern` (`@lobbystack/db`) before it reaches `ilike`. `%` and `_` are wildcards in SQL's `LIKE` and `\` is its escape character, so without it a search for `50%` matched everything beginning "50", `o_t` matched "out" and "oat" alike, and a term ending in a backslash failed with a PostgreSQL error (the technical audit's AUDIT-012). `scripts/search-pattern.test.ts` reads the source and fails on a `LIKE` pattern built by interpolation, so the next search can't repeat it.

**How much the call search costs, measured.** The audit suspected the call list's search of scanning a business's whole history twice per page and said to measure before changing anything. Measured on PostgreSQL 16 with 50,000 calls, 50,000 contacts and 300,000 transcript lines in one business:

| What the page does | Time |
| --- | --- |
| List, no search | 0.04 ms |
| Count, no search | 6 ms |
| List, searching a term that matches rows near the top | 2 ms |
| List, searching a term that matches nothing | 107 ms |
| List, searching, page 20 (`offset 1000`) | 122 ms |
| Count, searching | 149 ms |

So a search costs about a quarter of a second at 50,000 calls, and the count is the larger half of it. Two things are worth knowing before changing this. The planner already drops the `contacts` and `conversations` joins from the count when nothing searches them, so there is nothing to win by building the two queries separately. And capping the count (`limit 1001` inside it) helps only a term that matches a lot, where it takes 149 ms down to 25 ms. A term that matches nothing still has to look at every call, so the cap buys nothing in the case that is already the slowest.

The step that would change the shape of the curve is an index `ilike '%term%'` can use: `pg_trgm` GIN indexes on the searched columns, which needs `create extension`, something no migration here does yet. It would also mean giving up the correlated subquery over the last transcript line, which cannot use an index, and searching every line with `exists` instead, which is probably what somebody searching a transcript wants anyway. On these numbers it is worth doing when a business passes a few hundred thousand calls, and not before.

## Lint with the types in hand

The admin's ESLint reads the TypeScript program (`recommendedTypeChecked` with `projectService`, the technical audit's AUDIT-020). Without the types, a rule sees `save(row)` and can't tell whether it returned a promise, so the two mistakes that look like working code were invisible to every check the repository runs:

- `@typescript-eslint/no-floating-promises`: a promise nobody waits for, which loses its error and finishes whenever it likes;
- `@typescript-eslint/no-misused-promises`: an `async` function handed to something that expects no return value, such as a Node request handler, where a rejection takes the process down instead of the request.

Both are errors. React's `act` is allowed to float, because with a synchronous callback React's own documentation says not to await it, and `checksVoidReturn.attributes` is off, because `onSubmit={async () => …}` is how React is written.

Reading the program costs about 45 seconds and more memory than Node gives a script by default, so `apps/admin`'s `lint` script starts ESLint through `node --max-old-space-size=4096` rather than the usual shim. Leave that in place; without it the run dies with a heap error that looks nothing like a lint failure.

**The rules turned off in `eslint.config.mjs` carry a count, and the count only goes down.** Eleven of the set's rules, from `require-await` at 566 hits and `no-unsafe-member-access` at 328 down to three, are each a piece of work of their own, and leaving them on as warnings would bury the two that matter. Their counts on 2026-11-16 are written beside them. Take a family on, fix it, delete its line; never raise a number, and never add a line without one.

## Check a provider's answer where it comes in

What a provider sends back is `unknown` until something has checked it. `(await response.json()) as Subscription` tells the compiler a shape nobody looked at, and on the day the provider changes that shape the mistake turns up as an `undefined` in billing, far from the call. This is the second half of the technical audit's AUDIT-020.

Polar's billing client, `packages/providers/src/polar/polarBilling.ts`, is the pattern to copy:

- `request` returns `unknown`, so the compiler refuses any use of an answer that a schema hasn't read.
- Each answer billing reads has a zod schema that names only the fields billing reads. A field the provider adds is ignored. A field billing can do without may be missing or null, but never of another type.
- An answer that fails raises `PolarResponseError` with the answer's name and the fields: `Polar's subscription is missing or mistypes: product_id.` The values stay out of the message, because an answer can hold a customer's email and the message goes to the logs.

Stripe, Twilio and the embedding provider come through their SDKs' own types, and Polar's webhooks and catalog calls already read each field as `unknown`. Two hand-written clients still cast what they fetch: Google Calendar (`packages/providers/src/google/calendar.ts`, five answers) and Firecrawl (`packages/providers/src/crawling/firecrawl.ts`, one). Give a client its schemas when you next change it.

## See how much the tests cover

`pnpm test:coverage` runs the admin, worker, `db` and `domain` suites with coverage and prints one table for the four. Every source file counts, not only the ones a test imported, so an untested file shows as zero instead of vanishing. The settings live in `vitest.coverage.mts` and the table comes from `scripts/coverage-summary.mjs`.

The integration suites skip themselves without a test database, so `packages/domain` and `packages/db` read lower than what CI's database job exercises; the admin and worker figures are the real ones.

There is no threshold yet (AUDIT-021). CI's `coverage` job publishes the same table in its summary and keeps each package's `lcov.info` as an artifact for 14 days. It is deliberately outside the `validate` gate for now, so a coverage run never blocks a release; once the numbers have been watched for a month, the measured figures become each package's floor and the job joins the gate.

Coverage measures the Vitest suites only. The browser journeys are not counted, and a journey that passed only after a retry is named under **Flaky journeys** in the e2e job's summary (`scripts/flaky-journeys.mjs`), so a retry that turned green is still visible.

## Check what a request sends

Every dashboard route under `apps/admin/app/api` reads its body with `parseBody(request, schema)` and its query string with `parseQuery(request, schema)` (`apps/admin/src/lib/request-input.ts`), with a zod schema whose messages say what to fix. A caller's mistake then answers 400 with the field's name, as the v1 API does, rather than the 500 and the error report a `throw new Error` gives through `asApiResponse` ([the route catalog](../reference/routes.md#mistakes-by-the-caller-that-answer-500)). Reuse a v1 schema from `packages/shared/src/publicApi/schemas.ts` where the operation is the same. Keep `throw new Error` for what is really the server's fault, and use `jsonError(message, status, code)` for a 404, a 409 or a 429.

## Type a screen from the server's own answer

A dashboard screen takes the type of what it loads from the function that builds it, rather than declaring the shape again: `type Call = Jsonified<CallListItem>` in `live-calls-surface.tsx`, where `CallListItem` comes from `@lobbystack/domain` and `Jsonified` from `@lobbystack/shared` turns each `Date` into the ISO string JSON sends. Leave a domain function's return type to be inferred from its query instead of annotating it `Record<string, unknown>`, and export a named type beside it. `apps/admin/src/lib/dashboard-contract.test-d.ts` holds the assertions that hold this together; `pnpm typecheck` checks them, no test run needed.

## Ask the domain, never a table

A dashboard route under `apps/admin/app/api` gets its data from a function in `packages/domain/src/server`, the same place the v1 API gets it, so a question has one answer and the two can't drift. An ESLint rule enforces it: `@lobbystack/db` gives a route `withBusinessTransaction`, `withDispatcherTransaction`, `enqueueOutbox`, `databaseHealthCheck` and the `DatabaseTransaction` type, and no tables. When a route already holds a transaction, write the domain function to take it first and name it `…InTransaction`, as `readBusinessHoursPageInTransaction` does, so the read runs under the business's row-level security with everything else the request does. A route test that mocks `@lobbystack/domain` should pass such a function through from the real module (`...await original<typeof import("@lobbystack/domain")>()`), so the test still checks the query the screen depends on.

The routes that haven't moved yet are listed in `routesStillQueryingTables` in `apps/admin/eslint.config.mjs`. Take one off the list when you move it; nothing goes on it.

## Change the schema in two places

The database is built by the SQL migrations in `packages/db/migrations`, and typed by the Drizzle schema in `packages/db/src/schema/index.ts`. Neither is generated from the other, so a migration that adds a column and a schema that doesn't declare it both look fine on their own, and only a query that touches the column notices (the technical audit's AUDIT-015). Write both halves in the same pull request.

`pnpm db:compare-schema` reads `pg_catalog` from a migrated database and compares it with the schema, column by column: names, types, nullability and the columns each index covers. CI's database job runs it after migrating, so a half-written change fails there rather than in production. Indexes are matched by what they cover, not by their names, because the same unique index is a named index in Drizzle and an inline `UNIQUE` constraint under a generated name in SQL; an index over an expression, such as the GIN index on `to_tsvector(title)`, lives in SQL alone and is not compared.

**Take something away one release later than you add its replacement.** A migration that drops a column or a table, or makes a column `NOT NULL`, breaks the release that is still answering requests while the deploy finishes, and takes the rollback with it. Add the replacement in one release; take the old thing away in the next. Declare the second one in `CONTRACT_MIGRATIONS` (`packages/db/src/migrations/raw-migrations.ts`) with the migration whose release has to run in between, and `migrate` refuses to apply the two together on a database that already ran migrations. A file that takes something away and is not declared fails `raw-migrations.test.ts`, so the next one can't be forgotten; declare it with `expand: null` and a sentence saying why nothing running could be using what it takes away.

**A migration that has run is history.** `packages/db/migrations/checksums.json` freezes each file's checksum, and `packages/db/src/migrations/checksums.test.ts` fails when one changes. A database that already applied the old text keeps it, and the migrator can only warn, so editing an applied migration guarantees two databases that will never agree. Add a new migration instead. After adding one, run `pnpm db:freeze-migrations` and commit the manifest with it.

## Read a setting one way

A true/false setting is read with `envFlag(env, "NAME")` from `@lobbystack/shared`, never with a comparison of your own. It accepts `true`, `false`, `1`, `0`, `yes`, `no`, `on` and `off`, in any case, and throws when the value is neither, so a mistake can't read as off. Add a new one to `booleanSettings` in `packages/shared/src/env.ts` with what it means when unset; that record is the single place the names and defaults live, and `booleanSettingErrors` checks all of them as the admin and the worker start. The deployment guide's [variables appendix](../deployment/guide/appendix-a-variables.md) lists them for operators.

Settings that are not true/false are still read where they are used (the technical audit's AUDIT-017); a typed module per service follows.

## Let one screen fail without the dashboard

There are three error boundaries, nearest first:

- `apps/admin/src/components/surface-error-boundary.tsx` wraps one panel of a screen built from parts that don't depend on each other, such as the call chart on Home and the recording player on a call. The panel is replaced by a short message with a retry; the rest of the screen carries on. A page that *is* one surface needs no wrapper, since the route boundary below already says the same thing in the same place.
- `apps/admin/app/(dashboard)/error.tsx` catches anything a dashboard screen throws. Next renders it inside `(dashboard)/layout.tsx`, so the navigation stays and the operator can go elsewhere. It shows the error's `digest`, which is what support can look up in the logs.
- `apps/admin/app/error.tsx` and `global-error.tsx` sit above that layout and replace everything. They are for a failure in the shell itself.

Every one of them reports through `captureBrowserError`, which redacts URLs, tokens and email addresses before PostHog sees them. Data errors are not what these are for: a failed request belongs to the surface's own TanStack Query state, which can say what failed and offer a retry in place (the technical audit's AUDIT-019).

## Share one Redis connection, never one per request

A long-lived Redis connection belongs to the process, not to the request that needed it first. `apps/admin/src/lib/realtime-subscriber.ts` is the pattern: one ioredis subscriber for the whole admin process, a `Map` of channel to listeners, subscribe on a channel's first listener and unsubscribe on its last, one `ping` timer for the connection rather than one per stream, and every listener told when the connection drops so each request can end cleanly. Anything that keeps a connection open for as long as a browser tab is open needs a cap too: `MAX_STREAMS_PER_USER` answers 429 rather than letting one account hold the pool. Where a browser reconnects on a timer, spread the wait (`spread` in `apps/admin/src/lib/realtime-query.ts`), so a redeploy doesn't bring every tab back in the same instant.

Tests for a module-level singleton need `vi.resetModules()` and a dynamic `await import()` per test, or one test's connection is the next one's.

## Know what trips the checks up

- **The worker's docx heap test** (`apps/worker/src/documentExtraction.process.test.ts`) can fail on a small machine. `pnpm test` runs the packages' tests side by side and stops them all at the first failure, so the admin's tests then don't finish: run them on their own with `pnpm --filter @lobbystack/admin test`, and say so in the pull request's testing notes.
- **Some browser tests never run in CI.** Specs such as the agent workflows, the demo operator and the startup performance tests skip unless the release readiness script (`scripts/release-readiness.ts`) prepares operator sessions (`PARITY_PORT_OPERATOR_STORAGE_STATE_*`), and the widget chat, password recovery, website import and demo-operator specs need their own `*_E2E=1` switches and a fake AI. Saved sessions survive between Playwright runs only when the auth, internal-service, widget, encryption and OTP secrets are pinned in the environment.
- **A new page can pass its pull request and fail the branch it merges into.** Every page under `apps/admin/app` needs a place in `docs/validation/admin-ui-parity.json`: a localized page goes in `localizedPortRoutes` and, without its locale segment, in `visualRoutes`, as `/cancel-account` does. Only the `replacement-validate` job checks this, on pushes to `main`, to release branches such as `releases/r2` (since fork PR #169) and to development branches such as `develop/r2` (since fork PR #187), and never on pull requests, so run `pnpm replacement:parity` before merging a pull request that adds a page.
- **Timing-sensitive tests flake under load.** Wait on the condition, such as `vi.getTimerCount()`, rather than on time. A test that does seconds of real work can pass on its own and still time out after Vitest's 5 seconds in CI, where the admin's and the worker's tests share the runner. Keep its input small: since fork PR #172 the worker's 25-page OCR test renders two-inch pages, not letter-size ones.
- **Trivy, CodeQL and the dependency audit** can fail a pull request on things it didn't change ([overview](../project/overview.md#make-a-change)).

## Give an inline script the nonce

The Content Security Policy sends `script-src 'self' 'unsafe-inline'`, which would not stop an injected script from running (the technical audit's AUDIT-008). Two settings replace that with a per-request nonce, in steps, because a single inline script without the nonce is a blank screen:

| `CSP_SCRIPT_NONCE` | `CSP_SCRIPT_NONCE_ENFORCED` | What a browser gets |
|---|---|---|
| unset | unset | Today's policy. Nothing extra is sent and no nonce is made. |
| `true` | unset | Nothing new is blocked. The strict policy goes out as `Content-Security-Policy-Report-Only`, so a browser names what *would* have been blocked. |
| `true` | `true` | The strict policy is enforced and the report-only header stops. |

`apps/admin/proxy.ts` makes the nonce and hands it to the page through `NONCE_HEADER` (`@/lib/locale-request`). **A component that writes its own inline `<script>` must take the nonce and set it**, as `profile-page.tsx` does for its JSON-LD block; read it with `(await headers()).get(NONCE_HEADER)`. Styles keep `'unsafe-inline'`: a style can't run code, and Tailwind writes a screen's chart colours inline.

Four things about it are not obvious. A browser found the first two, which the header tests had passed:

- **Next takes the nonce from the policy the proxy enforces.** It copies the proxy's response headers over the request's before it reads the request's policy, and it looks at the report-only header only when nothing is enforced. So in the middle step the enforced policy names the nonce without acting on it: `script-src` names it, and `script-src-elem` and `script-src-attr` follow, saying what `script-src` said before. A browser that knows those two (Chrome 75, Firefox 108, Safari 15.4) asks them about every script and every handler, and asks `script-src` only about `eval`. An older browser enforces the nonce from the middle step on. Without this the report named every script Next wrote.
- **A page built ahead of time gets no nonce and keeps today's policy.** Its HTML was written during the build, so there is no request in which Next could put a nonce on its scripts, and a shared cache may store it. Enforced on such a page, the strict policy blocks every script: a sign-in page nobody can sign in on. Those pages are the public ones under a language, such as `/en/login`, `/en/signup` and the help center (`isCanonicalPublicPath` in `@/lib/locale-path`). `pnpm admin:prerender-check`, part of `pnpm build`, fails when a page is prerendered outside that set. The widget's loader, `/embed.js`, gets no nonce either: it is a script file that caches hand to every site's visitors.
- **Next's own 404 and its last-resort error page are built ahead of time too**, and the proxy can't tell beforehand that an address will get one. Their scripts are blocked once the policy is enforced. The 404 still reads "This page could not be found.", and on the error page reloading does what its Retry button would.
- **The report says nothing about `eval`.** Every step refuses `eval`, as today's policy does, and zod asks whether it may as each page loads. Left in the report, that would be a line in every page's console.

`'strict-dynamic'` trusts a script that a running script adds. So the nonce stops injected markup (an inline `<script>`, an `onclick`, a `javascript:` link), not what a script that is already running goes on to do.

`pnpm --filter @lobbystack/admin e2e:script-nonce` runs `e2e/script-nonce.e2e.ts` against two servers of its own, one in each step. On a rendered page every script carries the request's nonce, the page still works and the policies report nothing; then injected markup runs only while the policy isn't enforced, and the report names it. `scripts/e2e-local.sh` runs it after the other journeys, so CI's `e2e` job does too.

Turn it on in reporting mode on one deployment first, look at a browser's console on the dashboard, a business's public page and the widget, then enforce ([Appendix A](../deployment/guide/appendix-a-variables.md)).

## Let PostgreSQL hold the values

A query is written with Drizzle's query builder, or as a `sql` template from `drizzle-orm` where the builder can't say it. Either way every value goes in as `${value}` and reaches PostgreSQL as a bind parameter. `sql.raw` is only for text fixed in the file, such as a column name chosen from a list the code itself holds; it never takes anything a caller supplied. An ESLint rule in the admin refuses a template literal passed straight to `.execute(`, which is how the finance export built its five queries before the technical audit's AUDIT-010: each value was quoted by a `replaceAll("'", "''")` written beside it, safe as written and one forgotten call away from an injection.

## Keep a transaction's queries in order

Never start several queries at once on one transaction, as `Promise.all` over `tx` does. A transaction is one pooled connection: `pg` queues the queries and prints a deprecation warning ("client already executing a query"), and its next major version will refuse them. Fork PR #48 removed 18 such places, and `scripts/transaction-queries.test.ts` now fails on any `Promise.all` or `Promise.allSettled` that starts two or more queries on a transaction (a parameter named `tx`, typed `DatabaseTransaction`, or the first parameter of a `*transaction(` callback). Await the queries one after the other: it costs the same round trips.

Parallel queries are fine on the pool, outside a transaction, since each gets its own connection. A test fixture that shares one transaction for everything turns them into the same problem, which is why `publicProfiles.integration.test.ts` wraps its transaction in `oneTransactionAtATime`. Take care with `runIdempotent`, which hands its transaction to idempotent v1 and MCP operations as `context.db`.

`withBusinessTransaction` runs the callback again when PostgreSQL ends the transaction itself: a deadlock (SQLSTATE 40P01) or a serialization failure (40001), three times, waiting 10, 20 and 40 ms plus up to half of each again so two deadlocked transactions don't come straight back together. Everything else is raised to the caller on the first try. Re-running is safe because the work left for other services goes through the outbox, written in the same transaction and rolled back with it; a callback that also writes outside the database, such as calling a provider's API, is not safe to re-run and belongs in a job, not in the transaction. A retried deadlock leaves no log line, so it is counted from the `db.response.status_code` attribute on the `db.transaction` span (the technical audit's AUDIT-016).

## Write integration tests that clean up

- Keep each test's rows in one transaction that rolls back, with the `rollbackTest` helper the integration test files define, so tests running in parallel don't see each other's data.
- `billingCatalog.integration.test.ts` commits catalog rows and deletes them afterwards. A rollback test that reads `billing_plans` or `billing_prices` takes `pg_advisory_xact_lock(hashtext('lobbystack.billing_catalog'))` first, as the billing catalog and code tests do since fork PR #67.

## Develop on Windows

- Line endings need no setting: `.gitattributes` checks every text file out with Linux line endings (LF), whatever Git for Windows' `core.autocrlf` says, because Postgres runs `docker/postgres/init/roles.sh` in Linux and bash fails on Windows line endings (CRLF). `scripts/line-endings.test.ts` fails if a shell script or `.env.example` would come out with CRLF. A clone made before fork PR #83 needs a `git pull`, and `docker compose down -v` if Postgres already started ([line endings on Windows](../voice/local-debugging.md#line-endings-on-windows)).
- Keep keys in `.env.local`, never in another untracked file: a `docker compose ... --build` sends the whole folder to Docker, and `.dockerignore` leaves out the `.env` files but not other files you keep there.
- Never add files with `git add -A` in a checkout that has untracked notes or scripts: add them by name.

## Update the docs

A change updates the docs in the same pull request ([keep this folder true](../README.md#keep-this-folder-true)): the feature page it changes, the [changelog](../project/changelog.md), [open items](../project/open-items.md) for anything it leaves to do after the deploy, and the [route catalog](../reference/routes.md) for a new page or route.
