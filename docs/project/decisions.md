# Know the decisions

The maintainer's decisions about the fork, newest first, with where each is carried out. A decision stands until the maintainer changes it; to change one, say so in the pull request that changes it and update this page. Architecture decisions inherited from the original project are its [ADRs](#read-the-architecture-decisions), and billing's design choices are in [billing design](../billing/design-history.md#know-the-decisions).

## Run the project

| Since | Decision | Where |
| --- | --- | --- |
| 2026-10-27 | Every feature the research proposed and nobody has built gets a page in `docs/roadmap/`, with its plan, effort and the decisions it waits on, while the study keeps its findings as of its date. | [Roadmap](../roadmap/README.md) |
| 2026-10-24 | `docs/` is the project's source of truth. A change updates the docs in the same pull request, and the business research is published with the rest. | [This folder](../README.md#keep-this-folder-true), [research](../research/README.md) |
| 2026-10-23 | The weekly check for new commits in the original stays paused. Bringing in its 14 newer commits would conflict in 286 files, so it would be a project of its own. | [Overview](overview.md#know-what-the-fork-is) |
| 2026-10-18 | The original's repository is no longer available, so pull requests go only into the fork's `main` and nothing is sent back. | [Overview](overview.md#know-what-the-fork-is) |
| 2026-10-13 | `main` and `alloplace/r1` stay identical, fast-forward only. Pushing either, and merging, happen only on the maintainer's word, once CI is green. Merging on a dispatched validation run instead of a pull request's own CI needs the maintainer's word each time. | [Overview](overview.md#follow-the-branches) |
| 2026-10-15 | Improvements ship as one pull request per item, and a fix set as one pull request per fix, most severe first. | [Changelog](changelog.md) |
| 2026-10-06 | Nothing from the fork's earlier knowledge-retrieval work is ported: the original already covered it. `main` follows the original's history from then on. | [History](history.md#the-forks-first-weeks) |

## Choose what to build

| Since | Decision | Where |
| --- | --- | --- |
| 2026-10-27 | Where neither the address nor `BRAND_PRESET` picks a brand, the only brand under `brands/` besides LobbyStack is used, so onboarding doesn't ask for a name and logo while AlloPlace is in the code. LobbyStack, and the onboarding step, stay for a copy with no brand of its own, or with several and none picked. | Fork PR #87, [branding](../branding.md#how-a-deployment-picks-its-brand) |
| 2026-10-26 | The email after each call: off for each person until they turn it on; sent to owners and admins by default, or to everyone on the team or nobody, as the business chooses; the summary and a link by default, or the whole conversation; on every plan, Free included; after every call the caller spoke on, test calls included; card and ID numbers taken out of the emails only; replies go to the owner; no copies for callers or website visitors. Calls say they're with an AI and recorded and transcribed, on for every business with a switch to turn it off. | Fork PR #84, [email](../features/email.md#email-the-team-after-each-call), [calls](../features/calls.md#tell-callers-theyre-speaking-with-an-ai-and-the-call-is-recorded) |
| 2026-10-23 | All five fixes from billing's second pass: lost work re-queued, a Polar customer per business, a monthly meter on yearly plans, separate tokens with hourly limits, and the edge cases. | Fork PRs #71 to #75, [billing design](../billing/design-history.md#make-a-second-pass-2026-10-23) |
| 2026-10-23 | Billing review's five decisions: the spending cap refuses only usage that itself passes it, never chats; monthly overage without Polar Credits; one use of a promo code per business; 20 code tries an hour per key; a plan allows 0 or 1 business numbers. | Fork PRs #68 to #70, [billing design](../billing/design-history.md#review-the-billing-code-2026-10-23) |
| 2026-10-21 | The demo stays on Polar's sandbox. Live payments get a deployment of their own, which the maintainer will provide, and each deployment keeps one Polar organization. | [Billing](../billing/README.md), decision D28 |
| 2026-10-20 | Plans live in a file in the repository, `brands/<brand>/billing.json`, applied to the database and Polar by `pnpm billing`, with promo plans and codes by operator on top. Every step design's defaults were accepted. | [Billing design](../billing/design-history.md#weigh-the-options) |
| 2026-10-18 | Fix 25 of the codebase review's 32 issues; leave 15, 16, 19, 20, 21, 23 and 27. | Fork PR #42, [codebase review](../reviews/codebase-2026-10-18.md) |
| 2026-10-18 | The recorded greeting plays on the demo (`LIVE_RECORDED_GREETING=true`). | Fork PR #45, [calls](../features/calls.md) |
| 2026-10-17 | A deployment's name, logo, colour and outside links come from a folder under `brands/`, picked by its address. AlloPlace is the brand for alloplace.com and alloplace.ai, with terms and privacy pages there. | Fork PRs #38 to #40, [branding](../branding.md), [brand names](../research/brand-names.md) |
| 2026-10-14 | Railway's hosted template isn't used to deploy the fork. | [Railway automation](../research/railway-automation.md), [deployment guide](../deployment/guide/README.md) |
| 2026-10-09 | Tag every log line, error, span and job with its call. | Fork PR #41, [observability](../features/observability.md) |
| 2026-10-07 | If the phone path is ever ported to Azure in C#, its voice is Azure OpenAI's Realtime API over SIP, with PostgreSQL kept. Nothing is built, and a day later GPT-Live proved the better buy; the choice hasn't been revisited. | [Azure port](../research/azure-port.md), [voice platforms](../research/voice-platforms.md) |

What is still waiting for a decision is in [open items](open-items.md#decide-these).

## Read the architecture decisions

The original project recorded these; they still describe the code.

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](../adr/0001-monorepo.md) | One pnpm monorepo | Accepted |
| [0002](../adr/0002-application-backend-boundary.md) | Business state behind the application backend | Amended by 0007 |
| [0003](../adr/0003-separate-voice-gateway.md) | A separate voice gateway | Superseded by 0008 |
| [0004](../adr/0004-snapshot-based-voice-personalization.md) | Each call starts from one business snapshot | Accepted |
| [0005](../adr/0005-structured-facts-over-rag.md) | Structured facts stay authoritative; retrieval only supports them | Accepted |
| [0006](../adr/0006-internal-telemetry-abstraction.md) | Feature code emits typed internal events, never vendor SDK calls | Accepted |
| [0007](../adr/0007-postgresql-main-backend.md) | PostgreSQL as the main backend | Accepted |
| [0008](../adr/0008-gpt-live-voice.md) | GPT-Live answers phone and browser calls, with one agent core | Accepted |
| [0009](../adr/0009-ai-conversation-traces.md) | A trace of each AI turn kept in Postgres, not in logs or analytics | Accepted, 2026-10-19 (the fork's) |
