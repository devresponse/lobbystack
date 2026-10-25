# Part 0. Start here

**Status:** written on 2026-10-19, from the rest of this guide and the code on `main` at `d18f916`.

## 0.1 Who this guide is for

LobbyStack is an AI receptionist for businesses. For each business it serves, it:

- answers the business's phone calls, the chat on its website and on its public page, and calls made from a web browser;
- answers questions from what the business has taught it, books appointments, and takes messages for the team;
- texts phone callers a confirmation and a reminder of their booking, if they agree;
- gives the business's team a dashboard with its calls, messages, appointments and contacts, where they also answer texts.

One installation, which this guide calls an **instance**, serves any number of businesses. Each has its own team and data, and the database itself keeps them apart. Anyone who signs up can create up to 10 businesses, and no administrator sits above them all ([6.1](part-6-first-run.md#61-create-your-account), [7.19](part-7-operations.md#719-manage-operators-api-keys-and-platform-keys)). The dashboard is in English, French, Spanish and Serbian. Calls start in English or French, and the receptionist switches when a caller asks for another language or clearly speaks one, then keeps that language for the rest of the call ([8.10](part-8-troubleshooting.md#810-language)).

LobbyStack is open-source, under the MIT license (`LICENSE`), so anyone may run it. This guide builds it from its code on GitHub ([1.4](part-1-prepare.md#14-get-the-code)).

**What you'll have at the end**

- A test environment on Railway, where every new version is tried first ([Part 4](part-4-test-environment.md)).
- A production environment for real businesses, on Railway or on a server you rent, checked against a go-live list ([Part 5](part-5-production.md)).
- Your first business answering its calls and chats ([Part 6](part-6-first-run.md)).
- The procedures to release new versions, and to back up, watch, secure and repair the instance (Parts 7 and 8).
- If you want it, LobbyStack on your own computer, to learn it or to change its code ([Part 2](part-2-local-development.md)).

**What it asks of you**

- No programming. You copy commands into a terminal, click through the providers' dashboards, and paste blocks of settings.
- A password manager, and care with what it holds ([1.2](part-1-prepare.md#12-your-worksheet-and-keeping-secrets-safe)).
- A card for the providers' bills ([0.7](#07-time-and-money)), and your business's details for Twilio's checks ([3.3](part-3-outside-services.md#33-twilio)).
- Time: some providers review you for days before every feature works ([0.7](#07-time-and-money)).

**How far it's been tested**

[Part 2](part-2-local-development.md) was tested on a clean computer. Everything else was written from the code and the providers' documentation, and checked against both, but hasn't been run with real accounts yet. Each part's status says exactly what was tried. Where a screen differs from this guide, follow the screen, and tell whoever looks after the guide.

## 0.2 Pick your path

| I want to | Do these |
| --- | --- |
| Try LobbyStack on my computer | [Part 2](part-2-local-development.md) |
| Change the code and test my change | [Part 2](part-2-local-development.md), Way A, then [2.8](part-2-local-development.md#28-run-the-checks-before-you-ship-a-change) |
| Run an online test copy | Parts 1, 3 and 4, then [Part 6](part-6-first-run.md) on it |
| Run it for real businesses | All of the above, then [Part 5](part-5-production.md), and [Part 6](part-6-first-run.md) again on production |
| Run it for a client, in their name | The same, after reading [5.5](part-5-production.md#55-hand-an-instance-over-to-a-client), before you build production |
| Keep an instance running and safe | [Part 7](part-7-operations.md), with its calendar in [7.25](part-7-operations.md#725-routine-maintenance-calendar) |
| Fix something that broke | [Part 8](part-8-troubleshooting.md), which starts with a table of what you see. When nothing answers at all, [7.14](part-7-operations.md#714-incident-basics-who-acts-what-to-check-first-how-to-tell-users) |
| Look up a setting, a command, a checklist or a value | Appendices A to D |

Releasing a new version needs Git, a copy of the code on your computer, and a GitHub sign-in there, even if you skip the rest of [Part 2](part-2-local-development.md) ([1.4](part-1-prepare.md#14-get-the-code), step 8; [2.2](part-2-local-development.md#22-install-the-tools), [2.3](part-2-local-development.md#23-get-the-code-and-create-your-settings-file); [7.1](part-7-operations.md#71-release-a-new-version), step 6). The command line ([6.7](part-6-first-run.md#67-optional-the-api-and-the-command-line)) needs Node.js and pnpm as well ([2.2](part-2-local-development.md#22-install-the-tools)).

## 0.3 How LobbyStack fits together

Five programs, called **services**, make up an instance:

| Service | What it does |
| --- | --- |
| **admin** | The dashboard, sign-in, the API, the website chat and the public pages. It's the only service with a public address, so it also receives what OpenAI and Twilio send: each new call, and each text that comes in |
| **worker** | The work in the background: emails, texts, calendar updates, website imports, and each call for as long as it lasts |
| **migrate** | Creates and updates the database's tables, then stops. On a server, it's called `migrator` |
| **PostgreSQL** | The database, with every business's data. Each service signs in as a role that reaches only what it needs, and the database keeps each business's data apart from the others' |
| **Redis** | Queues, rate limits, and the dashboard's live updates |

Recordings and uploaded files go to a **bucket**, which Railway shows as a sixth service ([4.1](part-4-test-environment.md#41-how-the-railway-project-is-laid-out)). On your own server, they stay on its disk, and a sixth program, Caddy, gets the HTTPS certificate ([5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose)).

Outside **providers** do the rest. OpenAI talks and writes: calls, the chat's answers and knowledge search. Twilio connects the phone network: numbers, calls and texts. An email service sends the emails, and Cloudflare Turnstile keeps robots from signing up. Others are optional ([3.7](part-3-outside-services.md#37-optional-services)).

**How a phone call travels**

1. A caller dials a business's number, which LobbyStack bought at Twilio ([6.4](part-6-first-run.md#64-get-a-phone-number-and-make-the-first-calls)).
2. Twilio passes the call through the **SIP trunk** ([3.3](part-3-outside-services.md#33-twilio)) to OpenAI, whose voice model, GPT-Live, talks with the caller.
3. OpenAI asks the admin whether to answer it, at `/api/webhooks/openai/live`. The admin finds the business, accepts the call with the business's greeting and facts, and hands it to the worker over the private network.
4. The worker stays with the call until it ends. When the caller wants something that needs the business's data, such as a free time or a booking, GPT-Live asks the worker, which answers from the database.
5. When the call ends, the worker saves it, and it appears under the business's **Calls**.

So what a caller hears tells you which part failed ([7.15](part-7-operations.md#715-calls-not-answered-or-dropping)).

- **A call from the browser** works the same way, without Twilio: the admin starts it, and the browser talks to OpenAI directly.
- **The website chat** goes to the admin, which answers with the same receptionist, through OpenAI's text model.
- **A text** to a business's number goes from Twilio to the admin, and appears in **Messages**. The receptionist doesn't answer texts; the team does ([6.4](part-6-first-run.md#64-get-a-phone-number-and-make-the-first-calls)).
- **Emails and outgoing texts** are sent by the worker.

The marketing site (`apps/landing`) and the docs site (`mintlify/`) are in the same code, but an instance needs neither ([Appendix F](appendix-f-sites.md)).

## 0.4 Ways to deploy

Every way builds the admin, the worker and migrate from the code itself. No ready-made images are published: the project's checks build them only to test them (`.github/workflows/runtime-images.yml`).

| Way | Runs on | What it takes | Use it for | In this guide |
| --- | --- | --- | --- | --- |
| From the code, Way A | Your computer | A few commands | Learning LobbyStack, and changing its code | [2.4](part-2-local-development.md#24-way-a-run-from-source), tested on 2026-10-18 |
| Docker Compose, Way B | Your computer | One command | Checking a change the way a server runs it | [2.5](part-2-local-development.md#25-way-b-run-everything-in-docker), untested |
| Railway, set up from the fork in its dashboard | Railway | Many clicks, and five blocks of settings to paste | The test environment, and production: this guide's main path | [Part 4](part-4-test-environment.md) and [5.2](part-5-production.md#52-production-on-railway), not yet run |
| Docker Compose on one rented server | A Linux server | One settings file, two files of your own and one command, and then you look after the server | Production at the lowest monthly cost | [5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose), not yet run |
| Railway, from a definition and a script kept in the fork | Railway | About six values for each instance | Setting up many instances | Not built ([4.11](part-4-test-environment.md#411-later-set-it-all-up-with-one-command)) |
| The LobbyStack template hosted on Railway | Railway | The fewest clicks | Not used | Ruled out; its definition also points at the original repository, which is no longer available (`.railway/template.ts:14`) |
| Other platforms, such as Render, Fly.io or Kubernetes | Elsewhere | A setup of your own | Not covered | Nothing for them in the code |

## 0.5 The three environments

| | Local | Test | Production |
| --- | --- | --- | --- |
| Runs on | Your computer | Railway, environment `test` | Railway, environment `production`, or your own server |
| Used by | You, while learning or changing code | You and your testers, before each release | Real businesses and their callers |
| Code | Any branch | `main`, deployed at every push ([4.10](part-4-test-environment.md#410-keep-the-test-environment-up-to-date)) | The `production` branch, which you move to a tested commit ([7.1](part-7-operations.md#71-release-a-new-version)) |
| Data | Throwaway | Test data only | Real data, copied every night ([5.2](part-5-production.md#52-production-on-railway), [5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose)) |
| Phone numbers | None, or a test number through a tunnel ([2.7](part-2-local-development.md#27-optional-extras)) | Test numbers | The businesses' own |
| Outside accounts | Your own keys | The test environment's own ([Part 3](part-3-outside-services.md)) | Production's own ([5.1](part-5-production.md#51-what-changes-from-the-test-environment)) |
| Running | Only while you run it | Always, or paused while nobody uses it ([4.10](part-4-test-environment.md#410-keep-the-test-environment-up-to-date)) | Always |

This guide's default is one Railway project with two environments, `test` and `production`, the way the original LobbyStack ran its own (`.railway/railway.ts`). Use a separate project when production needs different people from the test environment, or will belong to a client ([4.1](part-4-test-environment.md#41-how-the-railway-project-is-laid-out), [5.5](part-5-production.md#55-hand-an-instance-over-to-a-client)).

## 0.6 Words used in this guide

| Word | What it means here |
| --- | --- |
| Instance | One running LobbyStack, with its own address, database and accounts, serving any number of businesses |
| Environment | One complete set of the services and their data, such as `test` or `production` |
| Business | One company on the instance, with its own team, numbers, calls and data. Its team are its owners, admins, viewers and schedulers ([6.6](part-6-first-run.md#66-invite-the-team)) |
| Service | One of the programs that make up an instance, such as the admin or the database ([0.3](#03-how-lobbystack-fits-together)) |
| Provider | An outside company whose service LobbyStack uses, such as OpenAI or Twilio |
| Repository | The code and its history, kept on GitHub |
| Fork | Your own copy of a repository on GitHub, which you can bring up to date with the one it came from ([1.4](part-1-prepare.md#14-get-the-code)) |
| Branch | A named line of versions in a repository, such as `main` or `production` |
| Commit | One saved version of the code, named by an ID such as `d18f916` |
| Checks | The tests GitHub runs on each push to `main` and on each pull request. A green check mark means that they all passed ([1.4](part-1-prepare.md#14-get-the-code)) |
| Variable | A named setting that a service reads when it starts, such as `APP_BASE_URL=https://app.example.com`. [Appendix A](appendix-a-variables.md) lists them all |
| Secret | A variable that gives access, such as a password or a key. It belongs only in the password manager and in the service's settings ([1.2](part-1-prepare.md#12-your-worksheet-and-keeping-secrets-safe)) |
| Reference | On Railway, a value such as `${{admin.ENCRYPTION_KEY}}`, which Railway replaces with another service's variable, so the two always match |
| Build | Turning the code into the program a service runs. A value that's **built in** is fixed then, so only a new build changes it ([7.6](part-7-operations.md#76-change-a-setting-safely)) |
| Deploy | Starting a service on a new build, or with new settings |
| Image, container | A packaged program, such as `pgvector/pgvector:pg16`, and a running copy of it |
| Volume | A disk attached to a service, which keeps its data from one deploy to the next |
| Bucket | Storage for files, reached over the internet with keys of its own |
| Migration | A change to the database's tables, which migrate applies ([7.3](part-7-operations.md#73-database-migrations)) |
| Health check | An address that answers whether a service works, such as `/api/health/ready` ([7.10](part-7-operations.md#710-health-checks-and-uptime-monitoring)) |
| Webhook | An address at which a provider tells LobbyStack something, such as a new call or a text |
| SIP trunk | The link at Twilio that carries calls between the phone network and OpenAI ([3.3](part-3-outside-services.md#33-twilio)) |
| Tunnel | A temporary public address that reaches your own computer, for trying phone calls there ([2.7](part-2-local-development.md#27-optional-extras)) |
| DNS record | An entry at your domain's provider that points a name, such as `app.example.com`, at a service or a server ([3.1](part-3-outside-services.md#31-choose-your-addresses)) |
| Terminal | The window where you type commands: PowerShell on Windows, Terminal on a Mac |
| SSH | Signing in to a server's terminal from your own computer ([5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose)) |
| API key, platform key | Keys that let programs use the instance: an API key reaches one business, and a platform key can create businesses and reach all of them ([6.7](part-6-first-run.md#67-optional-the-api-and-the-command-line)) |

## 0.7 Time and money

**How long it takes**

Nobody has timed the parts yet. The longest waits are the providers' reviews, so start them early, in [Part 3](part-3-outside-services.md):

| What | How long | Needed for |
| --- | --- | --- |
| Twilio's business profile | One to three days ([3.3](part-3-outside-services.md#33-twilio), step 3) | Texting registration, and several of Twilio's later steps |
| US texting registration | Twilio says 10 to 15 days to review a campaign, which can start only once a number is bought ([3.3](part-3-outside-services.md#33-twilio), step 14) | Texts to US phones from local numbers |
| Polar's review of a live organization | Up to 14 days ([3.7](part-3-outside-services.md#37-optional-services)) | Only an instance that sells plans |
| A new domain's DNS records | Usually minutes, at most 72 hours ([3.1](part-3-outside-services.md#31-choose-your-addresses)) | Your own address |

Calls work as soon as a number is bought; only texts wait for the registration ([3.3](part-3-outside-services.md#33-twilio)).

**What it costs**

At the providers' list prices on 2026-10-18 and 2026-10-19:

| What | Costs | Details |
| --- | --- | --- |
| Railway, for both environments | The Pro plan: $20 a month, with $20 of usage included. A quiet environment was estimated at $8 to $20 of usage a month, but nobody has measured one | [4.1](part-4-test-environment.md#41-how-the-railway-project-is-laid-out) |
| Or production on your own server | About €11 a month at Hetzner in Europe, with its address and backups. The test environment stays on Railway | [5.3](part-5-production.md#53-alternative-production-on-your-own-server-with-docker-compose) |
| A domain | A yearly fee at the registrar | [3.1](part-3-outside-services.md#31-choose-your-addresses) |
| OpenAI | $0.05 a minute of call, so a 3-minute phone call costs about $0.15, plus the text model's tokens. The first purchase of credit is at least $5 | [3.2](part-3-outside-services.md#32-openai) |
| Twilio | $1.15 a month for each US or Canadian local number, test numbers included; $0.0034 a minute for incoming calls; $0.0083 per part of a text, plus the carriers' fees. US texting registration costs $4.50 to $46 once, $15 per campaign review, then $1.50 to $10 a month | [3.3](part-3-outside-services.md#33-twilio) |
| Email, with Resend | Free up to 3,000 emails a month, and 100 a day | [3.4](part-3-outside-services.md#34-email) |
| Production's backup copies at Cloudflare, on Railway | Free up to 10 GB | [5.2](part-5-production.md#52-production-on-railway) |
| Turnstile, Google Calendar and the map, an uptime check, and the free tiers of Firecrawl and PostHog | Free | [3.5](part-3-outside-services.md#35-cloudflare-turnstile), [3.7](part-3-outside-services.md#37-optional-services), [5.2](part-5-production.md#52-production-on-railway) |
| Polar, only if the instance sells plans | On its free Starter plan, 5% and $0.50 of each payment, plus 1.5% for a card from outside the US. Its paid plans take less of each payment | [3.7](part-3-outside-services.md#37-optional-services) |

**Where to set limits**

On an instance that doesn't sell plans, LobbyStack itself limits nothing a business uses ([7.13](part-7-operations.md#713-costs-and-usage-limits)). So set the providers' own limits:

- OpenAI: a hard monthly spending limit and alerts on each project ([3.2](part-3-outside-services.md#32-openai), steps 12 and 13).
- Railway: a usage alert, and no hard limit, because at the hard limit Railway takes every service offline ([4.2](part-4-test-environment.md#42-create-the-account-and-the-project), step 3; [5.2](part-5-production.md#52-production-on-railway), step 26).
- Twilio: automatic top-ups and a balance alert, because at a balance of $0, Twilio stops every new call and text ([7.13](part-7-operations.md#713-costs-and-usage-limits)).

Then compare the bills once a month ([7.25](part-7-operations.md#725-routine-maintenance-calendar)).
