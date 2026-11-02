<p align="center">
  <img src=".github/readme/lobbystack-hero.png" width="100%" alt="LobbyStack dashboard hero image">
</p>

<div align="center">

# LobbyStack

### The open-source AI receptionist for phone calls and appointments

LobbyStack is an open-source AI receptionist platform for small businesses. It answers phone calls, books appointments, handles appointment changes, and transfers calls to a person when needed.

It is built for clinics, salons, repair shops, local service companies, restaurants, and any business that loses revenue when nobody is available to answer the phone.

LobbyStack gives teams a modern AI front desk that can be hosted in the cloud or self-hosted on their own infrastructure.

[Docs](./docs/README.md) &middot; [Deploy it](./docs/deployment/guide/README.md) &middot; [Develop](./docs/development/README.md) &middot; [Changelog](./docs/project/changelog.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-111111.svg)](./LICENSE) [![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6.svg)](https://www.typescriptlang.org/) [![PostgreSQL](https://img.shields.io/badge/backend-PostgreSQL-336791.svg)](https://www.postgresql.org/) [![Self-hostable](https://img.shields.io/badge/deploy-self--hostable-7c3aed.svg)](./docs/deployment/guide/README.md)

</div>

> **This repository is a fork of LobbyStack, run as AlloPlace.** It develops on its own: the original project's repository is no longer available. The [docs](./docs/README.md) are the project's source of truth: [what the fork is](./docs/project/overview.md), [how to deploy it](./docs/deployment/guide/README.md), [what changed](./docs/project/changelog.md) and [what is still open](./docs/project/open-items.md).

## Why teams use LobbyStack

Most AI receptionist tools are closed, expensive, and difficult to adapt to real business workflows. LobbyStack is different.

- **Open source by default.** Inspect the code, self-host it, extend it, and keep control of your data.
- **Built for real phone calls.** Handle natural voice conversations, interruptions, live transfers, and messages for your team.
- **Calls and texts in one place.** Review calls, recordings, transcripts, and incoming texts from the same dashboard.
- **Scheduling built in.** Book, reschedule, and cancel appointments through Google Calendar.
- **Designed for small businesses.** Guided setup, transparent pricing, and no enterprise-only feature gatekeeping.
- **Human fallback.** Transfer calls or escalate messages when the AI should not handle something alone.

## Core features

### ☎️ AI phone receptionist

LobbyStack answers inbound calls with a natural voice agent trained on your business information. It can answer common questions, collect caller details, take messages, qualify requests, offer appointment slots, and transfer to a human when required.

### 💬 Text messages

LobbyStack saves texts sent to your business number and alerts your team. You read the thread and reply by hand from the dashboard. The AI doesn't answer texts; STOP and HELP get fixed replies.

### 📅 Appointment scheduling

LobbyStack connects to Google Calendar, checks availability, offers time slots, books appointments, and sends a confirmation text and one reminder text 24 hours before, if the caller agrees. Callers can also reschedule or cancel during a later call.

### 📚 Knowledge base

Upload business information, FAQs, services, pricing, policies, and internal notes. The AI uses this knowledge to answer accurately and consistently.

### 🧑‍💼 Human handoff

LobbyStack can transfer a live call, take a message, or notify the team by email or opt-in SMS when a person needs to respond.

### 📥 Shared inbox

Review calls, SMS threads, transcripts, recordings, appointments, and customer details from one dashboard.

### 🔌 Integrations

LobbyStack connects to Google Calendar to check availability and book appointments. It doesn't connect to other calendars or CRMs yet.

## Use cases

LobbyStack can be adapted for many local business workflows:

- Clinics and healthcare offices
- Salons, spas, and barbershops
- Auto repair shops
- Home service companies
- Restaurants
- Dental offices
- Law firms and professional services
- Property managers
- Any business that receives appointment, pricing, hours, or availability questions by phone

## Product areas

| Area | What it gives you |
| --- | --- |
| Voice reception | Inbound phone and browser calls answered by OpenAI GPT-Live, with Twilio phone numbers. |
| Business knowledge | Answers from structured business facts, text entries, documents, and imported website pages. |
| Booking | Service-aware scheduling with availability checks and calendar handoff. |
| Appointment changes | Safer cancellation and rescheduling flows with appointment lookup and verification. |
| Human handoff | Live transfer and follow-up tasks for calls that need staff attention. |
| Messages | Incoming texts with manual replies, connected to customer history. |
| Website widget | Embeddable chat, lead capture, and browser calls with per-site access controls. Restricted: new widget keys are off unless you set `WIDGET_KEY_ISSUANCE_ENABLED=true`. |
| Dashboard | Calls, messages, contacts, appointments, recordings, transcripts, follow-ups, and analytics together. |
| Usage and billing | Plans from a file per brand, billed through Polar: voice minutes, alert SMS, transfer attempts, website chats, storage, promo codes, and spending caps. |
| Bring your own API keys | Self-hosted deployments can use your own Twilio, OpenAI-compatible AI, calendar, email, analytics, and billing provider credentials. |

## Technology

| Layer | Main components |
| --- | --- |
| App | Next.js, React, Tailwind CSS, shadcn/ui |
| Backend | PostgreSQL, Drizzle ORM, Redis, BullMQ |
| Voice | OpenAI GPT-Live over SIP and WebRTC, Twilio Elastic SIP Trunking |
| Agent | Vercel AI SDK, `gpt-6-luna` or any OpenAI-compatible model |

## Cloud or self-hosted

A deployment runs in one of two modes, set by `DEPLOYMENT_MODE`:

- **Cloud** (`cloud`): businesses sign up, pick a plan and pay through Polar, by the plans in the brand's `billing.json`. AlloPlace runs this way. Each business still controls its receptionist's behavior, knowledge, services, rules, numbers, integrations, and team workflow from the app.
- **Self-hosted** (`self_hosted_standard`, Docker Compose's default): your team runs the stack on its own infrastructure, with its own PostgreSQL, Twilio, OpenAI-compatible AI, calendar, analytics, and email provider accounts, and every business gets the self-hosted plan, with no billing.

To deploy on Railway, or with Docker Compose on one server, follow the [deployment guide](./docs/deployment/guide/README.md): it covers every variable, the phone path, email, billing, and the first run, and [part 0](./docs/deployment/guide/part-0-start-here.md) helps you pick a path. The fork doesn't use Railway's hosted template, which was made for the original project's repository.

Same open-source core either way.

## Architecture for contributors

LobbyStack is a TypeScript monorepo with PostgreSQL as the durable source of truth. OpenAI hosts call audio; the admin app starts each call and the worker runs it.

```text
apps/
  admin/           Next.js dashboard and HTTP API
  worker/          asynchronous jobs, outbox dispatch, and live calls
packages/embed/    Vite bundle for the embeddable website widget loader
packages/          database, domain, agent core, jobs, providers, telemetry, and shared contracts
brands/            each deployment's name, logo, colour, outside links, and plans
docs/              the project's documentation and source of truth
mintlify/          the original project's help pages, which the fork doesn't publish
```

The [code map](./docs/project/overview.md#find-your-way-around-the-code) says what each package holds, and the [architecture overview](./docs/architecture/overview.md) how they fit together.

## Get started

### Set up a business

1. Sign up on your deployment's dashboard.
2. Verify your mobile number.
3. Import website knowledge, or skip and add knowledge manually later.
4. Choose a plan, on a cloud deployment.
5. Claim a business number on Starter or Pro.
6. Configure AI settings, services, knowledge, and rules before sending live calls.

[Part 6 of the deployment guide](./docs/deployment/guide/part-6-first-run.md) walks through the first account and business.

### Run local development

```bash
pnpm install
pnpm env:generate
docker compose up -d postgres redis
pnpm db:migrate
pnpm --filter @lobbystack/telemetry build
pnpm dev
```

`pnpm env:generate` writes `.env` from `.env.example` with new random secrets. The admin loads `@lobbystack/telemetry` from its build output, so build it again after you pull changes to `packages/telemetry`.

Open the dashboard at `http://localhost:13000`. Use `localhost`, not `127.0.0.1`. From any other address, sign-in says "Incorrect email or password" and the admin logs `Invalid origin`.

Local development stores recordings and uploads under `.lobbystack/storage`. Set `STORAGE_PROVIDER=s3` when you need to test an S3-compatible service.

Mock providers are part of the default development path, so contributors can exercise flows without live Twilio, AI, calendar, or email credentials. [Part 2 of the deployment guide](./docs/deployment/guide/part-2-local-development.md) is a step-by-step local setup, and [part 3](./docs/deployment/guide/part-3-outside-services.md) sets up each provider.

### Deploy with Docker Compose

```bash
git clone https://github.com/devresponse/lobbystack.git
cd lobbystack
node scripts/generate-env.mjs
# Set APP_BASE_URL, OPENAI_API_KEY, and your Twilio credentials in .env.
docker compose --env-file .env up -d --build
```

The stack uses stdout logs and health endpoints without running monitoring containers. Set `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_HEADERS` to send server telemetry to PostHog or another OTLP-compatible backend.

For prerequisites, going live, helper scripts, and troubleshooting, see [production with Docker Compose](./docs/deployment/guide/part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose) in the deployment guide.

## Contributing

Contributions are welcome. Start with [CONTRIBUTING.md](./CONTRIBUTING.md) and [develop and test](./docs/development/README.md), keep durable business logic in the domain and database layers, and put the receptionist's tools in the agent core. A pull request updates the docs it changes.

Before opening a PR, run:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

## License

LobbyStack is licensed under the [MIT License](./LICENSE).
