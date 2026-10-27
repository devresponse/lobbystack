# Find your way around the docs

This folder is the project's source of truth: what the fork is and how it got here, how to deploy, run and change it, how each feature works, what was decided and why, and what is still open. Pages that describe code say which commit of `main` they were checked against. When a page and the code disagree, fix the page in the same pull request as the code, or in the next one.

## Start here

- [Understand the project](project/overview.md): what the fork is, where it runs, its branches, how a change reaches `main`, and where things are in the code.
- [Deploy it from GitHub](deployment/guide/README.md): the step-by-step guide, from accounts to the first business.
- [Develop and test](development/README.md): set up a checkout and run the checks a pull request needs.
- [Track the open items](project/open-items.md): steps to take after deploys, things to test, decisions to make, work not started.
- [Find the future features](roadmap/README.md): what research proposed and nobody has built yet, one page each, with the plan, the effort and the decisions it waits on.

## Know the project

| Page | What it holds |
| --- | --- |
| [Overview](project/overview.md) | The fork, the demo, the branches, making a change, a map of the code, what stays out of a public repository |
| [History](project/history.md) | The original project from March to October 2026, and the fork since |
| [Changelog](project/changelog.md) | Every pull request merged into the fork's `main`, newest first |
| [Decisions](project/decisions.md) | The maintainer's decisions, and the architecture decisions (ADRs) |
| [Open items](project/open-items.md) | What is waiting, and on whom |
| [Future features](roadmap/README.md) | Sign-in with Google and Microsoft, intake forms, custom voices, each business's own provider keys and the rest of what was researched, each with its plan, effort and status |

## Deploy and run it

| Page | What it holds |
| --- | --- |
| [Deployment guide](deployment/guide/README.md) | Parts 0 to 8, from preparing accounts to troubleshooting, and appendices with every variable, command, checklist and outside site |
| [Run the platform](platform.md) | The local stack in Docker, health checks, certification, backups |
| [Run and debug on your desktop](voice/local-debugging.md) | Docker, VS Code and a tunnel for real calls and texts |
| [Brand a deployment](branding.md) | The name, logo, colour and outside links each deployment shows |
| [Polar](providers/polar.md) and [email](providers/resend.md) | Setting up payments and email |
| [Alerts](operations/alerts.md), [backup and restore](operations/backup-restore.md), [error tracking alerts](telemetry/provider-failure-error-tracking.md) | Runbooks for a running deployment |
| [Railway infrastructure as code](deployment/railway.md) | The original project's `.railway/railway.ts`; the fork deploys by the guide instead |

## Understand the features

| Page | What it covers |
| --- | --- |
| [Phone and browser calls](features/calls.md) | GPT-Live, the recorded greeting, the time limit, AI traces |
| [Caller authentication](features/caller-authentication.md) | The four ways to verify a caller before an appointment change, including keypad PINs |
| [Phone numbers](features/phone-numbers.md) | Picking or claiming a business's Twilio number, and debugging a failed pick |
| [Text messages](features/sms.md) | Texts in and out: hand replies, consent, alerts and who they come from |
| [Email](features/email.md) | Every email the worker sends, and its layout |
| [Website widget](features/website-widget.md) | Chat, browser calls and live chat on a business's website |
| [Public page and QR code](features/public-profile-and-qr.md) | `/profile/<slug>` and the printable QR code |
| [Time zones and calendars](features/timezone-and-calendar.md) | A business's time zone and Google Calendar, and what each symptom means |
| [Many businesses on one deployment](features/multitenancy.md) | What each business has to itself and what the deployment shares |
| [API, CLI and integrations](features/api-cli-integrations.md) | The v1 API, MCP server, CLI, webhooks, Zapier and n8n |
| [Logs, errors and alerts](features/observability.md) | Logs, PostHog, following one call, and what to alert on |
| [Billing](billing/README.md), [its data](billing/data-model.md) and [its design history](billing/design-history.md) | Plans, usage, Polar, promo codes, and why it is built this way |
| [Sign-in email addresses](auth-email-normalization.md) | How addresses are compared |

## Understand the architecture

