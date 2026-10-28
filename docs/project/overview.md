# Understand the project

This repository, `github.com/devresponse/lobbystack`, is a fork of LobbyStack, the open-source AI receptionist. It answers phone calls, website chats and calls for small businesses, books appointments in Google Calendar, takes messages and hands callers to a person. The fork runs it as AlloPlace and adds the features, billing and fixes listed in the [changelog](changelog.md).

Checked against `main` at `da1f548` (fork PR #76), 2026-10-24.

## Know what the fork is

- The original project's repository was unavailable from 2026-10-18 and is back since 2026-10-27. The fork still develops on its own: pull requests go into the fork's `main`, and nothing is sent back to the original.
- The fork's `main` was reset to the original's history at its PR #301 (`380d9e0`, 2026-10-11). Everything after that commit is the fork's own work. [History](history.md) covers what came before.
- On 2026-10-27 the original was 25 commits past `380d9e0`, the fork had 285 commits the original lacks, and a trial merge conflicted in 326 files, so the weekly sync check stays paused. Fork PR #90 brought over the original's Node.js 26.12.1 images and its nodemailer 10.1.4 and zod 4.6.6 updates by hand; whether to bring over the rest the same way, or merge, is [open](open-items.md#decide-these).
- The code still calls itself LobbyStack: the package names (`@lobbystack/*`), the `lobbystack` command, its `LOBBYSTACK_*` variables and the database roles. What a visitor sees comes from a brand: each deployment shows the name, logo, colour and outside links of a folder under `brands/` ([branding](../branding.md)). AlloPlace is the brand for alloplace.com and alloplace.ai, and, as the only brand besides LobbyStack, for any address no brand claims, such as `localhost`.

## Know where it runs

| Deployment | What it is | Payments |
| --- | --- | --- |
| Demo, `demo.alloplace.com` | The maintainer's instance on Railway: an admin service and a worker service, with Railway's Postgres, Redis and a storage bucket. It deploys from the fork's branches (below), and gets the AlloPlace brand from its domain. | Polar sandbox: test cards, no real money. |
| Live payments | A separate deployment, not set up yet. The maintainer will provide it. | Polar's live organization. |
| Your own | Docker Compose on one server, or Railway built from this repository. The [deployment guide](../deployment/guide/README.md) covers both. | Only with `DEPLOYMENT_MODE=cloud`. |

`DEPLOYMENT_MODE` decides who pays:

- `cloud` bills each business through Polar, by the plans in its brand's `billing.json` ([billing](../billing/README.md)).
- `self_hosted_standard`, Docker Compose's default since fork PR #47, gives every business the self-hosted plan, with no billing.
- `development` is for local work.

To see which commit a deployment runs, read the line "version: &lt;commit&gt;" under the account menu at the bottom of the dashboard's sidebar (fork PR #57). It shows the first 7 characters of the deployed commit, from `RAILWAY_GIT_COMMIT_SHA` on Railway or `SERVICE_VERSION` elsewhere. If it doesn't match the commit you merged, the deploy didn't happen.

## Follow the branches

| Branch | Role |
| --- | --- |
| `main` | The default branch. Every pull request merges here. |
| `alloplace/r1` | Kept identical to `main`, fast-forward only. The demo deploys from one of the two, most likely this one, so both move together: push `alloplace/r1` first, then `main`. |
| Feature branches | One per pull request, such as `claude/<topic>-<id>` or `alloplace/<topic>`. |

The old `production` branch was rewritten on 2026-10-09 and deleted on 2026-10-11, with every other branch but `main` ([history](history.md#the-forks-first-weeks)).

## Make a change

1. Branch from `main` and open a pull request into `main`. Use the template's Summary, Testing and Docs sections.
2. Update the docs in the same pull request: `docs/` is the project's source of truth ([how this folder works](../README.md#keep-this-folder-true)).
3. CI runs on every pull request and every push to `main`: checks, database, end-to-end, Zapier, images and CodeQL, about 10 minutes. A new push cancels the running one. Pushes to `main` also run the replacement validation, 13 to 20 minutes. Pushes to `alloplace/r1` run nothing.
4. Merge only when CI is green. The maintainer merges, or says when to. The merge is a merge commit, "Merge pull request #N from devresponse/&lt;branch&gt;", pushed to `alloplace/r1` and then `main`.
5. After the deploy, check the version line, then do any steps the pull request lists for after the deploy. The open ones are in [open items](open-items.md).

[Development](../development/README.md) has the checks to run before you push, and what trips them up.

Two CI checks fail a pull request on things it didn't change:

- Trivy fails it on any critical advisory in an image, even one published that day. Bump the package.
- CodeQL fails it on any new high alert. Keep backtracking regular expressions, such as `/\/+$/`, away from request values.

If GitHub never starts a pull request's CI because it never works out whether the pull request can merge, dispatch the `replacement-platform.yml` workflow on the branch with the target `replacement-validate`. It runs `main`'s validation on the branch in about 20 minutes, without staging secrets or image pushes. Merging on that run instead of the pull request's own CI needs the maintainer's word each time.

## Find your way around the code

| Path                                                           | What it holds                                                                                                                                                                                                |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/admin/`                                                  | The Next.js dashboard, sign-in, the HTTP API (dashboard routes, `/api/v1`, MCP), webhooks, the website widget's API, its loader `/embed.js` and its iframe app `/embed/<key>`, and the public profile pages. |
| `apps/worker/`                                                 | Queued jobs, the transactional outbox, and every GPT-Live call: the admin hands it each call at `/internal/live/attach`.                                                                                     |
| `apps/landing/`                                                | The original project's marketing site, in Astro. The fork doesn't deploy it ([sites](../deployment/guide/appendix-f-sites.md)).                                                                              |
| `packages/db/`                                                 | Drizzle schema, the SQL migrations (`packages/db/migrations/`), database roles and row-level security.                                                                                                       |
| `packages/domain/`                                             | Business logic that the admin and the worker share.                                                                                                                                                          |
| `packages/agent-core/`                                         | The receptionist agent that website chat and calls share, its tools, and the GPT-Live call controller.                                                                                                       |
| `packages/providers/`                                          | Adapters for Twilio, OpenAI-compatible AI, embeddings, Google Calendar, email, storage, Polar and Firecrawl.                                                                                                 |
| `packages/shared/`                                             | Types, billing rules, brand resolution and the v1 API's operation registry (`packages/shared/src/publicApi/operations.ts`).                                                                                  |
| `packages/cli/`                                                | The `lobbystack` command, which works only through the v1 API.                                                                                                                                               |
| `packages/embed/`, `packages/web-voice/`                       | The widget loader bundle, and the browser call hook and orb.                                                                                                                                                 |
| `packages/contracts/`, `packages/jobs/`, `packages/telemetry/` | Job and snapshot contracts, BullMQ queues, and telemetry with redaction.                                                                                                                                     |
| `brands/`                                                      | One folder per brand: `brand.json`, images and `billing.json`. Public, like the rest of the repository.                                                                                                      |
| `integrations/zapier/`                                         | The Zapier app.                                                                                                                                                                                              |
| `scripts/`                                                     | Setup, `pnpm billing`, the `replacement:*` checks and operations scripts.                                                                                                                                    |
| `docker/`, `docker-compose.yml`, `Dockerfile.*`                | The Compose stack and the images Railway builds.                                                                                                                                                             |
| `mintlify/`                                                    | The original project's Help Center pages. Not maintained by the fork; this folder is the fork's documentation.                                                                                               |
| `research/`                                                    | The original project's marketing research.                                                                                                                                                                   |
| `.railway/`                                                    | The original project's Railway definition. The fork's deployments don't use it.                                                                                                                              |

[Architecture](../architecture/overview.md) explains how the parts talk to each other, and the [route catalog](../reference/routes.md) lists every page and HTTP route with the file that handles it.

## Keep public things public

The repository is public. Keys, tokens, webhook secrets, passwords, Polar product IDs, phone numbers and customer data stay in environment variables and the deployment's database, never in a commit. When you work in a checkout that has untracked files, such as local scripts or notes, add files by name: never `git add -A`.
