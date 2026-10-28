# Read the project's history

LobbyStack began as one team's open-source AI receptionist. This repository forked it, and since 2026-10-11 the fork has gone its own way as AlloPlace. This page says what happened when, so that older documents and commits make sense. The [changelog](changelog.md) lists every fork pull request.

## The original project, March to October 2026

| Date | What happened | Pull request |
| --- | --- | --- |
| 2026-03-08 | The first commit: a minimum receptionist on Convex, with a web dashboard. | |
| 2026-03 to 2026-05 | The dashboard, and voice knowledge retrieval with OCR. The repository was public by May. | #10, #20, #50 |
| 2026-07-21 | Polar payments, with a grace period and billing states in the dashboard. | #120 |
| 2026-09-16 | The new platform shipped: a Next.js dashboard and API, a worker and PostgreSQL on Railway replaced Convex. Production moved the same day (below). | #136 |
| 2026-09-19 | A "Deploy on Railway" template button in the README and the original's self-hosting pages. | #150 |
| 2026-09-21 | Polar webhooks from before the move are routed to the new platform. | #168 |
| 2026-09-26 | Calls answered by OpenAI's GPT-Live, with one agent core for calls and chat; the separate voice gateway was removed. | #193, #201 |
| 2026-10-05 | Dead code and the last Convex tooling removed; Node 26 required. | #258 |
| 2026-10-07 | A Windows build fix and a retry when the worker's GPT-Live connection fails to open, both from work in this fork. | #260, #261 |
| 2026-10-08 | Releases gated on the replacement platform checks; server logs sent to PostHog. | #290 |
| 2026-10-09 | Bugs, access checks and dead code from a repository review; the business timezone picker, also from this fork. | #299, #295 |
| 2026-10-11 | The last commit the fork shares with the original: `380d9e0`. | #301 |

The pull request numbers in this table are the original project's, not the fork's.

### The move off Convex, 2026-09-16

The original's production moved from Convex to the new platform on Railway in one cutover. Writes to Convex were frozen, a final export was imported into PostgreSQL and checked row for row, and derived data such as business context snapshots was rebuilt. Then the dashboard's and the voice service's domains, Twilio's text webhook, Polar's webhook and Google's OAuth redirect were pointed at Railway.

Two problems surfaced the next day:

- The services held the credentials of a Twilio account that owned no phone numbers. Twilio signs its webhooks with the number owner's token, so every call and text failed its signature check until the right account's credentials were set.
- The import marked most accounts' email addresses as unverified, and with `REQUIRE_EMAIL_VERIFICATION=true` those people couldn't sign in. Migration `0053_legacy_email_verified_backfill.sql` fixed them.

The `legacy_convex_id` columns, the Polar webhook's `POLAR_ACCEPT_LEGACY_BUSINESS_IDS` switch and a few scripts still carry traces of Convex ([why the original moved](../../research/why-lobbystack-is-moving-away-from-convex.md)).

## The fork's first weeks

- **To 2026-10-06.** The fork's `main` carried the maintainer's own work on knowledge retrieval (RAG) and a Windows build fix. A comparison with the original found its retrieval changes already covered there, so nothing was ported, and `main` was reset to the original's history on 2026-10-06. The Windows fix went to the original as its #260.
- **2026-10-06.** A larger reliability change for calls was cut down to one piece, retrying the worker's GPT-Live connection when it fails before the session starts. The original took it as #261.
- **2026-10-09 to 2026-10-11.** Fork PR #2, the business timezone picker, reached the original as its #295. Fork PR #3, which tagged logs and errors with their call, was merged into the fork's `production` branch, but that branch was rewritten from outside the fork the same evening and deleted on 2026-10-11, with every branch but `main`. PR #3's work was done again as fork PR #41. If an old database ever ran #3, it keeps an unused `calls.twilio_call_sid` column and a migration row named `0079_call_twilio_sid.sql`. Both are harmless: migrations are tracked by file name, and #41's `0103_call_twilio_sid.sql` adds the column only if it isn't there.
- **2026-10-11 and 2026-10-12.** `main` was reset to the original at `380d9e0`, its #301. The fork's pull requests start again from #5.

## The fork on its own, from 2026-10-12

The [changelog](changelog.md) has every pull request. In short:

| Dates | Work | Fork pull requests |
| --- | --- | --- |
| 10-12 | Onboarding through the API and the `lobbystack` command; the website widget in the dashboard. Direct commits kept the original's production release job to the original's repository and taught GPT-Live that only the backend transfers calls. | #5 to #11 |
| 10-13 to 10-15 | Text replies to people who texted first, the caller keypad PIN, a local debugging guide, configurable name and logo, and the widget's live chat with the team. | #12 to #22 |
| 10-16 to 10-17 | Widget improvements, public profile pages, QR code signs, phone number errors explained, public profile and missing fields in the v1 API, and brands from `brands/`. | #23 to #40 |
| 10-18 to 10-20 | Logs tagged by call, 25 fixes from a code review, realtime recovery, Twilio prices, emails rewritten, the recorded greeting, database query safety, website call limits and time limit, AI debug traces, alert texts from the business's own number, and the version line. | #41 to #57 |
| 10-21 to 10-24 | Billing rebuilt in ten steps, then reviewed twice and fixed. | #58 to #75 |
| 10-24 | Docs brought up to date; this folder became the project's source of truth. | #76 and this change |

On 2026-10-18 the maintainer learned that the original's repository was no longer available. Since then pull requests go only into the fork, and the weekly check for new commits in the original is paused. On 2026-10-23 a copy of the original still fetched: it had moved 14 commits past `380d9e0`, and merging it would have conflicted in 286 files. On 2026-10-27 the original's repository was back online, 25 commits past `380d9e0`, and a trial merge conflicted in 326 files. Fork PR #90 then brought over its Node.js 26.12.1 images and its nodemailer and zod updates by hand, fork PR #91 its move to pnpm 12.15.0, and fork PR #93 the database fixes from its audit.