- [Platform architecture](architecture/overview.md), [the voice runtime](voice/runtime.md) and [knowledge](knowledge/architecture.md).
- [Telemetry](telemetry/architecture.md): its [events](telemetry/event-taxonomy.md), [KPIs](telemetry/kpi-spec.md) and [data quality checks](telemetry/data-quality-checklist.md).
- [Test a voice change](voice/testing.md) with `pnpm voice:eval` and `pnpm voice:call`.
- The architecture decisions, [ADR 0001](adr/0001-monorepo.md) to [ADR 0009](adr/0009-ai-conversation-traces.md), listed in [decisions](project/decisions.md#read-the-architecture-decisions).

## Look things up

- [Route catalog](reference/routes.md): every page and HTTP route, its file and who can reach it.
- [API gaps](reference/api-gaps.md): what the dashboard can do that the v1 API can't yet.
- [Environment variables](deployment/guide/appendix-a-variables.md) and [commands](deployment/guide/appendix-b-commands.md).
- [The admin API's conventions](validation/api-contracts.md).

## Read the reviews and research

- [Reviews](reviews/README.md): the phone call path, the website widget and how far it scales, the whole codebase, what limits scale, and billing, each with what has happened since.
- [Research](research/README.md): voice platforms, an Azure port, Cloudflare, Railway automation, observability, sign-in with Google and Microsoft, forms filled from calls, a cloned voice and each business's own provider keys, plus the voice agent market, a QR place guide and the brand name.
- [Future features](roadmap/README.md): what the reviews and research proposed and isn't built, kept current where the studies keep their dates.

## Read the original project's records

The original project wrote these before the fork, while it moved from Convex to this stack and readied it for production in September and early October 2026. They keep their evidence as it was and aren't kept up to date; each says so at the top. Some still describe tooling the repository runs.

- Certification: the [runbook](validation/certification-runbook.md), [PostHog and OpenTelemetry checks](validation/posthog-otel-validation.md), [production readiness](validation/production-readiness.md) and the [soak tooling](operations/soak-certification.md).
- Reports: the [Next.js audit](validation/nextjs-mcp-audit-2026-09-11.md), [performance](validation/performance-optimization.md), [query plans](validation/query-plan-remediation.md), [voice answers from knowledge](validation/voice-knowledge.md), [readiness on 09-12](validation/readiness-implementation-2026-09-12.md) and [09-13](validation/readiness-progress-2026-09-13.md), the [staging release](validation/staging-release-2026-09-11.md) and the [staging repairs](deployment/staging-environment-report-2026-09-08.md).
- Plans: [provider events](operations/provider-ingress-plan.md) and the [reliability rollout](operations/remediation-rollout.md).
- The original's landing site on [Cloudflare Pages](deployment/landing-cloudflare-pages.md), which the fork doesn't publish.

The `*.json` files in `validation/` are inputs to the parity scripts and browser tests, not documents.

## Keep this folder true

- **Update the docs in the pull request that changes the code:** the feature page it changes, a row in the [changelog](project/changelog.md), [open items](project/open-items.md) for anything left to do after the deploy, the [deployment guide](deployment/guide/README.md) for a new variable or step, the [route catalog](reference/routes.md) for a new page or route, and [decisions](project/decisions.md) for a new decision.
- **Say what you checked.** A page that describes code names the commit of `main` it was checked against; update it when you check the page again.
- **Give each proposed feature a roadmap page.** Research or a review that proposes a feature adds a page to the [roadmap](roadmap/README.md); the pull request that builds it describes the feature on its features page and removes the roadmap page.
- **Keep dated records as they were.** Reviews, research and the original project's records keep what they found on their date, with a note on what has happened since. Fix a wrong fact, but don't rewrite history.
- **Keep it public.** The repository is public: no secrets, keys, personal names, emails or phone numbers, no customer or demo business data, and no links to private documents ([what stays out](project/overview.md#keep-public-things-public)).
- **Don't link to the original project's sites.** Name them in words, such as "the original project's documentation".
- **Keep the paths code points to.** Code and scripts name `branding.md`, `deployment/railway.md`, `operations/alerts.md`, `operations/backup-restore.md`, `telemetry/provider-failure-error-tracking.md`, `validation/certification-runbook.md`, `validation/posthog-otel-validation.md`, `validation/production-readiness.md`, `voice/runtime.md`, `voice/testing.md` and the `validation/*.json` files, and `pnpm replacement:drift` fails when some of them are missing. Move one only with the code that names it.
- **Write for someone who wasn't there.** Lead with what is true now, use the screens' and commands' own words, and link to the page that explains something rather than repeating it.

`mintlify/` and `apps/landing/` hold the original project's help pages and website, which the fork doesn't publish. `pnpm api:openapi` still writes the API reference's OpenAPI file into `mintlify/`.
